/**
 * runQuery — retrieval composition and the fail-open path. In slice 02 this
 * is the whole story: retrieve through the SDK with the reranker off and
 * hand back qmd's own fused order. The Jev gate and ranking (slice 03) slot
 * in between retrieval and the return; the fallback path they will fail open
 * onto is exactly this one, built and tested first.
 *
 * The sub-queries are built here, not by the local expansion model —
 * `search({query})` still runs it, and skipping local models in the hot path
 * is the point of this package. `lex` first: the first sub-query carries 2×
 * weight in the fusion, and the literal query is the strongest signal we
 * have without an LLM. `--expand` (slice 03) offers the LLM-built set
 * instead.
 */
import { extractSnippet } from "ko-qmd";
import type { ExpandedQuery, HybridQueryResult, SearchOptions } from "ko-qmd";
import type { EmptyReason, JevHit } from "./present.js";

/** The slice of QMDStore this composition needs — fakes implement just this. */
export interface RetrievalStore {
	search(options: SearchOptions): Promise<HybridQueryResult[]>;
}

export interface QueryOptions {
	/** Restrict retrieval to these collections (`-c`, repeatable). */
	collections?: string[];
	/** Max results; qmd's own default (10) when absent. */
	limit?: number;
}

export interface QueryOutcome {
	hits: JevHit[];
	/** Which order the hits are in — the fallback contract, named so callers can state it. */
	order: "fused" | "jev";
	emptyReason?: EmptyReason;
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
	};
};

/** Retrieve and present, in qmd's own fused order. Never throws; never calls Jev. */
export const runQuery = async (
	store: RetrievalStore,
	query: string,
	opts: QueryOptions = {},
): Promise<QueryOutcome> => {
	const hits = await store.search({
		queries: subQueries(query),
		rerank: false,
		minScore: 0,
		limit: opts.limit ?? 10,
		collections: opts.collections,
	});
	return {
		hits: hits.map((r) => toJevHit(query, r)),
		order: "fused",
		...(hits.length === 0 ? { emptyReason: "none-found" as const } : {}),
	};
};
