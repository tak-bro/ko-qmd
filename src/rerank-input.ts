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

/** Weight of an intent term in chunk selection; a non-Hangul query word counts 2, a Hangul bigram 1 */
export const INTENT_WEIGHT_CHUNK = 1.0;

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
 * Head start of the first chunk (title, summary); a later chunk must out-score it by more than this,
 * which a typical short query cannot do, so its first chunk is always sent.
 */
export const FIRST_CHUNK_HEAD_START = 16;

/** The head start when intent is given: halved, so intent words can still steer selection to a later chunk. */
export const FIRST_CHUNK_HEAD_START_WITH_INTENT = 8;

/**
 * Scorer for one chunk's text against `query`: two points per query word longer than two characters
 * with no Hangul, one per query Hangul syllable bigram, and one per intent word (half a non-Hangul
 * query word). Case-insensitive substring match.
 */
export const rerankChunkScorer = (query: string, intentTerms: string[]): ((text: string) => number) => {
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 2 && !/[가-힣]/.test(t));
  const bigrams = hangulBigrams(queryLower);
  return (text) => {
    const lower = text.toLowerCase();
    return queryTerms.reduce((acc, term) => acc + (lower.includes(term) ? 2 : 0), 0)
      + bigrams.reduce((acc, bg) => acc + (lower.includes(bg) ? 1 : 0), 0)
      + intentTerms.reduce((acc, term) => acc + (lower.includes(term) ? INTENT_WEIGHT_CHUNK : 0), 0);
  };
};

/**
 * Index of the chunk to rerank: the highest `rerankChunkScorer` score, with the first chunk starting
 * FIRST_CHUNK_HEAD_START ahead (FIRST_CHUNK_HEAD_START_WITH_INTENT with intent), so the note's lead is
 * sent unless a later chunk matches far more of the query. A tie keeps the earlier chunk.
 */
export const selectRerankChunk = (chunks: RerankChunk[], query: string, intentTerms: string[]): number => {
  const score = rerankChunkScorer(query, intentTerms);
  const headStart = intentTerms.length === 0 ? FIRST_CHUNK_HEAD_START : FIRST_CHUNK_HEAD_START_WITH_INTENT;
  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < chunks.length; i++) {
    const s = score(chunks[i]!.text) + (i === 0 ? headStart : 0);
    if (s > bestScore) { bestScore = s; bestIdx = i; }
  }
  return bestIdx;
};

/** The document text sent for one candidate: the selected chunk, led by the note title when the chunk lacks it. */
export const formatRerankDoc = (chunkText: string, meta: RerankDocMeta): string =>
  meta.title && !chunkText.includes(meta.title) ? `# ${meta.title}\n\n${chunkText}` : chunkText;
