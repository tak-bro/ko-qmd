/**
 * runQuery — retrieval composition and the fail-open path, with the Jev
 * gate wired in (slice 03). The store and the Jev client are parameters,
 * never constructed here, so these tests need no index, no root build, and
 * no network.
 */
import { describe, expect, it } from "bun:test";
import type { HybridQueryResult, SearchOptions } from "ko-qmd";
import { parseQueryArgs } from "../src/cli.js";
import { CANDIDATE_LIMIT, runQuery } from "../src/run-query.js";
import type { JevHit, QueryOutcome, RetrievalStore } from "../src/run-query.js";
import type { Ask, Answers, JevClient, Json, Questions } from "../src/jev.js";
import { EMPTY_NONE_FOUND, EMPTY_NONE_KEPT, toText, toJson } from "../src/present.js";

/** A store that records the options it was searched with and replays fixed hits in fused order. */
const fakeStore = (hits: HybridQueryResult[]): { store: RetrievalStore; calls: SearchOptions[] } => {
	const calls: SearchOptions[] = [];
	const store: RetrievalStore = {
		search: async (options) => {
			calls.push(options);
			return hits;
		},
	};
	return { store, calls };
};

const hit = (file: string, score: number): HybridQueryResult => ({
	file: `qmd://notes/${file}`,
	displayPath: file,
	title: file,
	body: `body of ${file}\nsecond line`,
	bestChunk: `body of ${file}`,
	bestChunkPos: 0,
	score,
	context: null,
	docid: file.slice(0, 6),
});

const hitIn = (collection: string, file: string, score: number): HybridQueryResult => ({
	...hit(file, score),
	file: `qmd://${collection}/${file}`,
});

/** A Jev client with fixed answers; records every request it is asked to build. */
const fakeJev = (
	answers: Answers | null,
	{ ready = true, lastFailure = null as JevClient["lastFailure"] }: { ready?: boolean; lastFailure?: JevClient["lastFailure"] } = {},
): { jev: JevClient; requests: { state: Json; questions: Questions }[] } => {
	const requests: { state: Json; questions: Questions }[] = [];
	const ask: Ask = async (state, questions) => {
		requests.push({ state, questions });
		if (answers === null) return null;
		return { answers, model: "jev-test" };
	};
	return { jev: { ask, ready: () => ready, claimTripNotice: () => null, lastFailure: () => lastFailure }, requests };
};

describe("runQuery — retrieval composition", () => {
	it("searches with the in-package sub-queries, rerank off, fused candidates", async () => {
		const { store, calls } = fakeStore([]);
		await runQuery(store, "connection pool", {});
		expect(calls).toHaveLength(1);
		const options = calls[0]!;
		expect(options.queries).toEqual([
			{ type: "lex", query: "connection pool" },
			{ type: "vec", query: "connection pool" },
		]);
		expect(options.rerank).toBe(false);
		expect(options.minScore).toBe(0);
	});

	it("passes collection scoping and the limit through, with qmd's defaults when absent", async () => {
		const scoped = fakeStore([]);
		await runQuery(scoped.store, "q", { collections: ["notes"] });
		expect(scoped.calls[0]!.collections).toEqual(["notes"]);
		expect(scoped.calls[0]!.limit).toBe(10);
		const limited = fakeStore([]);
		await runQuery(limited.store, "q", { limit: 3 });
		expect(limited.calls[0]!.limit).toBe(3);
		expect(limited.calls[0]!.collections).toBeUndefined();
	});
});

describe("runQuery — --expand opts back into qmd's own expansion", () => {
	it("default: the in-package sub-queries, no expansion model in the path", async () => {
		const { store, calls } = fakeStore([]);
		await runQuery(store, "connection pool", {});
		expect(calls[0]!.queries).toBeDefined();
		expect(calls[0]!.query).toBeUndefined();
	});

	it("--expand: the raw query string, rerank still off", async () => {
		const { store, calls } = fakeStore([]);
		await runQuery(store, "connection pool", { expand: true });
		expect(calls[0]!.query).toBe("connection pool");
		expect(calls[0]!.queries).toBeUndefined();
		expect(calls[0]!.rerank).toBe(false);
	});
});

