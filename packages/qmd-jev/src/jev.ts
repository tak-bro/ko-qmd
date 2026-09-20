/**
 * jev client — the one place this package talks to the network. Ported
 * behaviour-for-behaviour from the pi-config reference client
 * (pi-config/home/extensions/jev/client.ts), with the directory allowlist
 * (`JEV_ROOTS`) swapped for qmd's collection allowlist (`QMD_JEV_COLLECTIONS`).
 *
 * Fail-open is the contract. No key, no listed collection, a timeout, an HTTP
 * error, an unparseable body → `null`, and the caller answers as qmd always
 * has. Three failures in a row switch the client off for the process;
 * `claimTripNotice` hands the one line that says so to whichever consumer
 * asks first. No key and no listed collection are not failures — neither is
 * the caller's own abort, nor a state that cannot be serialized (that one
 * never reached Jev).
 *
 * Key: `TYPESAFE_API_KEY`, else `~/.config/typesafe/key`. Read once per
 * process, put in the `Authorization` header and nowhere else — not in
 * doctor output, not in logs, not in error text.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { allowedCollections } from "./consent.js";
import type { Env } from "./consent.js";

/** Pinned, not `jev-latest`: every threshold is calibrated against a version, and an alias moves the calibration silently. A retired pin answers 400 `Unknown model`. */
export const MODEL = "jev-1.13.0";

export const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const STRIKES = 3;
const DEFAULT_TIMEOUT_MS = 2000;

export type Question =
	| { type: "noul"; instructions: string }
	| { type: "score"; instructions: string; criteria: string[] }
	| { type: "choice"; instructions: string; criteria: Record<string, string> };

export type Questions = Record<string, Question>;

/** `noul` answers carry no confidence; `score` is a level index (0..N-1), not a 0–1 value. */
export type JevAnswer =
	| { type: "noul"; noul: number }
	| { type: "score"; score: number; confidence: number }
	| { type: "choice"; choice: string; confidence: number };

export type Answers = Record<string, JevAnswer>;

export interface JevResult {
	answers: Answers;
	/** The version that actually answered — recorded so drift is visible. */
	model: string;
}

/** What a `state` may hold: it is serialized as-is, so nothing `JSON.stringify` would throw on. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface AskOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

export type Ask = (state: Json, questions: Questions, opts?: AskOptions) => Promise<JevResult | null>;

/** The one request this client makes — narrower than `RequestInit`, so a test can read it back untyped-cast-free. */
export interface JevRequest {
	method: "POST";
	headers: Record<string, string>;
	body: string;
	signal: AbortSignal;
}

export interface JevDeps {
	fetch: (url: string, init: JevRequest) => Promise<Response>;
	env: Env;
	readFile: (path: string) => string;
}

export interface JevClient {
	ask: Ask;
	/** Synchronous: key present, at least one collection listed, breaker closed. */
	ready: () => boolean;
	/** The trip notice, to the first caller after the breaker opens; `null` to everyone else. */
	claimTripNotice: () => string | null;
	/** The last failure as the notice may name it — an HTTP status or a category, never a message or header. */
	lastFailure: () => Failure | null;
}

/** What a failure may be named by: an HTTP status or a category. Never a message, header or body. */
export type Failure = number | "timeout" | "network" | "parse";

// `||`, not `??`: an empty HOME would turn `~/x` into `/x` and the key path into a relative one.
const home = (env: Env): string => env.HOME || homedir();

/** `TYPESAFE_API_KEY`, else `~/.config/typesafe/key`. An unreadable or blank source is no key. */
export const keyFrom = (env: Env, readFile: (path: string) => string): string | null => {
	const fromEnv = env.TYPESAFE_API_KEY?.trim();
	if (fromEnv) return fromEnv;
	try {
		return readFile(join(home(env), ".config", "typesafe", "key")).trim() || null;
	} catch {
		return null;
	}
};

/** `QMD_JEV_TIMEOUT_MS`, or 2000 when it is not a positive finite number. */
export const timeoutMsFrom = (env: Env): number => {
	const n = Number(env.QMD_JEV_TIMEOUT_MS);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
};

export const requestBody = (state: Json, questions: Questions): Json => ({ state, model: MODEL, questions });

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

const usable = (a: unknown): a is JevAnswer => {
	if (typeof a !== "object" || a === null) return false;
	const { type, noul, score, choice, confidence } = a as Record<string, unknown>;
	if (type === "noul") return finite(noul);
	if (type === "score") return finite(score) && finite(confidence);
	return type === "choice" && typeof choice === "string" && finite(confidence);
};

