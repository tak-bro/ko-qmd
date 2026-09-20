/**
 * mcp — the query tool over `handleQuery`: result shape, the shared-breaker
 * concurrency guarantee, and the log. Transport-free; store and Jev client
 * are the same fakes the run-query tests use.
 */
import { describe, expect, it } from "bun:test";
import type { HybridQueryResult, SearchOptions } from "ko-qmd";
import { handleQuery, type QueryToolDeps, type QueryToolInput } from "../src/mcp.js";
import type { Ask, Answers, Failure, JevClient, Questions } from "../src/jev.js";
import type { RetrievalStore } from "../src/run-query.js";
import { EMPTY_NONE_FOUND } from "../src/present.js";

const hit = (file: string, score: number): HybridQueryResult => ({
	file: `qmd://notes/${file}`,
	displayPath: file,
	title: file,
	body: `body of ${file}`,
	bestChunk: `body of ${file}`,
	bestChunkPos: 0,
	score,
	context: null,
	docid: file.slice(0, 6),
});

const storeWith = (hits: HybridQueryResult[]): RetrievalStore => ({
	search: async (_options: SearchOptions) => hits,
});

/**
 * A Jev client whose breaker trips after `tripAfter` asks: `ready()` flips
 * false and the trip notice becomes claimable exactly once.
 */
const trippingJev = (tripAfter: number, answer: Answers = {}): { jev: JevClient; asks: { state: Questions; questions: Questions }[] } => {
	let asks = 0;
	let tripped = false;
	let noticeClaimed = false;
	const notice = "jev: 3 consecutive failures — switched off for this process (next success resets it)";
	const requests: { state: Questions; questions: Questions }[] = [];
	const ask: Ask = async (state, questions) => {
		requests.push({ state, questions });
		asks += 1;
		if (asks >= tripAfter) tripped = true;
		return tripped ? null : { answers: answer, model: "jev-test" };
	};
	return {
		jev: {
			ask,
			ready: () => !tripped,
			claimTripNotice: () => {
				if (!tripped || noticeClaimed) return null;
				noticeClaimed = true;
				return notice;
			},
			lastFailure: () => (tripped ? ("timeout" satisfies Failure) : null),
		},
		asks: requests,
	};
};

interface Harness {
	deps: QueryToolDeps;
	notifyLines: string[];
	logLines: string[];
}

const harness = (jev: JevClient, hits: HybridQueryResult[] = [hit("a.md", 1)]): Harness => {
	const notifyLines: string[] = [];
	const logLines: string[] = [];
	return {
		deps: {
			store: storeWith(hits),
			jev,
			allowed: ["notes"],
			log: (line: string) => logLines.push(line),
			notify: (line: string) => notifyLines.push(line),
		},
		notifyLines,
		logLines,
	};
};

const call = (deps: QueryToolDeps, input: Partial<QueryToolInput> = {}) =>
	handleQuery(deps, { query: "pool sizing", ...input });