describe("runQuery — the fail-open path is qmd's own fused order", () => {
	it("returns the store's rows in exactly the order and score the fusion produced", async () => {
		// Deliberately not monotonic: if anything re-sorted by score, this order would break.
		const fused = [hit("z-last.md", 9.5), hit("a-first.md", 3.1), hit("m-mid.md", 4.2)];
		const { store } = fakeStore(fused);
		const outcome = await runQuery(store, "q", {});
		expect(outcome.hits.map((h) => h.file)).toEqual([
			"qmd://notes/z-last.md",
			"qmd://notes/a-first.md",
			"qmd://notes/m-mid.md",
		]);
		expect(outcome.hits.map((h) => h.score)).toEqual([9.5, 3.1, 4.2]);
	});

	it("carries docid, line and a snippet per hit — the fields an MCP client already reads", async () => {
		const { store } = fakeStore([hit("only.md", 1)]);
		const outcome = await runQuery(store, "body of only", {});
		const row = outcome.hits[0]!;
		expect(row.docid).toBe("only.m");
		expect(row.file).toBe("qmd://notes/only.md");
		expect(row.line).toBeGreaterThan(0);
		expect(row.snippet).toContain("body of only.md");
	});

	it("no Jev call is involved: no gate stats on the outcome", async () => {
		const { store } = fakeStore([hit("a.md", 1)]);
		const outcome = await runQuery(store, "q", {});
		expect(outcome.gate).toBeUndefined();
	});

	it("an empty retrieval is 'none found', not 'none kept'", async () => {
		const { store } = fakeStore([]);
		const outcome = await runQuery(store, "q", {});
		expect(outcome.hits).toHaveLength(0);
		expect(outcome.emptyReason).toBe("none-found");
	});
});

