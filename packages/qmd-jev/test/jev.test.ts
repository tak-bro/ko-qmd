/**
 * jev client — the one place this package talks to the network. Ported
 * behaviour-for-behaviour from the pi-config jev client, with the directory
 * allowlist swapped for qmd's collection allowlist.
 *
 * Every test here runs offline: `fetch`, `env` and `readFile` are injected,
 * and the recording fetch counts what was built, not just what was sent.
 */
import { describe, expect, it } from "bun:test";
import { doctorLines } from "../src/cli.js";
import { answersOf, createJev, ENDPOINT, keyFrom, MODEL, probeModel } from "../src/jev.js";
import type { JevDeps, JevRequest } from "../src/jev.js";

/** A fetch that records every request it was handed, for counting and inspecting. */
const recordingFetch = (
	respond: (url: string, init: JevRequest) => Promise<Response> | Response,
): { fetch: JevDeps["fetch"]; calls: { url: string; init: JevRequest }[] } => {
	const calls: { url: string; init: JevRequest }[] = [];
	const fetch = (url: string, init: JevRequest) => {
		calls.push({ url, init });
		return Promise.resolve(respond(url, init));
	};
	return { fetch, calls };
};

const ok = (body: unknown): Response =>
	new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const status = (code: number, body: unknown = {}): Response =>
	new Response(JSON.stringify(body), { status: code });

const noulAnswer = { type: "noul", noul: 0.5 };
const answered = { answers: { q: noulAnswer }, model: MODEL };

const onEnv = { QMD_JEV_COLLECTIONS: "notes", TYPESAFE_API_KEY: "test-key" };
const noKeyFile = (): string => {
	throw new Error("no key file");
};

const depsWith = (
	fetch: JevDeps["fetch"],
	env: Record<string, string | undefined> = onEnv,
): JevDeps => ({ fetch, env, readFile: noKeyFile });

