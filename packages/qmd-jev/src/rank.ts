/**
 * rank — the Jev relevance gate. One request per query: the state carries
 * the query and every candidate chunk, and each hit gets one `noul`
 * question — "how much is this chunk about the query", answered 0.0..1.0.
 *
 * On the corpus this package is developed against, the gate is a safety
 * net, not a filter: every measured candidate scored >= 0.56, so at the
 * 0.3 threshold nothing is dropped today (README "Measured"). It exists for
 * the corpus or query where Jev does separate — it must not read as a
 * feature that currently fires.
 *
 * The gate judges MEMBERSHIP ONLY. Kept hits stay in qmd's fused order:
 * sorting by a within-query noul spread of 0.02–0.05 demoted the
 * known-right document in 7 of 10 measured queries and improved it in none.
 * Until a question shape produces a wider spread, the order is qmd's.
 *
 * Fail-open is the caller's move: `ask → null` makes rankHits return null
 * and runQuery answers in qmd's fused order instead. A hit whose answer is
 * missing, or came back as a non-`noul` type, is never dropped — no answer
 * is not evidence of irrelevance.
 */
import type { Ask, Json, Questions } from "./jev.js";
import type { JevHit } from "./present.js";

/**
 * Keep a hit whose relevance answer is >= 0.3.
 *
 * First calibrated 2026-09-20 against code-grep hits on jev-1.13.0
 * (irrelevant <= 0.21, on-path >= 0.38). Re-measured 2026-09-20 on this
 * repo's markdown corpus (kb collection, 460 files; 10 queries, 226
 * candidates, the exact `relevanceQuestions` sentence): every candidate
 * scored >= 0.56, so 0.3 drops nothing there — the safe direction, and the
 * reason the gate ships as a safety net rather than a filter. The sentence
 * and the threshold are one calibration; moving either alone un-anchors
 * the other. Re-measure with --explain (README).
 */
export const THRESHOLD = 0.3;

/**
 * Per-chunk cap on the text Jev sees. The vendor's state budget is 32K
 * tokens (~4 chars/token ≈ 128K chars). Worst case at the default
 * candidate limit: 40 hits × 1500-char chunks ≈ 60K chars, plus per-hit
 * file/title and per-question instructions ≈ 76K chars — accepted by the
 * vendor in measurement, inside the budget with headroom.
 * run-query.test.ts pins this with a worst-case state.
 */
export const MAX_CHUNK_CHARS = 1500;

const questionText = (query: string): string =>
	`The state holds a search query and document chunks, each under an id. ` +
	`Rate the chunk with your id: how much is it about the query "${query}"? ` +
	`Answer one number from 0.0 (unrelated to the query) to 1.0 (entirely about the query). ` +
	`Judge the chunk's content, not its file name alone.`;

/** The state sent to Jev: the query plus every candidate chunk, capped per hit. Nothing else leaves. */
export const rankState = (query: string, hits: JevHit[]): Json => ({
	query,
	chunks: Object.fromEntries(
		hits.map((h, i) => [
			String(i),
			{
				file: h.file,
				title: h.title,
				text: (h.chunk || h.snippet).slice(0, MAX_CHUNK_CHARS),
			},
		]),
	),
});

/** One `noul` question per hit, keyed by the index the state keys chunks by. */
export const relevanceQuestions = (query: string, hits: JevHit[]): Questions =>
	Object.fromEntries(
		hits.map((_, i) => [String(i), { type: "noul" as const, instructions: questionText(query) }]),
	);

export interface RankedHits {
	/**
	 * Every judged hit, in the order it arrived (qmd's fused order), each
	 * decorated with `noul` and the `kept` verdict — the --explain view and
	 * the slice-04 log's input.
	 */
	judged: JevHit[];
	/** The answer: the judged hits with `kept !== false`. Same order, no re-sort. */
	kept: JevHit[];
	/** Hits that got a usable `noul` answer. */
	scored: number;
	/** Hits dropped as off-topic — scored, and below the threshold. */
	dropped: number;
	/** The model version that answered, for the log (slice 04). */
	model: string;
}

/**
 * Judge one query's candidates. Exactly one Jev request, whatever the hit
 * count. `null` means Jev did not answer — the caller fails open.
 */
export const rankHits = async (ask: Ask, query: string, hits: JevHit[]): Promise<RankedHits | null> => {
	if (hits.length === 0) return { judged: [], kept: [], scored: 0, dropped: 0, model: "" };
	const result = await ask(rankState(query, hits), relevanceQuestions(query, hits));
	if (result === null) return null;
	let scored = 0;
	const judged = hits.map((hit, i) => {
		const a = result.answers[String(i)];
		if (a?.type !== "noul") return { ...hit, kept: true };
		scored += 1;
		return { ...hit, noul: a.noul, kept: a.noul >= THRESHOLD };
	});
	const kept = judged.filter((h) => h.kept !== false);
	return {
		judged,
		kept,
		scored,
		dropped: judged.length - kept.length,
		model: result.model,
	};
};
