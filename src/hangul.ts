/**
 * hangul.ts - Korean (Hangul) handling for FTS5 indexing and queries.
 *
 * ko-qmd patch stack: all Hangul-specific logic lives here so store.ts keeps
 * at most two call sites. Han and kana appear only as CJK-side characters in
 * estimateCharsPerToken's density count — indexing and query logic never sees them.
 */

const HANGUL_WORD_PATTERN = /^\p{Script=Hangul}+$/u;
const HANGUL_RUN_PATTERN = /\p{Script=Hangul}+/gu;

// Particles (design §4) plus the nominalizing ending 기 (`나누기` → `나누`).
// Longest first, so 에서 wins over 에 and 으로 over 로.
const SUFFIXES = [
  "에게", "에서", "으로", "까지", "부터", "처럼",
  "은", "는", "이", "가", "을", "를", "에", "로", "의", "도", "와", "과", "기",
];

// Verbal and nominalizing endings on 하다/되다 stems (`토큰화하는` → `토큰화`).
// Longest first, and always tried before SUFFIXES so `하기` wins over bare `기`.
const ENDINGS = [
  "하려는", "되려는", "하면서", "되면서",
  "하는", "하기", "한다", "했다", "하며", "하고", "하여", "해서", "하지", "하다",
  "되는", "되기", "된다", "됐다", "되며", "되고", "되어", "돼서", "되다",
  "한", "된",
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
 * Whether two texts share a Hangul syllable bigram (`검색을 고치기` and `문서 검색`
 * share `검색`). Two Korean sentences about the same thing overlap in syllables long
 * before they overlap in whole words, because the words carry different particles and
 * endings, so a bigram is the smallest unit that says "these are about the same thing"
 * without stemming both sides. Returns false when either side has no Hangul run of two
 * or more syllables.
 */
export function sharesHangulBigram(a: string, b: string): boolean {
  const left = new Set((a.match(HANGUL_RUN_PATTERN) ?? []).flatMap(syllableBigrams));
  if (left.size === 0) return false;
  for (const run of b.match(HANGUL_RUN_PATTERN) ?? []) {
    for (const gram of syllableBigrams(run)) if (left.has(gram)) return true;
  }
  return false;
}

/**
 * Strip one trailing particle (or 기) from a pure-Hangul word when the stem
 * keeps at least two syllables (`검색을` → `검색`, `책을` stays). Returns null
 * when nothing is stripped.
 */
export function stripHangulParticle(word: string): string | null {
  return stripOnce(word, SUFFIXES);
}

/**
 * Strip one trailing verbal/nominalizing ending (`토큰화하는` → `토큰화`,
 * `검색하기` → `검색`). Returns null when nothing is stripped. Endings are tried
 * before particles so `하기` wins over the bare `기` that would leave `검색하`.
 */
export function stripHangulEnding(word: string): string | null {
  return stripOnce(word, ENDINGS);
}

function stripOnce(word: string, suffixes: readonly string[]): string | null {
  if (!HANGUL_WORD_PATTERN.test(word)) return null;
  const syllables = Array.from(word);
  for (const suffix of suffixes) {
    const stemLength = syllables.length - Array.from(suffix).length;
    if (stemLength < MIN_STEM_SYLLABLES) continue;
    if (word.endsWith(suffix)) return syllables.slice(0, stemLength).join("");
  }
  return null;
}

/**
 * Stems worth querying for one Hangul word, longest first and without the word
 * itself: an ending (`토큰화하는` → `토큰화`), then particles, twice, so a chain
 * like `청킹에서의` reaches `청킹`. Two rounds cover the chains Korean actually
 * stacks in queries (`에서 + 의`, `으로 + 는`) without unwinding real syllables.
 */
export function hangulStems(word: string): string[] {
  const stems: string[] = [];
  let current = word;
  for (let round = 0; round < 2; round++) {
    const next = stripHangulEnding(current) ?? stripHangulParticle(current);
    if (next === null || next === current) break;
    stems.push(next);
    current = next;
  }
  return [...stems, ...stems.flatMap(contractions)];
}

/**
 * 하 ↔ 해 siblings of a stem (`더하` → `더해`). 하다 verbs contract in running
 * text (`더하여` is written `더해`), so a stem stripped back to 하 would never
 * meet the contracted spelling the document actually uses. One syllable swap,
 * no new stripping.
 */
function contractions(stem: string): string[] {
  if (stem.endsWith("하")) return [`${stem.slice(0, -1)}해`];
  if (stem.endsWith("해")) return [`${stem.slice(0, -1)}하`];
  return [];
}

/**
 * FTS5 expression for a plain (unquoted) Hangul query term: for the word and
 * each of its stems, a bigram phrase (from hangulBigramTail) OR the character
 * phrase (`검색` → `("검색" OR "검 색")`). The character phrase keeps spacing
 * variants matching (`간격반복` over `간격 반복`), which bigrams cannot span; the
 * bigram phrase adds its BM25 weight. A loanword (hangulLoanwordForms) also ORs
 * its Latin spelling. Returns null for single syllables with no loanword entry and
 * for non-Hangul or mixed-script terms, so the caller keeps its default character
 * phrase.
 */
export function hangulTermQuery(term: string): string | null {
  if (!HANGUL_WORD_PATTERN.test(term)) return null;
  const loanwords = hangulLoanwordForms(term).map((form) => `"${form}"`);
  if (Array.from(term).length < 2) {
    return loanwords.length > 0 ? `(${[`"${term}"`, ...loanwords].join(" OR ")})` : null;
  }
  const phrases = (s: string) => [`"${syllableBigrams(s).join(" ")}"`, `"${Array.from(s).join(" ")}"`];
  const stems = hangulStems(term);
  return `(${[...stems.flatMap(phrases), ...phrases(term), ...loanwords].join(" OR ")})`;
}

/**
 * Hangul loanword spellings of Latin technical vocabulary. Notes name things by their
 * Latin identifier (`hybrid-search.md`, `lemon-web-core`) while questions spell the same
 * words in Hangul (`하이브리드 서치`, `레몬 웹 코어`), and neither bigrams nor the vector
 * list bridge that on the lex side. Hand-written, one entry per line; forms are lowercase
 * ASCII words separated by single spaces so they are safe inside an FTS5 phrase.
 */
const LOANWORDS: Readonly<Record<string, readonly string[]>> = {
  "가이드": ["guide"],
  "골든": ["golden"],
  "그래프": ["graph"],
  "노트": ["note"],
  "데몬": ["daemon"],
  "데이터": ["data"],
  "데이터셋": ["dataset"],
  "디바이스": ["device"],
  "디시전": ["decision"],
  "랭크": ["rank"],
  "랭킹": ["ranking"],
  "레몬": ["lemon"],
  "레시프로컬": ["reciprocal"],
  "레코드": ["record"],
  "로그": ["log"],
  "리랭커": ["reranker"],
  "리랭크": ["rerank"],
  "리랭킹": ["reranking"],
  "리트리벌": ["retrieval"],
  "리피티션": ["repetition"],
  "린트": ["lint"],
  "마이그레이션": ["migration"],
  "메타데이터": ["metadata"],
  "모델": ["model"],
  "미팅": ["meeting"],
  "바이그램": ["bigram"],
  "벡터": ["vector"],
  "벤치": ["bench"],
  "벤치마크": ["benchmark"],
  "서버": ["server"],
  "서치": ["search"],
  "세션": ["session"],
  "스키마": ["schema"],
  "스킬": ["skill"],
  "스페이스드": ["spaced"],
  "싱크": ["sync"],
  "아카이브": ["archive"],
  "어펜드": ["append"],
  "에이전트": ["agent"],
  "엔그램": ["ngram", "n gram"],
  "오토메이션": ["automation"],
  "온리": ["only"],
  "워크플로": ["workflow"],
  "워크플로우": ["workflow"],
  "웹": ["web"],
  "위키": ["wiki"],
  "위키링크": ["wikilink"],
  "유니그램": ["unigram"],
  "익스팬션": ["expansion"],
  "인덱스": ["index"],
  "인버티드": ["inverted"],
  "인제스트": ["ingest"],
  "인코더": ["encoder"],
  "임베딩": ["embedding"],
  "청크": ["chunk"],
  "청킹": ["chunking"],
  "캐시": ["cache"],
  "컨텍스트": ["context"],
  "컬렉션": ["collection"],
  "코어": ["core"],
  "쿼리": ["query"],
  "크로스": ["cross"],
  "클라이언트": ["client"],
  "템플릿": ["template"],
  "토크나이제이션": ["tokenization"],
  "토큰": ["token"],
  "토픽": ["topic"],
  "트래킹": ["tracking"],
  "파이프라인": ["pipeline"],
  "퓨전": ["fusion"],
  "프로버넌스": ["provenance"],
  "프로비넌스": ["provenance"],
  "프로필": ["profile"],
  "프론트매터": ["frontmatter"],
  "프롬프트": ["prompt"],
  "플러그인": ["plugin"],
  "필터": ["filter"],
  "하이브리드": ["hybrid"],
  "훅": ["hook"],
};

/**
 * Latin spellings for a Hangul loanword (`서치` → `search`), looked up on the word and on
 * its particle-stripped stems so `서치를` bridges too. Empty when nothing matches.
 */
export function hangulLoanwordForms(term: string): string[] {
  const forms = [term, ...hangulStems(term)].flatMap((word) => LOANWORDS[word] ?? []);
  return [...new Set(forms)];
}

/**
 * FTS5 expression for a term that glues Hangul to Latin or digits
 * (`SKILL.md계약의핵심`, `hook이유일한hardboundary다`, `auto-dream의발화조건`).
 * The index already splits scripts — hangulBigramTail only sees Hangul runs and the
 * porter tokenizer splits the rest — so the query has to split too, or the glued term
 * is searched as one phrase that appears nowhere. Each Hangul run goes through
 * hangulTermQuery, each Latin/digit run becomes a prefix term, and the runs are ANDed.
 * Separators (`.`, `-`, `/`, `+`) are dropped with the rest of the non-alphanumerics.
 * Returns null when the term is not mixed script, so callers keep their own handling.
 */
export function hangulMixedQuery(term: string): string | null {
  // Set subtraction (v flag) keeps a non-Hangul run from swallowing the Hangul next to it —
  // plain alternation matches `[\p{L}\p{N}]+` across the boundary once it starts on Latin.
  const runs = term.match(/\p{Script=Hangul}+|[[\p{L}\p{N}]--[\p{Script=Hangul}]]+/gv) ?? [];
  const hangulRuns = runs.filter((r) => HANGUL_WORD_PATTERN.test(r));
  if (hangulRuns.length === 0 || hangulRuns.length === runs.length) return null;

  const parts = runs.flatMap((run) => {
    if (HANGUL_WORD_PATTERN.test(run)) {
      return [hangulTermQuery(run) ?? `"${Array.from(run).join(" ")}"`];
    }
    const latin = run.replace(/[^\p{L}\p{N}'_]/gu, "").toLowerCase();
    return latin ? [`"${latin}"*`] : [];
  });
  return parts.length > 0 ? `(${parts.join(" AND ")})` : null;
}

const CJK_CHARS_PER_TOKEN = 1.6;
const OTHER_CHARS_PER_TOKEN = 3.0;
const CJK_SCRIPT_PATTERN = /\p{Script=Hangul}|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/gu;

/**
 * Estimated characters per token for chunk sizing, judged from the script
 * makeup of `text` alone — a regex count, no tokenizer call. CJK (Hangul,
 * Han, kana) runs at 1.6 chars/token (measured 1.64 on Korean prose,
 * 2026-09-21); everything else keeps whatever ratio the caller was already
 * using, so non-CJK chunk boundaries do not move. That ratio differs by call
 * site — indexing sized its first pass at 3.0, the search paths at 4.0
 * (`CHUNK_SIZE_CHARS / CHUNK_SIZE_TOKENS`) — so each passes its own through
 * `otherCharsPerToken` rather than sharing one default. Because token counts add across
 * scripts, the blend is the harmonic mean `(c + o) / (c/1.6 + o/3.0)` — a
 * linear interpolation of the two ratios would overestimate a half-and-half
 * document by about 10% (2.30 vs 2.09) and call the resplit safety net back
 * into action. The count is whole-text, not a leading sample: a Korean
 * document that opens with an English code block would otherwise be judged
 * Latin. Empty text returns `otherCharsPerToken`, the caller's previous behavior.
 *
 * `otherCharsPerToken` must be positive — zero or negative yields a non-finite
 * ratio and NaN budgets downstream. Both in-repo call sites pass a literal
 * (3.0 when indexing, `CHUNK_SIZE_CHARS / CHUNK_SIZE_TOKENS` on the search
 * paths), so this is a precondition, not a runtime check.
 */
export function estimateCharsPerToken(
  text: string,
  otherCharsPerToken: number = OTHER_CHARS_PER_TOKEN,
): number {
  const cjk = (text.match(CJK_SCRIPT_PATTERN) ?? []).length;
  const total = [...text].length;
  if (total === 0) return otherCharsPerToken;
  const other = total - cjk;
  return total / (cjk / CJK_CHARS_PER_TOKEN + other / otherCharsPerToken);
}