describe("runQuery — the Jev gate", () => {
	const keepAll = (rows: HybridQueryResult[]): Answers =>
		Object.fromEntries(rows.map((_, i) => [String(i), { type: "noul", noul: 0.9 }]));

	it("gates by Jev: the off-topic are gone and the kept stay in qmd's fused order", async () => {
		const rows = [hit("z.md", 9.5), hit("a.md", 3.1), hit("m.md", 4.2), hit("junk.md", 8.0)];
		const { store } = fakeStore(rows);
		const { jev } = fakeJev({
			// Fused order was z,a,m,junk; Jev drops junk and z, keeps a and m in place.
			"0": { type: "noul", noul: 0.1 },
			"1": { type: "noul", noul: 0.95 },
			"2": { type: "noul", noul: 0.7 },
			"3": { type: "noul", noul: 0.2 },
		});
		const outcome = await runQuery(store, "q", { jev, allowed: ["notes"] });
		expect(outcome.hits.map((h) => h.file)).toEqual(["qmd://notes/a.md", "qmd://notes/m.md"]);
		expect(outcome.gate).toEqual({ scored: 4, dropped: 2, model: "jev-test" });
		expect(outcome.jevFailure).toBeUndefined();
	});

	it("the gate agreeing with everything changes nothing: the fused rows, plus the gate stats", async () => {
		const rows = [hit("z.md", 9.5), hit("a.md", 3.1)];
		const { store } = fakeStore(rows);
		const { jev } = fakeJev(keepAll(rows));
		const outcome = await runQuery(store, "q", { jev, allowed: ["notes"] });
		expect(outcome.hits.map((h) => h.score)).toEqual([9.5, 3.1]);
		expect(outcome.gate).toEqual({ scored: 2, dropped: 0, model: "jev-test" });
	});

	it("carries `judged` — every hit, kept and dropped, in fused order — even when only kept ones are shown", async () => {
		const rows = [hit("z.md", 9.5), hit("a.md", 3.1), hit("junk.md", 8.0)];
		const { store } = fakeStore(rows);
		const { jev } = fakeJev({
			"0": { type: "noul", noul: 0.1 },
			"1": { type: "noul", noul: 0.9 },
			"2": { type: "noul", noul: 0.2 },
		});
		const outcome = await runQuery(store, "q", { jev, allowed: ["notes"] });
		expect(outcome.hits.map((h) => h.file)).toEqual(["qmd://notes/a.md"]);
		expect(outcome.judged!.map((h) => ({ file: h.file, noul: h.noul, kept: h.kept }))).toEqual([
			{ file: "qmd://notes/z.md", noul: 0.1, kept: false },
			{ file: "qmd://notes/a.md", noul: 0.9, kept: true },
			{ file: "qmd://notes/junk.md", noul: 0.2, kept: false },
		]);
	});

	it("a plain outcome has no judged — the gate never ran", async () => {
		const { store } = fakeStore([hit("a.md", 1)]);
		const outcome = await runQuery(store, "q", {});
		expect(outcome.judged).toBeUndefined();
	});

	it("retrieves the candidate slice, not the user's limit, and caps the answer to the limit", async () => {
		const rows = Array.from({ length: CANDIDATE_LIMIT }, (_, i) => hit(`d${i}.md`, 1));
		const { store, calls } = fakeStore(rows);
		const { jev } = fakeJev(keepAll(rows));
		const outcome = await runQuery(store, "q", { jev, allowed: ["notes"], limit: 10 });
		expect(calls[0]!.limit).toBe(CANDIDATE_LIMIT);
		expect(outcome.hits).toHaveLength(10);
	});

	it("ask → null: slice 02's answer — the fused rows, capped — plus the failure as status or category", async () => {
		const rows = [hit("z-last.md", 9.5), hit("a-first.md", 3.1)];
		const { store } = fakeStore(rows);
		const { jev } = fakeJev(null, { lastFailure: "timeout" });
		const outcome = await runQuery(store, "q", { jev, allowed: ["notes"] });
		expect(outcome.hits.map((h) => h.file)).toEqual(["qmd://notes/z-last.md", "qmd://notes/a-first.md"]);
		expect(outcome.jevFailure).toBe("timeout");
		expect(outcome.gate).toBeUndefined();
	});

	it("a query spanning a listed and an unlisted collection sends only the listed one's hits", async () => {
		const rows = [hitIn("notes", "kept.md", 2), hitIn("secret", "withheld.md", 9), hitIn("notes", "kept2.md", 1)];
		const { store } = fakeStore(rows);
		const { jev, requests } = fakeJev({
			// ids follow the listed slice only: 0=kept.md, 1=kept2.md
			"0": { type: "noul", noul: 0.8 },
			"1": { type: "noul", noul: 0.6 },
		});
		const outcome = await runQuery(store, "q", { jev, allowed: ["notes"] });
		const state = requests[0]!.state as { chunks: Record<string, { file: string }> };
		expect(Object.values(state.chunks).map((c) => c.file)).toEqual([
			"qmd://notes/kept.md",
			"qmd://notes/kept2.md",
		]);
		expect(outcome.hits.map((h) => h.file)).not.toContain("qmd://secret/withheld.md");
		expect(outcome.gate).toEqual({ scored: 2, dropped: 0, model: "jev-test" });
	});

	it("nothing consented (no allowlist) = no request built and slice 02's answer", async () => {
		const rows = [hit("a.md", 1)];
		const { store, calls } = fakeStore(rows);
		const { jev, requests } = fakeJev(keepAll(rows));
		const outcome = await runQuery(store, "q", { jev });
		expect(requests).toHaveLength(0);
		expect(outcome.gate).toBeUndefined();
		expect(outcome.hits.map((h) => h.file)).toEqual(["qmd://notes/a.md"]);
		expect(calls[0]!.limit).toBe(10);
	});

	it("client not ready (no key, allowlist off, breaker open) = no request built", async () => {
		const { store } = fakeStore([hit("a.md", 1)]);
		const { jev, requests } = fakeJev({}, { ready: false });
		const outcome = await runQuery(store, "q", { jev, allowed: ["notes"] });
		expect(requests).toHaveLength(0);
		expect(outcome.gate).toBeUndefined();
	});

	it("an empty retrieval is none-found before Jev is ever asked", async () => {
		const { store } = fakeStore([]);
		const { jev, requests } = fakeJev({});
		const outcome = await runQuery(store, "q", { jev, allowed: ["notes"] });
		expect(requests).toHaveLength(0);
		expect(outcome.emptyReason).toBe("none-found");
		expect(outcome.gate).toBeUndefined();
	});

	it("every hit judged off-topic: the honest empty — none-kept, json [], never a corpus claim", async () => {
		const rows = [hit("a.md", 2), hit("b.md", 1)];
		const { store } = fakeStore(rows);
		const { jev } = fakeJev({ "0": { type: "noul", noul: 0.1 }, "1": { type: "noul", noul: 0.05 } });
		const outcome = await runQuery(store, "q", { jev, allowed: ["notes"] });
		expect(outcome.hits).toEqual([]);
		expect(outcome.emptyReason).toBe("none-kept");
		expect(toText(outcome)).toContain(EMPTY_NONE_KEPT);
		expect(toJson(outcome)).toEqual([]);
	});

	it("--explain: every judged hit, kept or dropped, with noul and verdict, in fused order", async () => {
		const rows = [hit("z.md", 9.5), hit("a.md", 3.1), hit("m.md", 4.2)];
		const { store } = fakeStore(rows);
		const { jev } = fakeJev({
			"0": { type: "noul", noul: 0.1 },
			"1": { type: "noul", noul: 0.9 },
			// m: unanswered → kept
		});
		const outcome = await runQuery(store, "q", { jev, allowed: ["notes"], explain: true });
		expect(outcome.hits.map((h) => ({ file: h.file, noul: h.noul, kept: h.kept }))).toEqual([
			{ file: "qmd://notes/z.md", noul: 0.1, kept: false },
			{ file: "qmd://notes/a.md", noul: 0.9, kept: true },
			{ file: "qmd://notes/m.md", noul: undefined, kept: true },
		]);
		// all dropped-but-explained: the rows are the point, not the empty sentence
		expect(outcome.emptyReason).toBeUndefined();
	});

	it("a partial answer set keeps the unscored hits in their fused positions", async () => {
		const rows = [hit("z.md", 9.5), hit("a.md", 3.1), hit("m.md", 4.2)];
		const { store } = fakeStore(rows);
		const { jev } = fakeJev({
			// only z scored (kept); a below threshold (dropped); m unanswered (kept, fused position)
			"0": { type: "noul", noul: 0.9 },
			"1": { type: "noul", noul: 0.1 },
		});
		const outcome = await runQuery(store, "q", { jev, allowed: ["notes"] });
		expect(outcome.hits.map((h) => h.file)).toEqual(["qmd://notes/z.md", "qmd://notes/m.md"]);
	});

	it("carries the best chunk, capped, for the Jev state — display still renders the snippet", async () => {
		const { store } = fakeStore([{ ...hit("a.md", 1), bestChunk: "c".repeat(2000) }]);
		const outcome = await runQuery(store, "q", {});
		const row: JevHit = outcome.hits[0]!;
		expect(row.chunk).toHaveLength(1500);
		expect(row.snippet).toContain("body of a.md");
	});
});

