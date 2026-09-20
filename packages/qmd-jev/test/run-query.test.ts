/**
 * runQuery — retrieval composition and the fail-open path, before Jev is
 * wired into it (slice 02: the fallback exists before the thing that falls
 * back). The store is a parameter, never constructed here, so these tests
 * need no index, no root build, and no network.
 */
import { describe, expect, it } from "bun:test";
import type { HybridQueryResult, SearchOptions } from "ko-qmd";
import { parseQueryArgs } from "../src/cli.js";
import { runQuery } from "../src/run-query.js";
import type { QueryOutcome, RetrievalStore } from "../src/run-query.js";
import { EMPTY_NONE_FOUND, EMPTY_NONE_KEPT, toJson, toText } from "../src/present.js";

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

	it("no Jev call is involved: the outcome says which order it is in, and it is fused", async () => {
		const { store } = fakeStore([hit("a.md", 1)]);
		const outcome = await runQuery(store, "q", {});
		expect(outcome.order).toBe("fused");
	});

	it("an empty retrieval is 'none found', not 'none kept'", async () => {
		const { store } = fakeStore([]);
		const outcome = await runQuery(store, "q", {});
		expect(outcome.hits).toHaveLength(0);
		expect(outcome.emptyReason).toBe("none-found");
	});
});

describe("present — one result shape for CLI and MCP", () => {
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
});

describe("parseQueryArgs", () => {
	it("takes a query, repeatable -c, --format json, -n", () => {
		expect(parseQueryArgs(["query", "hello world", "-c", "notes", "-c", "journals", "--format", "json", "-n", "3"])).toEqual({
			query: "hello world",
			collections: ["notes", "journals"],
			format: "json",
			limit: 3,
		});
	});

	it("defaults: cli format, no scoping, no limit", () => {
		expect(parseQueryArgs(["query", "q"])).toEqual({
			query: "q",
			collections: undefined,
			format: "cli",
			limit: undefined,
		});
	});

	it("rejects an unknown format, a missing query, and a bad limit", () => {
		expect(parseQueryArgs(["query", "q", "--format", "xml"])).toBeNull();
		expect(parseQueryArgs(["query"])).toBeNull();
		expect(parseQueryArgs(["query", "q", "-n", "x"])).toBeNull();
		expect(parseQueryArgs([])).toBeNull();
	});
});
