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
 * Hangul syllable bigrams of every Hangul run of three or more syllables in `text`, so a
 * particle-suffixed word still matches its stem and a bare two-syllable word (`방법`) does not count.
 */
const hangulBigrams = (text: string): string[] =>
  (text.match(/[가-힣]{3,}/g) ?? []).flatMap((run) => Array.from({ length: run.length - 1 }, (_, i) => run.slice(i, i + 2)));

/**
 * Index of the chunk to rerank: the one containing the most query words longer than two
 * characters (two points each) plus query Hangul syllable bigrams, each intent word adding half a point.
 * Case-insensitive substring match; a tie keeps the earlier chunk, and no match picks the first.
 */
export const selectRerankChunk = (chunks: RerankChunk[], query: string, intentTerms: string[]): number => {
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 2 && !/[가-힣]/.test(t));
  const bigrams = hangulBigrams(queryLower);
  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < chunks.length; i++) {
    const chunkLower = chunks[i]!.text.toLowerCase();
    let score = queryTerms.reduce((acc, term) => acc + (chunkLower.includes(term) ? 2 : 0), 0);
    score += bigrams.reduce((acc, bg) => acc + (chunkLower.includes(bg) ? 1 : 0), 0);
    for (const term of intentTerms) {
      if (chunkLower.includes(term)) score += INTENT_WEIGHT_CHUNK;
    }
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestIdx;
};

/** The document text sent for one candidate: the selected chunk, led by the note title when the chunk lacks it. */
export const formatRerankDoc = (chunkText: string, meta: RerankDocMeta): string =>
  meta.title && !chunkText.includes(meta.title) ? `# ${meta.title}\n\n${chunkText}` : chunkText;