describe("handleQuery — tool result shape", () => {
	it("text is the presented answer; structuredContent carries the hits and the gate stats", async () => {
		const h = harness(trippingJev(99, { "0": { type: "noul", noul: 0.9 } }).jev);
		const result = await call(h.deps);
		expect(result.content).toHaveLength(1);
		expect(result.content[0]!.type).toBe("text");
		expect(result.content[0]!.text).toMatch(/qmd:\/\/notes\/a\.md/);
		expect(result.structuredContent.hits).toHaveLength(1);
		expect(result.structuredContent.hits[0]).toMatchObject({ file: "qmd://notes/a.md", noul: 0.9, kept: true });
		expect(result.structuredContent.gate).toEqual({ scored: 1, dropped: 0, model: "jev-test" });
	});

	it("an empty retrieval says which empty it is — never a corpus claim", async () => {
		const h = harness(trippingJev(99).jev, []);
		const result = await call(h.deps);
		expect(result.structuredContent.hits).toEqual([]);
		expect(result.structuredContent.emptyReason).toBe("none-found");
		expect(result.content[0]!.text).toContain(EMPTY_NONE_FOUND);
	});

	it("explain: dropped hits appear in structuredContent with their noul and kept mark", async () => {
		const h = harness(
			trippingJev(99, { "0": { type: "noul", noul: 0.9 }, "1": { type: "noul", noul: 0.05 } }).jev,
			[hit("kept.md", 2), hit("junk.md", 1)],
		);
		const result = await call(h.deps, { explain: true });
		expect(result.structuredContent.hits).toEqual([
			expect.objectContaining({ file: "qmd://notes/kept.md", noul: 0.9, kept: true }),
			expect.objectContaining({ file: "qmd://notes/junk.md", noul: 0.05, kept: false }),
		]);
	});

	it("a Jev failure surfaces as a line and a field — and the answer still arrives", async () => {
		const h = harness(trippingJev(1).jev);
		const result = await call(h.deps);
		expect(result.structuredContent.jevFailure).toBe("timeout");
		expect(result.structuredContent.gate).toBeUndefined();
		expect(result.structuredContent.hits).toHaveLength(1);
		expect(h.notifyLines.join("\n")).toContain("jev: no answer (timeout)");
	});
});

describe("handleQuery — the shared breaker under concurrent calls", () => {
	it("two calls in flight when the breaker trips: both answer, neither throws, the notice prints once", async () => {
		const { jev } = trippingJev(1); // first ask already trips it
		const h = harness(jev);
		const [r1, r2] = await Promise.all([call(h.deps), call(h.deps)]);
		// both answered with qmd's fused order
		expect(r1.structuredContent.hits).toHaveLength(1);
		expect(r2.structuredContent.hits).toHaveLength(1);
		expect(r1.structuredContent.jevFailure).toBe("timeout");
		expect(r2.structuredContent.jevFailure).toBe("timeout");
		// exactly one claim: the notice line appears once across both calls' notify streams
		const notices = h.notifyLines.filter((l) => l.startsWith("jev: 3 consecutive"));
		expect(notices).toHaveLength(1);
	});

	it("the notice is claimed once per process, not once per call", async () => {
		const { jev } = trippingJev(1);
		const h = harness(jev);
		await call(h.deps);
		await call(h.deps);
		await call(h.deps);
		const notices = h.notifyLines.filter((l) => l.startsWith("jev: 3 consecutive"));
		expect(notices).toHaveLength(1);
	});
});

describe("handleQuery — the query log", () => {
	it("each call appends one line with model, route, and per-hit noul/kept", async () => {
		const h = harness(trippingJev(99, { "0": { type: "noul", noul: 0.8 } }).jev);
		await call(h.deps);
		expect(h.logLines).toHaveLength(1);
		const entry = JSON.parse(h.logLines[0]!);
		expect(entry).toMatchObject({
			query: "pool sizing",
			route: "jev",
			model: "jev-test",
			scored: 1,
			dropped: 0,
		});
		expect(entry.hits).toEqual([expect.objectContaining({ file: "qmd://notes/a.md", noul: 0.8, kept: true })]);
	});

	it("a null log sink logs nothing", async () => {
		const h = harness(trippingJev(99, { "0": { type: "noul", noul: 0.8 } }).jev);
		h.deps.log = null;
		const result = await call(h.deps);
		expect(result.structuredContent.hits).toHaveLength(1);
		expect(h.logLines).toHaveLength(0);
	});

	it("the key never appears in the log or the notify stream", async () => {
		process.env.TYPESAFE_API_KEY = "sk-key-never-logged";
		try {
			const h = harness(trippingJev(1).jev);
			await call(h.deps);
			expect(h.logLines.join("\n")).not.toContain("sk-key-never-logged");
			expect(h.notifyLines.join("\n")).not.toContain("sk-key-never-logged");
		} finally {
			delete process.env.TYPESAFE_API_KEY;
		}
	});
});
