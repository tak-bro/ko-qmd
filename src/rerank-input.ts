/**
 * rerank-input.ts - what the cross-encoder reranker is shown.
 *
 * Both search paths (`hybridQuery`, `structuredSearch`) and `rerank()` build the reranker's
 * input here and nowhere else: the query string, which chunk of a candidate document is sent,
 * and the document text made from that chunk. The query string is also the rerank cache key,
 * so a change here re-scores every cached pair.
 */

/** A chunk as the search paths cut it: text plus its character offset in the body. */
export type RerankChunk = { text: string; pos: number };

/** Candidate metadata a document text may draw on besides the chunk. */
export type RerankDocMeta = { file: string; title: string; displayPath: string };

/** Weight for intent terms relative to query terms (1.0) in chunk selection */
export const INTENT_WEIGHT_CHUNK = 0.5;

/** The reranker's query: intent, a blank line, then the query; the query alone without intent. */
export const formatRerankQuery = (query: string, intent?: string): string =>
  intent ? `${intent}\n\n${query}` : query;

/**
 * Index of the chunk to rerank: the one containing the most query words longer than two
 * characters, each intent word adding half a point. Case-insensitive substring match; a tie
 * keeps the earlier chunk, and no match picks the first.
 */
export const selectRerankChunk = (chunks: RerankChunk[], query: string, intentTerms: string[]): number => {
  const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < chunks.length; i++) {
    const chunkLower = chunks[i]!.text.toLowerCase();
    let score = queryTerms.reduce((acc, term) => acc + (chunkLower.includes(term) ? 1 : 0), 0);
    for (const term of intentTerms) {
      if (chunkLower.includes(term)) score += INTENT_WEIGHT_CHUNK;
    }
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestIdx;
};

/** The document text sent for one candidate: the selected chunk as it is. */
export const formatRerankDoc = (chunkText: string, _meta: RerankDocMeta): string => chunkText;