describe("present — one result shape for CLI and MCP", () => {
	/** A display-shaped row, as toJevHit builds it — not a store row. */
	const jevRow = (file: string): JevHit => ({
		docid: file.slice(0, 6),
		file: `qmd://notes/${file}`,
		title: file,
		score: 2,
		context: null,
		line: 1,
		snippet: `body of ${file}`,
		chunk: `body of ${file}`,
	});

	const outcomeOf = async (hits: HybridQueryResult[]): Promise<QueryOutcome> => {
		const { store } = fakeStore(hits);
		return runQuery(store, "q", {});
	};

	it("json is the hit array itself — every hit kept, in order, with the fields clients read", async () => {
		const json = toJson(await outcomeOf([hit("a.md", 2), hit("b.md", 1)]));
		expect(json).toHaveLength(2);
		expect(json[0]).toMatchObject({ file: "qmd://notes/a.md", score: 2 });
	});

	it("empty output never implies the corpus lacks the topic — either empty, or json is []", async () => {
		const noneFound = toText(await outcomeOf([]));
		expect(noneFound).toContain(EMPTY_NONE_FOUND);
		const noneKept = toText({ hits: [], emptyReason: "none-kept" });
		expect(noneKept).toContain(EMPTY_NONE_KEPT);
		expect(noneKept).toContain("searched");
		expect(noneKept).toContain("judged");
		expect(toJson({ hits: [], emptyReason: "none-kept" })).toEqual([]);
	});

	it("text form is one line per hit: score, file, snippet", async () => {
		const text = toText(await outcomeOf([hit("a.md", 2.5)]));
		expect(text).toMatch(/2\.5.*qmd:\/\/notes\/a\.md/s);
		expect(text).toContain("body of a.md");
	});

	it("explain text marks kept and dropped with the noul, under a gate header", () => {
		const text = toText(
			{
				hits: [
					{ ...jevRow("a.md"), noul: 0.9, kept: true },
					{ ...jevRow("b.md"), noul: 0.1, kept: false },
				],
				gate: { scored: 2, dropped: 1, model: "jev-1.13.0" },
			},
			true,
		);
		expect(text).toContain("jev jev-1.13.0: 2 scored, 1 dropped at threshold 0.3");
		expect(text).toMatch(/0\.90\s+kept\s+qmd:\/\/notes\/a\.md/);
		expect(text).toMatch(/0\.10\s+dropped\s+qmd:\/\/notes\/b\.md/);
	});

	it("explain leaves an unanswered hit's noul blank and marks it kept", () => {
		const text = toText(
			{ hits: [{ ...jevRow("m.md"), kept: true }], gate: { scored: 0, dropped: 0, model: "jev-1.13.0" } },
			true,
		);
		expect(text).toMatch(/—\s+kept\s+qmd:\/\/notes\/m\.md/);
	});
});

