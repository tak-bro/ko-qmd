/**
 * runQuery — retrieval, then (when Jev is on and consented) the relevance
 * gate; otherwise, or when Jev does not answer, qmd's own fused order
 * unchanged. The gate judges membership only: hits it keeps stay in qmd's
 * fused order, because sorting by the measured noul spread was harmful
 * (rank.ts, README "Measured").
 *
 * The sub-queries are built here, not by the local expansion model —
 * `search({query})` routes to the hybrid path that still runs it, and
 * skipping local models in the hot path is the point of this package.
 * `--expand` opts back into qmd's own LLM expansion (the reranker stays off
 * either way). Both modes are timed in README "Measured"; the faster one
 * (in-package) is the default. `--route jev` goes one further: a single
 * choice question about the query alone picks lex, vec, or full (route.ts) —
 * and a lex or vec pick also skips local expansion, because the hybrid path
 * it feeds is not being run.
 *
 * Consent applies before anything is built: a hit from a collection not on
 * the allowlist is never described to Jev. When nothing consented (no key,
 * allowlist off, or every hit unlisted) the whole gate is skipped — the
 * request is not merely not sent, it is not constructed.
 */
import { extractSnippet } from "ko-qmd";
import type { ExpandedQuery, HybridQueryResult, SearchOptions } from "ko-qmd";
import type { Failure, JevClient } from "./jev.js";
import { collectionOf } from "./consent.js";
import { MAX_CHUNK_CHARS, rankHits } from "./rank.js";
import { chooseRoute, type RetrievalRoute } from "./route.js";
import type { EmptyReason, JevHit } from "./present.js";

/** Candidates retrieved before ranking — sized so the Jev state stays inside the vendor's 32K budget (rank.ts). */
export const CANDIDATE_LIMIT = 40;

/** The slice of QMDStore this composition needs — fakes implement just this. */
export interface RetrievalStore {
	search(options: SearchOptions): Promise<HybridQueryResult[]>;
}

export interface QueryOptions {
	/** Restrict retrieval to these collections (`-c`, repeatable). */
	collections?: string[];
	/** Max results; qmd's own default (10) when absent. */
	limit?: number;
	/** Jev client; absent or `ready() === false` = answer unranked, no request built. */
	jev?: JevClient;
	/** Collections Jev may be told about (the consent allowlist). Required alongside `jev`. */
	allowed?: string[];
	/** Opt into qmd's own LLM query expansion instead of the in-package sub-queries. */
	expand?: boolean;
	/** Show every judged hit with its noul and kept/dropped mark, not just the kept. */
	explain?: boolean;
	/** `jev`: one choice question about the query alone picks lex / vec / full (silence → full; a lex or vec pick also skips local expansion). Default `full`. */
	route?: "full" | "jev";
	/** Candidates retrieved before ranking (default 40). */
	candidateLimit?: number;
}

export interface GateStats {
	/** Hits that got a usable noul answer. */
	scored: number;
	/** Hits dropped as off-topic — scored, and below the threshold. */
	dropped: number;
	/** The model version that answered, for the log (slice 04). */
	model: string;
}

export interface QueryOutcome {
	hits: JevHit[];
	emptyReason?: EmptyReason;
	/**
	 * Jev was asked and did not answer, so this answer is unjudged — named by
	 * an HTTP status or a category, never a message. Absent when Jev was not
	 * on, was never asked, or the caller aborted.
	 */
	jevFailure?: Failure;
	/** Present when Jev judged the hits. Membership only — the order is always qmd's fused order. */
	gate?: GateStats;
	/**
	 * The route `--route jev` chose (or fell back to) — absent unless routing
	 * was requested. Chosen from the query alone; the query log records it.
	 */
	retrieval?: RetrievalRoute;
	/**
	 * Every judged hit — kept and dropped — in fused order, present whenever
	 * the gate ran. The display shows `hits`; this is the query log's input,
	 * because a dropped hit's `noul` is exactly the calibration data.
	 */
	judged?: JevHit[];
}

const subQueries = (query: string): ExpandedQuery[] => [
	{ type: "lex", query },
	{ type: "vec", query },
];

const toJevHit = (query: string, r: HybridQueryResult): JevHit => {
	const { line, snippet } = extractSnippet(r.body, query, 300, r.bestChunkPos, r.bestChunk.length);
	return {
		docid: r.docid,
		file: r.file,
		title: r.title,
		score: r.score,
		context: r.context,
		line,
		snippet,
		chunk: r.bestChunk.slice(0, MAX_CHUNK_CHARS),
	};
};

const plainOutcome = (hits: JevHit[], limit: number): QueryOutcome => ({
	hits: hits.slice(0, limit),
	...(hits.length === 0 ? { emptyReason: "none-found" as const } : {}),
});

/**
 * Retrieve, gate, present. Never throws on Jev trouble: every failure path
 * lands on the fused order that slice 02 shipped.
 */
export const runQuery = async (
	store: RetrievalStore,
	query: string,
	opts: QueryOptions = {},
): Promise<QueryOutcome> => {
	const limit = opts.limit ?? 10;
	const jevOn = opts.jev !== undefined && opts.jev.ready() && (opts.allowed?.length ?? 0) > 0;
	let retrieval: RetrievalRoute | undefined;
	const searchOptions: SearchOptions = {
		rerank: false,
		minScore: 0,
		limit: jevOn ? (opts.candidateLimit ?? CANDIDATE_LIMIT) : limit,
		collections: opts.collections,
	};
	if (opts.route === "jev" && opts.jev !== undefined && opts.jev.ready()) {
		const chosen = await chooseRoute(opts.jev.ask, query);
		if (chosen === "lex" || chosen === "vec") {
			// A routed pick searches the chosen way only — local expansion is skipped
			// (it feeds the hybrid path's lex/vec terms, which we are not running).
			searchOptions.queries = [{ type: chosen, query }];
		} else if (opts.expand) {
			searchOptions.query = query;
		} else {
			searchOptions.queries = subQueries(query);
		}
		retrieval = chosen;
	} else if (opts.expand) {
		searchOptions.query = query;
	} else {
		searchOptions.queries = subQueries(query);
	}

	const rows = await store.search(searchOptions);
	const hits = rows.map((r) => toJevHit(query, r));

	if (!jevOn) return { ...plainOutcome(hits, limit), ...(retrieval !== undefined ? { retrieval } : {}) };

	// Consent before construction: only allowlisted collections' content is described to Jev.
	const listed = hits.filter((h) => opts.allowed!.includes(collectionOf(h.file)));
	if (listed.length === 0) return { ...plainOutcome(hits, limit), ...(retrieval !== undefined ? { retrieval } : {}) };

	const ranked = await rankHits(opts.jev!.ask, query, listed);
	if (ranked === null) {
		const failure = opts.jev!.lastFailure();
		return {
			...plainOutcome(hits, limit),
			...(retrieval !== undefined ? { retrieval } : {}),
			...(failure !== null ? { jevFailure: failure } : {}),
		};
	}
	const shown = (opts.explain ? ranked.judged : ranked.kept).slice(0, limit);
	return {
		hits: shown,
		...(shown.length === 0 ? { emptyReason: "none-kept" as const } : {}),
		gate: { scored: ranked.scored, dropped: ranked.dropped, model: ranked.model },
		judged: ranked.judged,
		...(retrieval !== undefined ? { retrieval } : {}),
	};
};