/**
 * The usable part of a 200. An answer whose numbers are not finite is dropped,
 * so consumers meet one "answer missing" path and fail open on it. No
 * `answers` object, or not one usable answer in it, is a failure (null):
 * every request carries a question, so an empty result means the response
 * shape moved — counted by the breaker instead of failing open forever.
 */
export const answersOf = (json: unknown): JevResult | null => {
	if (typeof json !== "object" || json === null) return null;
	const { answers, model } = json as { answers?: unknown; model?: unknown };
	if (typeof answers !== "object" || answers === null || Array.isArray(answers)) return null;
	const kept: Answers = {};
	// `__proto__` as an id would assign the accumulator's prototype instead of a key.
	for (const [id, a] of Object.entries(answers)) if (id !== "__proto__" && usable(a)) kept[id] = a;
	if (Object.keys(kept).length === 0) return null;
	return { answers: kept, model: typeof model === "string" ? model : "" };
};

/** A state `JSON.stringify` rejects (a cycle the `Json` type cannot rule out) is the caller's bug, not Jev's failure. */
const serialize = (state: Json, questions: Questions): string | null => {
	try {
		return JSON.stringify(requestBody(state, questions));
	} catch {
		return null;
	}
};

export const createJev = ({ fetch, env, readFile }: JevDeps): JevClient => {
	let key: string | null | undefined;
	let strikes = 0;
	let last: Failure | null = null;
	let noticeClaimed = false;

	const apiKey = (): string | null => (key === undefined ? (key = keyFrom(env, readFile)) : key);

	/** Synchronous: can a call reach the network at all. Unset consent means off, so no request is ever built. */
	const ready = (): boolean =>
		strikes < STRIKES && apiKey() !== null && allowedCollections(env).length > 0;

	const fail = (failure: Failure): null => {
		strikes += 1;
		last = failure;
		return null;
	};

	// Never throws: everything that can — `AbortSignal.timeout` on a bad number — is inside the try.
	const ask: Ask = async (state, questions, opts = {}) => {
		const { timeoutMs, signal } = opts;
		let deadline: AbortSignal | undefined;
		try {
			if (!ready()) return null;
			const body = serialize(state, questions);
			if (body === null) return null; // no strike: it never reached Jev
			const usableTimeout = timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0;
			deadline = AbortSignal.timeout(usableTimeout ? timeoutMs : timeoutMsFrom(env));
			const res = await fetch(ENDPOINT, {
				method: "POST",
				headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
				body,
				signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
			});
			if (!res.ok) return fail(res.status);
			const result = answersOf(await res.json().catch(() => null));
			if (!result) return fail("parse");
			strikes = 0;
			return result;
		} catch {
			if (signal?.aborted) return null; // the caller walked away — not Jev's failure
			return fail(deadline?.aborted ? "timeout" : "network");
		}
	};

	const claimTripNotice = (): string | null => {
		if (strikes < STRIKES || noticeClaimed) return null;
		noticeClaimed = true;
		return `jev: off for this session (${STRIKES} failures, last: ${last})`;
	};

	const lastFailure = (): Failure | null => last;

	return { ask, ready, claimTripNotice, lastFailure };
};

export type ProbeResult = { answered: true; model: string } | { answered: false; failure: Failure };

/**
 * One liveness request for `doctor`: an empty state and one question, so
 * nothing a collection contains leaves the machine — which is why the
 * collection allowlist does not gate it, only the key. Returns the model id
 * that answered, or the failure as a status or category. Never throws.
 */
export const probeModel = async (deps: JevDeps): Promise<ProbeResult | null> => {
	const key = keyFrom(deps.env, deps.readFile);
	if (key === null) return null;
	let deadline: AbortSignal | undefined;
	try {
		deadline = AbortSignal.timeout(timeoutMsFrom(deps.env));
		const res = await deps.fetch(ENDPOINT, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify(requestBody({}, { pin: { type: "noul", instructions: "Is this model version served?" } })),
			signal: deadline,
		});
		if (!res.ok) return { answered: false, failure: res.status };
		const result = answersOf(await res.json().catch(() => null));
		if (!result) return { answered: false, failure: "parse" };
		return { answered: true, model: result.model };
	} catch {
		return { answered: false, failure: deadline?.aborted ? "timeout" : "network" };
	}
};