describe("createJev — off states build no request", () => {
	it("no key and no listed collection: zero requests, ready() false", async () => {
		const { fetch, calls } = recordingFetch(() => ok(answered));
		const jev = createJev({ fetch, env: {}, readFile: noKeyFile });
		expect(jev.ready()).toBe(false);
		expect(await jev.ask({}, {})).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it("collections listed but no key: zero requests", async () => {
		const { fetch, calls } = recordingFetch(() => ok(answered));
		const jev = createJev({ fetch, env: { QMD_JEV_COLLECTIONS: "notes" }, readFile: noKeyFile });
		expect(jev.ready()).toBe(false);
		expect(await jev.ask({}, {})).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it("QMD_JEV_COLLECTIONS unset: ready() is false even with a key — no request built, not merely not sent", async () => {
		const { fetch, calls } = recordingFetch(() => ok(answered));
		const jev = createJev({ fetch, env: { TYPESAFE_API_KEY: "test-key" }, readFile: noKeyFile });
		expect(jev.ready()).toBe(false);
		expect(await jev.ask({}, {})).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it("key and listed collection: ready() is true and one request goes out, signed and pinned", async () => {
		const { fetch, calls } = recordingFetch(() => ok(answered));
		const jev = createJev(depsWith(fetch));
		expect(jev.ready()).toBe(true);
		const result = await jev.ask({ chunk: "text" }, { q: { type: "noul", instructions: "relevant?" } });
		expect(calls).toHaveLength(1);
		const { url, init } = calls[0]!;
		expect(url).toBe(ENDPOINT);
		expect(init.method).toBe("POST");
		expect(init.headers.Authorization).toBe("Bearer test-key");
		expect(init.headers["Content-Type"]).toBe("application/json");
		const body = JSON.parse(init.body) as Record<string, unknown>;
		expect(body.model).toBe(MODEL);
		expect(body.state).toEqual({ chunk: "text" });
		expect(body.questions).toEqual({ q: { type: "noul", instructions: "relevant?" } });
		expect(result?.answers.q).toEqual(noulAnswer);
	});
});

describe("createJev — key precedence", () => {
	it("the env key beats the key file", () => {
		expect(keyFrom({ TYPESAFE_API_KEY: " env-key " }, () => "file-key")).toBe("env-key");
	});

	it("a blank env key falls back to the key file", () => {
		expect(keyFrom({ TYPESAFE_API_KEY: "   " }, () => " file-key ")).toBe("file-key");
	});

	it("an unreadable or blank key source is no key", () => {
		expect(keyFrom({}, noKeyFile)).toBeNull();
		expect(keyFrom({}, () => "   ")).toBeNull();
	});
});

describe("createJev — never throws, fails open", () => {
	it("a network error is null", async () => {
		const { fetch } = recordingFetch(() => {
			throw new Error("ECONNREFUSED");
		});
		const jev = createJev(depsWith(fetch));
		expect(await jev.ask({}, {})).toBeNull();
	});

	it("a timeout is null", async () => {
		const { fetch } = recordingFetch(
			(_url, init) =>
				new Promise<Response>((_, reject) => {
					init.signal.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		);
		const jev = createJev(depsWith(fetch));
		expect(await jev.ask({}, {}, { timeoutMs: 5 })).toBeNull();
	});

	it("a non-2xx is null", async () => {
		const { fetch } = recordingFetch(() => status(503));
		const jev = createJev(depsWith(fetch));
		expect(await jev.ask({}, {})).toBeNull();
	});

	it("an unparseable body is null", async () => {
		const { fetch } = recordingFetch(
			() => new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		const jev = createJev(depsWith(fetch));
		expect(await jev.ask({}, {})).toBeNull();
	});
});

describe("createJev — breaker", () => {
	it("three consecutive failures stop calls; the notice names a status, prints once", async () => {
		const { fetch, calls } = recordingFetch(() => status(500));
		const jev = createJev(depsWith(fetch));
		expect(await jev.ask({}, {})).toBeNull();
		expect(await jev.ask({}, {})).toBeNull();
		expect(await jev.ask({}, {})).toBeNull();
		expect(calls).toHaveLength(3);
		expect(await jev.ask({}, {})).toBeNull();
		expect(calls).toHaveLength(3); // the fourth was never built
		expect(jev.ready()).toBe(false);
		expect(jev.claimTripNotice()).toBe("jev: off for this session (3 failures, last: 500)");
		expect(jev.claimTripNotice()).toBeNull();
	});

	it("one success resets the strike count", async () => {
		const script: Response[] = [status(500), ok(answered), status(500), status(500), status(500)];
		const { fetch, calls } = recordingFetch(() => script.shift() ?? status(500));
		const jev = createJev(depsWith(fetch));
		await jev.ask({}, {}); // strike 1
		expect(await jev.ask({}, {})).not.toBeNull(); // reset
		await jev.ask({}, {}); // strike 1 again
		await jev.ask({}, {}); // strike 2
		expect(jev.claimTripNotice()).toBeNull(); // not tripped yet
		await jev.ask({}, {}); // strike 3 — trips
		expect(jev.claimTripNotice()).toBe("jev: off for this session (3 failures, last: 500)");
		expect(calls).toHaveLength(5);
	});

	it("a caller abort is not a strike", async () => {
		let rejectsWithAbort = false;
		const { fetch, calls } = recordingFetch(() => {
			if (rejectsWithAbort) throw new Error("caller aborted");
			return ok(answered);
		});
		const jev = createJev(depsWith(fetch));
		rejectsWithAbort = true;
		expect(await jev.ask({}, {}, { signal: AbortSignal.abort() })).toBeNull();
		rejectsWithAbort = false;
		expect(await jev.ask({}, {})).not.toBeNull(); // still on — no strike was counted
		expect(calls).toHaveLength(2);
		expect(jev.claimTripNotice()).toBeNull();
	});
});

describe("answersOf — what counts as an answer", () => {
	it("keeps finite answers and drops the rest", () => {
		const result = answersOf({
			answers: {
				good: { type: "noul", noul: 0.4 },
				badNumber: { type: "noul", noul: "high" },
				noType: { noul: 0.4 },
				score: { type: "score", score: 1, confidence: 0.9 },
			},
			model: MODEL,
		});
		expect(result?.answers.good).toEqual({ type: "noul", noul: 0.4 });
		expect(result?.answers.score).toEqual({ type: "score", score: 1, confidence: 0.9 });
		expect(result?.answers.badNumber).toBeUndefined();
		expect(result?.answers.noType).toBeUndefined();
	});

	it("a 200 without one usable answer is a failure, not silence", async () => {
		expect(answersOf({ answers: {}, model: MODEL })).toBeNull();
		expect(answersOf({ model: MODEL })).toBeNull();
		expect(answersOf(null)).toBeNull();
		const { fetch, calls } = recordingFetch(() => ok({ answers: { q: { type: "noul", noul: "x" } } }));
		const jev = createJev(depsWith(fetch));
		expect(await jev.ask({}, {})).toBeNull();
		expect(calls).toHaveLength(1); // it reached Jev and came back unusable — a strike, and visible
	});

	it("carries the answering model so a version change is visible", () => {
		expect(answersOf({ answers: { q: noulAnswer }, model: "jev-9.9.9" })?.model).toBe("jev-9.9.9");
	});
});

describe("probeModel — the doctor liveness check", () => {
	it("answers with the echoed model when the pin is live, sending an empty state", async () => {
		const { fetch, calls } = recordingFetch(() => ok(answered));
		const probe = await probeModel(depsWith(fetch));
		expect(probe).toEqual({ answered: true, model: MODEL });
		expect(calls).toHaveLength(1);
		const body = JSON.parse(calls[0]!.init.body) as { state: Record<string, unknown> };
		expect(body.state).toEqual({});
	});

	it("reports the HTTP status when the pin is retired", async () => {
		const { fetch } = recordingFetch(() =>
			status(400, { detail: { error_type: "api_usage_error", message: "Unknown model: jev-1.13.0" } }),
		);
		const probe = await probeModel(depsWith(fetch));
		expect(probe).toEqual({ answered: false, failure: 400 });
	});

	it("probes with no collections listed — an empty state describes no collection's content", async () => {
		const { fetch, calls } = recordingFetch(() => ok(answered));
		const probe = await probeModel({ fetch, env: { TYPESAFE_API_KEY: "test-key" }, readFile: noKeyFile });
		expect(probe).toEqual({ answered: true, model: MODEL });
		expect(calls).toHaveLength(1);
	});

	it("returns null with no key, building no request", async () => {
		const { fetch, calls } = recordingFetch(() => ok(answered));
		expect(await probeModel({ fetch, env: {}, readFile: noKeyFile })).toBeNull();
		expect(calls).toHaveLength(0);
	});
});

describe("doctor output", () => {
	it("prints 'jev: off' with no key and no collections, making zero requests", async () => {
		const { fetch, calls } = recordingFetch(() => ok(answered));
		const lines = await doctorLines({ fetch, env: {}, readFile: noKeyFile });
		expect(lines[0]).toBe("jev: off");
		expect(calls).toHaveLength(0);
	});

	it("never prints the key — in the on path, or in a failure the vendor echoes it back", async () => {
		const secret = "sk-never-print-me";
		const env = { QMD_JEV_COLLECTIONS: "notes", TYPESAFE_API_KEY: secret };
		const on = await doctorLines({ ...recordingFetch(() => ok(answered)), env, readFile: noKeyFile });
		expect(on.join("\n")).not.toContain(secret);
		const off = await doctorLines({
			...recordingFetch(() => status(401, { detail: { message: `bad key ${secret}` } })),
			env,
			readFile: noKeyFile,
		});
		expect(off.join("\n")).not.toContain(secret);
		expect(off.join("\n")).toContain("last: 401");
	});

	it("says whether the pinned model answers", async () => {
		const env = { TYPESAFE_API_KEY: "test-key" };
		const live = await doctorLines({ ...recordingFetch(() => ok(answered)), env, readFile: noKeyFile });
		expect(live.join("\n")).toMatch(/model jev-1\.13\.0: answers/);
		const retired = await doctorLines({
			...recordingFetch(() => status(400, { detail: { message: "Unknown model" } })),
			env,
			readFile: noKeyFile,
		});
		expect(retired.join("\n")).toMatch(/no answer \(last: 400\)/);
	});
});

describe("the pin", () => {
	it("is a version, not an alias", () => {
		expect(MODEL).toBe("jev-1.13.0");
	});
});
