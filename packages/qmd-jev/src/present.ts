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
import type { QueryOutcome } from "./run-query.js";

export type EmptyReason = "none-found" | "none-kept";

export const EMPTY_NONE_FOUND =
	"No results. The index was searched — a top-N semantic index is not exhaustive; try different wording or a lex-style keyword query.";

export const EMPTY_NONE_KEPT =
	"No results kept: the index was searched and judged, and nothing scored as about the query. This is a judgement about these hits, not about the corpus.";

/** The hit row an MCP client already reads (file, score, line) plus what --explain will add. */
export interface JevHit {
	docid: string;
	file: string;
	title: string;
	score: number;
	context: string | null;
	/** Absolute 1-indexed line of the best match in the source document. */
	line: number;
	snippet: string;
}

/** JSON form: the hit array itself, `[]` when empty — whatever dropped them. */
export const toJson = (outcome: QueryOutcome): JevHit[] => outcome.hits;

/** Human form: one line per hit, or the empty sentence that says which empty it is. */
export const toText = (outcome: QueryOutcome): string => {
	if (outcome.hits.length === 0) {
		return outcome.emptyReason === "none-kept" ? EMPTY_NONE_KEPT : EMPTY_NONE_FOUND;
	}
	return outcome.hits
		.map((h) => `${h.score.toFixed(2)}  ${h.file}  —  ${h.snippet.replace(/\s+/g, " ").trim()}`)
		.join("\n");
};
