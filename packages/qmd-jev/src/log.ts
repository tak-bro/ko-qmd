/**
 * log — `QMD_JEV_LOG`, the append-only query record: model, route, and every
 * judged hit's `noul` and `kept` mark, one JSON object per line. It is the
 * data a threshold re-calibration reads (README "Measured" numbers came from
 * runs like this, taken by hand before the log existed).
 *
 * The key cannot appear here by construction: an entry is built from a
 * `QueryOutcome`, which is built from a store and gate results — the key
 * never enters either. The sink is best-effort on purpose: a log write is
 * never allowed to fail a query, so IO errors are swallowed.
 */
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Env } from "./consent.js";
import type { Failure } from "./jev.js";
import type { JevHit } from "./present.js";
import type { RetrievalRoute } from "./route.js";
import type { QueryOutcome } from "./run-query.js";

/** How the answer was produced: `jev` = gated by Jev, `qmd` = qmd's fused order (gate off, nothing consented, or Jev silent). */
export type QueryRoute = "jev" | "qmd";

export interface QueryLogEntry {
	ts: string;
	query: string;
	route: QueryRoute;
	/** The model that judged — only when route is `jev`. */
	model?: string;
	scored?: number;
	dropped?: number;
	/** Jev was asked and did not answer — status or category, never a message. */
	failure?: Failure;
	/** The route `--route jev` chose (or fell back to) — only when routing was requested. */
	retrieval?: RetrievalRoute;
	hits: { file: string; docid: string; noul?: number; kept?: boolean }[];
}

/** One JSON line per entry — the record a re-calibration greps. */
export const logEntry = (query: string, outcome: QueryOutcome): QueryLogEntry => {
	const judged = outcome.judged ?? outcome.hits;
	return {
		ts: new Date().toISOString(),
		query,
		route: outcome.gate ? "jev" : "qmd",
		...(outcome.gate ? { model: outcome.gate.model, scored: outcome.gate.scored, dropped: outcome.gate.dropped } : {}),
		...(outcome.jevFailure !== undefined ? { failure: outcome.jevFailure } : {}),
		...(outcome.retrieval !== undefined ? { retrieval: outcome.retrieval } : {}),
		hits: judged.map((h: JevHit) => ({
			file: h.file,
			docid: h.docid,
			...(h.noul !== undefined ? { noul: h.noul } : {}),
			...(h.kept !== undefined ? { kept: h.kept } : {}),
		})),
	};
};

/** A line sink. Never throws — a log write must not fail a query. */
export type LineSink = (line: string) => void;

export const appendQueryLog = (sink: LineSink, entry: QueryLogEntry): void => {
	try {
		sink(JSON.stringify(entry));
	} catch {
		// best-effort: logging must never fail a query
	}
};

/** Append to a file, creating parent directories; any error is swallowed by construction. */
export const fileLineSink = (path: string): LineSink => {
	return (line: string): void => {
		try {
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, `${line}\n`);
		} catch {
			// best-effort
		}
	};
};

/** `QMD_JEV_LOG` set → a file sink for it; unset → null (no logging). */
export const logSinkFromEnv = (env: Env): LineSink | null =>
	env.QMD_JEV_LOG ? fileLineSink(env.QMD_JEV_LOG) : null;
