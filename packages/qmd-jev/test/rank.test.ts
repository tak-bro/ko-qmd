/**
 * rank — the gate in isolation. The ask is a fake; nothing here constructs a
 * store, an index, or a network call.
 */
import { describe, expect, it } from "bun:test";
import { MAX_CHUNK_CHARS, THRESHOLD, rankHits, rankState, relevanceQuestions } from "../src/rank.js";
import type { Ask, Answers, JevAnswer, Json, Questions } from "../src/jev.js";
import type { JevHit } from "../src/present.js";

const jevHit = (file: string, chunk = `chunk of ${file}`): JevHit => ({
	docid: file.slice(0, 6),
	file: `qmd://notes/${file}`,
	title: file,
	score: 1,
	context: null,
	line: 1,
	snippet: `snippet of ${file}`,
	chunk,
});

const noul = (value: number): JevAnswer => ({ type: "noul", noul: value });

/** An ask that records every request and answers every id from a fixed map. */
const askThat = (
	answers: Answers,
	result: { model?: string } = {},
): { ask: Ask; calls: { state: Json; questions: Questions }[] } => {
	const calls: { state: Json; questions: Questions }[] = [];
	const ask: Ask = async (state, questions) => {
		calls.push({ state, questions });
		return { answers, model: result.model ?? "jev-test" };
	};
	return { ask, calls };
};

describe("relevanceQuestions / rankState — what one request carries", () => {
	it("asks one noul question per hit, keyed by the index the state keys chunks by", () => {
		const hits = [jevHit("a.md"), jevHit("b.md")];
		const questions = relevanceQuestions("pool sizing", hits);
		expect(Object.keys(questions)).toEqual(["0", "1"]);
		for (const q of Object.values(questions)) expect(q.type).toBe("noul");
	});

	it("the state is the query plus the capped chunk text — nothing else leaves", () => {
		const state = rankState("pool sizing", [jevHit("a.md", "x".repeat(MAX_CHUNK_CHARS + 500))]) as {
			query: string;
			chunks: Record<string, { file: string; title: string; text: string }>;
		};
		expect(state.query).toBe("pool sizing");
		expect(state.chunks["0"]!.text).toHaveLength(MAX_CHUNK_CHARS);
		expect(state.chunks["0"]!.file).toBe("qmd://notes/a.md");
		expect(Object.keys(state.chunks)).toEqual(["0"]);
	});

	it("40 worst-case hits stay inside the vendor's 32K state budget", () => {
		// 32K tokens ≈ 4 chars/token ≈ 128K chars of state.
		const hits = Array.from({ length: 40 }, (_, i) => jevHit(`doc-${i}.md`, "x".repeat(MAX_CHUNK_CHARS)));
		const state = rankState("connection pool sizing", hits);
		const questions = relevanceQuestions("connection pool sizing", hits);
		const sent = JSON.stringify({ ...state, model: "jev-1.13.0", questions });
		expect(sent.length).toBeLessThan(128_000);
	});
});

describe("rankHits — the gate judges membership only", () => {
	it("issues exactly one Jev request regardless of hit count", async () => {
		const hits = Array.from({ length: 40 }, (_, i) => jevHit(`doc-${i}.md`));
		const answers = Object.fromEntries(hits.map((_, i) => [String(i), noul(0.9)]));
		const { ask, calls } = askThat(answers);
		await rankHits(ask, "q", hits);
		expect(calls).toHaveLength(1);
	});

	it("drops the off-topic and keeps the rest in the fused order they arrived in — no re-sort", async () => {
		const hits = [jevHit("weak.md"), jevHit("best.md"), jevHit("edge.md"), jevHit("mid.md")];
		const { ask } = askThat({ "0": noul(0.1), "1": noul(0.9), "2": noul(THRESHOLD), "3": noul(0.5) });
		const ranked = await rankHits(ask, "q", hits);
		// noul order would be best, mid, edge — the fused order is asserted instead.
		expect(ranked!.kept.map((h) => h.file)).toEqual([
			"qmd://notes/best.md",
			"qmd://notes/edge.md",
			"qmd://notes/mid.md",
		]);
		expect(ranked!.dropped).toBe(1);
		expect(ranked!.scored).toBe(4);
	});

	it("decorates every judged hit with its noul and the kept mark — the --explain and log input", async () => {
		const hits = [jevHit("kept-high.md"), jevHit("dropped.md"), jevHit("unanswered.md")];
		const { ask } = askThat({
			"0": noul(0.9),
			"1": noul(0.05),
			// id 2: no answer
		});
		const ranked = await rankHits(ask, "q", hits);
		expect(ranked!.judged.map((h) => ({ file: h.file, noul: h.noul, kept: h.kept }))).toEqual([
			{ file: "qmd://notes/kept-high.md", noul: 0.9, kept: true },
			{ file: "qmd://notes/dropped.md", noul: 0.05, kept: false },
			{ file: "qmd://notes/unanswered.md", noul: undefined, kept: true },
		]);
	});

	it("a missing or non-noul answer keeps that hit, in its fused position", async () => {
		const hits = [jevHit("scored.md"), jevHit("choice-typed.md"), jevHit("unanswered.md")];
		const { ask } = askThat({
			"0": noul(0.4),
			"1": { type: "choice", choice: "yes", confidence: 0.9 },
			// id 2: no answer at all
		});
		const ranked = await rankHits(ask, "q", hits);
		expect(ranked!.kept.map((h) => h.file)).toEqual([
			"qmd://notes/scored.md",
			"qmd://notes/choice-typed.md",
			"qmd://notes/unanswered.md",
		]);
		expect(ranked!.dropped).toBe(0);
	});

	it("every scored hit below the threshold drops out — kept is empty, nobody is invented", async () => {
		const hits = [jevHit("a.md"), jevHit("b.md")];
		const { ask } = askThat({ "0": noul(0.21), "1": noul(0.05) });
		const ranked = await rankHits(ask, "q", hits);
		expect(ranked!.kept).toEqual([]);
		expect(ranked!.judged).toHaveLength(2);
		expect(ranked!.dropped).toBe(2);
	});

	it("ask → null means no ranking happened; failing open is the caller's move", async () => {
		const ask: Ask = async () => null;
		expect(await rankHits(ask, "q", [jevHit("a.md")])).toBeNull();
	});

	it("zero candidates never reach Jev", async () => {
		const { ask, calls } = askThat({});
		const ranked = await rankHits(ask, "q", []);
		expect(ranked!.kept).toEqual([]);
		expect(calls).toHaveLength(0);
	});

	it("records the model version that answered, for the log", async () => {
		const { ask } = askThat({ "0": noul(0.9) }, { model: "jev-1.13.0" });
		expect((await rankHits(ask, "q", [jevHit("a.md")]))!.model).toBe("jev-1.13.0");
	});
});
