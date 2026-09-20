/**
 * present — the one place the result shape and the empty-result copy live.
 * CLI and MCP both render through here so the copy cannot fork.
 *
 * Two empties are distinct and stay distinct: nothing found by retrieval
 * (nothing matched the index) and nothing kept by the relevance gate
 * (everything matched, nothing was about the query). Neither may imply the
 * corpus lacks the topic — a top-N semantic index is not exhaustive, and
 * saying "no documents about X exist" is a claim the tool cannot make.
 */
import { THRESHOLD } from "./rank.js";
import type { QueryOutcome } from "./run-query.js";

export type EmptyReason = "none-found" | "none-kept";

export const EMPTY_NONE_FOUND =
	"No results. The index was searched — a top-N semantic index is not exhaustive; try different wording or a lex-style keyword query.";

export const EMPTY_NONE_KEPT =
	"No results kept: the index was searched and judged, and nothing scored as about the query. This is a judgement about these hits, not about the corpus.";

/** The hit row an MCP client already reads (file, score, line), the best chunk, and the gate's marks. */
export interface JevHit {
	docid: string;
	file: string;
	title: string;
	score: number;
	context: string | null;
	/** Absolute 1-indexed line of the best match in the source document. */
	line: number;
	snippet: string;
	/** The best chunk, capped for the Jev state (rank.ts) — display still renders `snippet`. */
	chunk: string;
	/** The hit's relevance answer (0.0..1.0). Set on judged hits (`--explain`, the query log). */
	noul?: number;
	/** The gate's verdict; set on every judged hit. A hit with no answer is kept (`noul` absent). */
	kept?: boolean;
}

/** JSON form: the hit array itself, `[]` when empty — whatever dropped them. */
export const toJson = (outcome: QueryOutcome): JevHit[] => outcome.hits;

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Human form: one line per hit, or the empty sentence that says which empty
 * it is. With `explain`, every judged hit is shown — kept or dropped — with
 * its noul and verdict, plus a header line with the gate's counts: the
 * display a threshold is re-calibrated from.
 */
export const toText = (outcome: QueryOutcome, explain = false): string => {
	if (outcome.hits.length === 0) {
		return outcome.emptyReason === "none-kept" ? EMPTY_NONE_KEPT : EMPTY_NONE_FOUND;
	}
	const lines = outcome.hits.map((h) => {
		const body = `${h.file}  —  ${oneLine(h.snippet)}`;
		if (!explain) return `${h.score.toFixed(2)}  ${body}`;
		const noul = h.noul === undefined ? "  —" : h.noul.toFixed(2);
		return `${noul}  ${h.kept === false ? "dropped" : "kept   "}  ${body}`;
	});
	if (explain && outcome.gate) {
		lines.unshift(
			`jev ${outcome.gate.model}: ${outcome.gate.scored} scored, ${outcome.gate.dropped} dropped at threshold ${THRESHOLD} — order is qmd's`,
		);
	}
	return lines.join("\n");
};