describe("runQuery — retrieval route (--route jev)", () => {
	it("a lex choice searches lex only — and skips local expansion even with --expand", async () => {
		const { store, calls } = fakeStore([]);
		const { jev, requests } = fakeJev({ route: { type: "choice", choice: "lex", confidence: 0.9 } });
		await runQuery(store, "connection pool", { jev, allowed: ["notes"], route: "jev", expand: true });
		expect(calls[0]!.queries).toEqual([{ type: "lex", query: "connection pool" }]);
		expect(calls[0]!.query).toBeUndefined(); // expansion skipped
		expect(requests[0]!.state).toEqual({ query: "connection pool" }); // the route ask carried the query alone
	});

	it("a vec choice searches vec only", async () => {
		const { store, calls } = fakeStore([]);
		const { jev } = fakeJev({ route: { type: "choice", choice: "vec", confidence: 0.9 } });
		await runQuery(store, "q", { jev, allowed: ["notes"], route: "jev" });
		expect(calls[0]!.queries).toEqual([{ type: "vec", query: "q" }]);
	});

	it("a full choice keeps today's composition — and expansion when asked for", async () => {
		const plain = fakeStore([]);
		const { jev: j1 } = fakeJev({ route: { type: "choice", choice: "full", confidence: 0.9 } });
		await runQuery(plain.store, "q", { jev: j1, allowed: ["notes"], route: "jev" });
		expect(plain.calls[0]!.queries).toEqual([
			{ type: "lex", query: "q" },
			{ type: "vec", query: "q" },
		]);
		const expanded = fakeStore([]);
		const { jev: j2 } = fakeJev({ route: { type: "choice", choice: "full", confidence: 0.9 } });
		await runQuery(expanded.store, "q", { jev: j2, allowed: ["notes"], route: "jev", expand: true });
		expect(expanded.calls[0]!.query).toBe("q");
	});

	it("silence falls back to full — the answer still ships", async () => {
		const { store, calls } = fakeStore([]);
		const { jev } = fakeJev(null);
		const outcome = await runQuery(store, "q", { jev, allowed: ["notes"], route: "jev" });
		expect(calls[0]!.queries).toHaveLength(2);
		expect(outcome.retrieval).toBe("full");
	});

	it("records the chosen route on the outcome; no route option, no field", async () => {
		const routed = fakeStore([]);
		const { jev: j1 } = fakeJev({ route: { type: "choice", choice: "lex", confidence: 0.9 } });
		const outcome = await runQuery(routed.store, "q", { jev: j1, allowed: ["notes"], route: "jev" });
		expect(outcome.retrieval).toBe("lex");

		const unrouted = fakeStore([]);
		const plain = await runQuery(unrouted.store, "q", {});
		expect(plain.retrieval).toBeUndefined();
	});

	it("route jev without a ready client: no route ask, full composition", async () => {
		const { store, calls } = fakeStore([]);
		const { jev, requests } = fakeJev({ route: { type: "choice", choice: "lex", confidence: 0.9 } }, { ready: false });
		await runQuery(store, "q", { jev, allowed: ["notes"], route: "jev" });
		expect(requests).toHaveLength(0);
		expect(calls[0]!.queries).toHaveLength(2);
	});
});

