/**
 * hangul.ts - Korean (Hangul) handling for FTS5 indexing and queries.
 *
 * ko-qmd patch stack: all Hangul-specific logic lives here so store.ts keeps
 * at most two call sites. Han and kana text never reaches these functions.
 */

const HANGUL_WORD_PATTERN = /^\p{Script=Hangul}+$/u;
const HANGUL_RUN_PATTERN = /\p{Script=Hangul}+/gu;

// Particles (design §4) plus the nominalizing ending 기 (`나누기` → `나누`).
// Longest first, so 에서 wins over 에 and 으로 over 로.
const SUFFIXES = [
  "에게", "에서", "으로", "까지", "부터", "처럼",
  "은", "는", "이", "가", "을", "를", "에", "로", "의", "도", "와", "과", "기",
];

const MIN_STEM_SYLLABLES = 2;

function syllableBigrams(word: string): string[] {
  const syllables = Array.from(word);
  return syllables.slice(1).map((s, i) => syllables[i] + s);
}

/**
 * Syllable bigrams of every Hangul run in `text`, space-joined in run order
 * (`검색을 개선` → `검색 색을 개선`). Appended after the character-spaced field
 * text at index time: the character tokens keep their original adjacency, so
 * existing phrase queries match exactly as before, and bigram phrases from
 * one run stay contiguous.
 */
export function hangulBigramTail(text: string): string {
  const runs = text.match(HANGUL_RUN_PATTERN) ?? [];
  return runs.flatMap(syllableBigrams).join(" ");
}

/**
 * Strip one trailing particle (or 기) from a pure-Hangul word when the stem
 * keeps at least two syllables (`검색을` → `검색`, `책을` stays). Returns null
 * when nothing is stripped.
 */
export function stripHangulParticle(word: string): string | null {
  if (!HANGUL_WORD_PATTERN.test(word)) return null;
  const syllables = Array.from(word);
  for (const suffix of SUFFIXES) {
    const stemLength = syllables.length - suffix.length;
    if (stemLength < MIN_STEM_SYLLABLES) continue;
    if (word.endsWith(suffix)) return syllables.slice(0, stemLength).join("");
  }
  return null;
}

/**
 * FTS5 expression for a plain (unquoted) Hangul query term: for the word and
 * its particle-stripped stem, a bigram phrase (from hangulBigramTail) OR the
 * character phrase (`검색` → `("검색" OR "검 색")`). The character phrase keeps
 * spacing variants matching (`간격반복` over `간격 반복`), which bigrams cannot
 * span; the bigram phrase adds its BM25 weight. Returns null for single
 * syllables and non-Hangul or mixed-script terms, so the caller keeps its
 * default character phrase.
 */
export function hangulTermQuery(term: string): string | null {
  if (!HANGUL_WORD_PATTERN.test(term) || Array.from(term).length < 2) return null;
  const phrases = (s: string) => [`"${syllableBigrams(s).join(" ")}"`, `"${Array.from(s).join(" ")}"`];
  const stem = stripHangulParticle(term);
  return `(${[...(stem ? phrases(stem) : []), ...phrases(term)].join(" OR ")})`;
}