describe("parseQueryArgs", () => {
	it("takes a query, repeatable -c, --format json, -n", () => {
		expect(parseQueryArgs(["query", "hello world", "-c", "notes", "-c", "journals", "--format", "json", "-n", "3"])).toEqual({
			query: "hello world",
			collections: ["notes", "journals"],
			format: "json",
			limit: 3,
			expand: false,
			explain: false,
			route: "full",
		});
	});

	it("defaults: cli format, no scoping, no limit", () => {
		expect(parseQueryArgs(["query", "q"])).toEqual({
			query: "q",
			collections: undefined,
			format: "cli",
			limit: undefined,
			expand: false,
			explain: false,
			route: "full",
		});
	});

	it("takes --expand and --explain", () => {
		expect(parseQueryArgs(["query", "q", "--expand", "--explain"])).toEqual({
			query: "q",
			collections: undefined,
			format: "cli",
			limit: undefined,
			expand: true,
			explain: true,
			route: "full",
		});
	});

	it("takes --route jev (and an explicit --route full), and rejects anything else", () => {
		expect(parseQueryArgs(["query", "q", "--route", "jev"])!.route).toBe("jev");
		expect(parseQueryArgs(["query", "q", "--route", "full"])!.route).toBe("full");
		expect(parseQueryArgs(["query", "q", "--route", "hybrid"])).toBeNull();
		expect(parseQueryArgs(["query", "q", "--route"])).toBeNull();
	});

	it("rejects an unknown format, a missing query, and a bad limit", () => {
		expect(parseQueryArgs(["query", "q", "--format", "xml"])).toBeNull();
		expect(parseQueryArgs(["query"])).toBeNull();
		expect(parseQueryArgs(["query", "q", "-n", "x"])).toBeNull();
		expect(parseQueryArgs([])).toBeNull();
	});
});
