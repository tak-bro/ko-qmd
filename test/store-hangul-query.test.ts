/**
 * store-hangul-query.test.ts - Q1/I1: Korean particle stripping and syllable
 * bigrams for plain lex terms.
 *
 * Indexed text carries Hangul syllable bigrams after the character tokens.
 * Plain Hangul terms query bigram OR character phrases of the word and its
 * particle-stripped stem, so `검색을` finds documents that only contain `검색`
 * and `검색품질` still matches `검색 품질`. Quoted phrases stay
 * exact over character tokens, and Han/kana queries keep the upstream path.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type QMDStore } from "../src/index.js";
import { hybridQuery, normalizeCjkForFTS, structuredSearch, validateLexQuery } from "../src/store.js";
import {
  containsHangul,
  estimateCharsPerToken,
  hangulBigramTail,
  hangulLoanwordForms,
  hangulMixedQuery,
  hangulStems,
  hangulTermQuery,
  sharesHangulBigram,
  stripHangulNegation,
  stripHangulParticle,
} from "../src/hangul.js";

describe("hangulBigramTail", () => {
  test("emits syllable bigrams per Hangul run, in order", () => {
    expect(hangulBigramTail("검색을")).toBe("검색 색을");
    expect(hangulBigramTail("검색을 개선 책")).toBe("검색 색을 개선");
  });

  test("ignores Han, kana and Latin", () => {
    expect(hangulBigramTail("中文检索 検索 vector")).toBe("");
    expect(hangulBigramTail("wiki로 東京에서")).toBe("에서");
  });

  test("normalizeCjkForFTS keeps character tokens and appends bigrams", () => {
    expect(normalizeCjkForFTS("검색을").split(/\s+/).filter(Boolean)).toEqual(["검", "색", "을", "검색", "색을"]);
    expect(normalizeCjkForFTS("中文 test").split(/\s+/).filter(Boolean)).toEqual(["中", "文", "test"]);
  });
});

describe("sharesHangulBigram", () => {
  test("two inflections of the same word share a bigram", () => {
    expect(sharesHangulBigram("검색을 고치기", "문서 검색 품질")).toBe(true);
  });

  test("unrelated Korean sentences share nothing", () => {
    expect(sharesHangulBigram("문서 검색 속도", "점심 메뉴 추천")).toBe(false);
  });

  test("a side with no Hangul run of two syllables shares nothing", () => {
    expect(sharesHangulBigram("책", "책 이야기")).toBe(false);
    expect(sharesHangulBigram("문서 검색", "vector search quality")).toBe(false);
  });
});

describe("hangulStems", () => {
  test("strips an ending before particles", () => {
    expect(hangulStems("토큰화하는")).toEqual(["토큰화"]);
    expect(hangulStems("검색하기")).toEqual(["검색"]);
  });

  test("offers the 하/해 contraction of a stem", () => {
    expect(hangulStems("더하는")).toEqual(["더하", "더해"]);
  });

  test("strips a bare 한 when the stem survives", () => {
    expect(hangulStems("필요한")).toEqual(["필요"]);
    expect(hangulStems("무한")).toEqual([]);
  });

  test("unwinds a two-particle chain", () => {
    expect(hangulStems("청킹에서의")).toEqual(["청킹에서", "청킹"]);
  });

  test("stops when the stem would fall below two syllables", () => {
    expect(hangulStems("책을")).toEqual([]);
    expect(hangulStems("검색")).toEqual([]);
  });
});

describe("hangulTermQuery", () => {
  test("ORs bigram and character phrases of the stem and the word", () => {
    expect(hangulTermQuery("검색을")).toBe('("검색" OR "검 색" OR "검색 색을" OR "검 색 을")');
    expect(hangulTermQuery("문서에서")).toBe('("문서" OR "문 서" OR "문서 서에 에서" OR "문 서 에 서")');
    expect(hangulTermQuery("나누기")).toBe('("나누" OR "나 누" OR "나누 누기" OR "나 누 기")');
    expect(hangulTermQuery("검색하기")).toBe('("검색" OR "검 색" OR "검색 색하 하기" OR "검 색 하 기")');
  });

  test("unstrippable words keep bigram OR character phrase", () => {
    expect(stripHangulParticle("책을")).toBeNull();
    expect(stripHangulParticle("사이")).toBeNull();
    expect(stripHangulParticle("크기")).toBeNull();
    expect(hangulTermQuery("검색")).toBe('("검색" OR "검 색")');
    expect(hangulTermQuery("책을")).toBe('("책을" OR "책 을")');
  });

  test("ignores single syllables, Han, kana and mixed-script terms", () => {
    expect(hangulTermQuery("책")).toBeNull();
    expect(hangulTermQuery("中文检索")).toBeNull();
    expect(hangulTermQuery("検索を")).toBeNull();
    expect(hangulTermQuery("wiki로")).toBeNull();
  });
});

describe("hangulLoanwordForms", () => {
  test("maps a Hangul loanword to its Latin spelling", () => {
    expect(hangulLoanwordForms("서치")).toEqual(["search"]);
    expect(hangulLoanwordForms("웹")).toEqual(["web"]);
  });

  test("native words and unknown loanwords map to nothing", () => {
    expect(hangulLoanwordForms("검색")).toEqual([]);
    expect(hangulLoanwordForms("역색인")).toEqual([]);
  });

  test("looks up the particle-stripped stem, once", () => {
    expect(hangulLoanwordForms("서치를")).toEqual(["search"]);
  });

  test("query-log loanwords bridge to their Latin spellings", () => {
    expect(hangulLoanwordForms("지연")).toEqual(["latency"]);
    expect(hangulLoanwordForms("병렬")).toEqual(["parallel"]);
    expect(hangulLoanwordForms("게이트")).toEqual(["gate"]);
    expect(hangulLoanwordForms("가드")).toEqual(["guard"]);
    expect(hangulLoanwordForms("패널")).toEqual(["panel"]);
    expect(hangulLoanwordForms("팔레트")).toEqual(["palette"]);
    expect(hangulLoanwordForms("하네스")).toEqual(["harness"]);
    expect(hangulLoanwordForms("옵시디언")).toEqual(["obsidian"]);
    expect(hangulLoanwordForms("백링크")).toEqual(["backlink"]);
    expect(hangulLoanwordForms("포즈")).toEqual(["pause"]);
    expect(hangulLoanwordForms("루프")).toEqual(["loop"]);
  });

  test("native words from the same logs stay unbridged", () => {
    expect(hangulLoanwordForms("색인")).toEqual([]);
    expect(hangulLoanwordForms("질의")).toEqual([]);
    expect(hangulLoanwordForms("요약")).toEqual([]);
    expect(hangulLoanwordForms("문서")).toEqual([]);
  });
});

describe("hangulTermQuery with loanwords", () => {
  test("ORs the Latin spelling as one quoted phrase after the Hangul phrases", () => {
    expect(hangulTermQuery("서치를")).toBe('("서치" OR "서 치" OR "서치 치를" OR "서 치 를" OR "search")');
    expect(hangulTermQuery("엔그램")).toBe('("엔그 그램" OR "엔 그 램" OR "ngram" OR "n gram")');
  });

  test("a single-syllable loanword queries its character and Latin spelling", () => {
    expect(hangulTermQuery("웹")).toBe('("웹" OR "web")');
  });

  test("a Hangul run inside a script-mixed term is bridged too", () => {
    expect(hangulMixedQuery("qmd서치")).toBe('("qmd"* AND ("서치" OR "서 치" OR "search"))');
  });

  test("a word with no loanword entry is unchanged", () => {
    expect(hangulTermQuery("역색인")).toBe('("역색 색인" OR "역 색 인")');
    expect(hangulTermQuery("책")).toBeNull();
  });
});

describe("hangulMixedQuery", () => {
  test("splits a script-mixed term into ANDed runs", () => {
    expect(hangulMixedQuery("qmd색인을")).toBe('("qmd"* AND ("색인" OR "색 인" OR "색인 인을" OR "색 인 을"))');
    expect(hangulMixedQuery("SKILL.md계약")).toBe('("skill"* AND "md"* AND ("계약" OR "계 약"))');
  });

  test("keeps a single-syllable run as a character phrase", () => {
    expect(hangulMixedQuery("hook다")).toBe('("hook"* AND "다")');
  });

  test("returns null for terms that are not script-mixed", () => {
    expect(hangulMixedQuery("검색을")).toBeNull();
    expect(hangulMixedQuery("qmd")).toBeNull();
    expect(hangulMixedQuery("中文检索")).toBeNull();
  });
});

describe("estimateCharsPerToken", () => {
  test("pure Hangul prose sits at the CJK density (1.6 chars/token)", () => {
    expect(estimateCharsPerToken("가나다라마바사아자차")).toBeCloseTo(1.6, 5);
  });

  test("pure Latin keeps the existing 3.0 chars/token", () => {
    expect(estimateCharsPerToken("the quick brown fox jumps")).toBe(3.0);
  });

  test("Han and kana count on the CJK side", () => {
    expect(estimateCharsPerToken("漢字カタカナひらがな")).toBeCloseTo(1.6, 5);
  });

  test("empty and whitespace-only text fall back to 3.0", () => {
    expect(estimateCharsPerToken("")).toBe(3.0);
    expect(estimateCharsPerToken("  \n\t ")).toBe(3.0);
  });

  test("mixed CJK/Latin text is a harmonic blend, not linear (r=0.5: 2.09, not 2.3)", () => {
    const ratio = estimateCharsPerToken("가".repeat(50) + "a".repeat(50));
    expect(ratio).toBeCloseTo(2.087, 2);
    expect(ratio).toBeLessThan(2.2); // linear interpolation would return 2.3
  });
});

describe("searchLex with Hangul particles", () => {
  let root: string;
  let store: QMDStore;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "qmd-hangul-query-"));
    const docs = join(root, "docs");
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, "ko.md"), "# 검색 품질\n\n역색인 구조를 설명한다. qmd 색인은 FTS5 위에서 돈다.\n");
    await writeFile(join(docs, "hybrid-search.md"), "# hybrid-search\n\nBM25 and vector lists fused over n-gram tokens. Notes on the react web core.\n");
    await writeFile(join(docs, "zh.md"), "# 中文检索说明\n\n关键词检索。\n");
    await writeFile(join(docs, "ja.md"), "# 日本語検索メモ\n\n検索品質について。\n");
    store = await createStore({
      dbPath: join(root, "index.sqlite"),
      config: { collections: { docs: { path: docs, pattern: "**/*.md" } } },
    });
    await store.update();
  });

  afterAll(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  const files = async (query: string) => (await store.searchLex(query)).map(r => r.filepath);

  test("particle-suffixed terms match the stem", async () => {
    expect(await files("검색을")).toEqual([expect.stringContaining("ko.md")]);
    expect(await files("역색인의 구조를")).toEqual([expect.stringContaining("ko.md")]);
  });

  test("spacing variants still match through the character phrase", async () => {
    expect(await files("검색품질을")).toEqual([expect.stringContaining("ko.md")]);
  });

  test("script-mixed terms match the Latin and Hangul runs separately", async () => {
    expect(await files("qmd색인을")).toEqual([expect.stringContaining("ko.md")]);
    expect(await files("FTS5위에서")).toEqual([expect.stringContaining("ko.md")]);
  });

  test("unsuffixed and single-syllable terms still match inside words", async () => {
    expect(await files("색인")).toEqual([expect.stringContaining("ko.md")]);
    expect(await files("품")).toEqual([expect.stringContaining("ko.md")]);
  });

  test("Hangul loanword spellings reach Latin-identifier documents", async () => {
    expect(await files("하이브리드 서치")).toEqual([expect.stringContaining("hybrid-search.md")]);
    expect(await files("엔그램 토큰을")).toEqual([expect.stringContaining("hybrid-search.md")]);
    expect(await files("리액트 웹 코어")).toEqual([expect.stringContaining("hybrid-search.md")]);
  });

  // Hangul-only terms joined by a separator take the character-phrase fallback (no stems, no
  // loanwords) — before and after upstream's separator split. `리액트-웹` / `검색-품질을` still miss.
  test("separator-joined and script-mixed Hangul terms keep matching", async () => {
    expect(await files("검색-품질")).toEqual([expect.stringContaining("ko.md")]);
    expect(await files('"검색-품질"')).toEqual([expect.stringContaining("ko.md")]);
    expect(await files("qmd-색인")).toEqual([expect.stringContaining("ko.md")]);
    expect(await files("hybrid-search서치")).toEqual([expect.stringContaining("hybrid-search.md")]);
    expect(await files("hybrid -검색-품질")).toEqual([expect.stringContaining("hybrid-search.md")]);
  });

  test("a quoted hyphenated Latin term matches its separator-split tokens", async () => {
    expect(await files('"hybrid-search"')).toEqual([expect.stringContaining("hybrid-search.md")]);
  });

  test("quoted phrases stay exact over character tokens", async () => {
    expect(await files('"검색을"')).toEqual([]);
    expect(await files('"검색 품질"')).toEqual([expect.stringContaining("ko.md")]);
    expect(await files('"색인 구조"')).toEqual([expect.stringContaining("ko.md")]);
  });

  test("a long question falls back to matching any of its words", async () => {
    // ANDing every word of a Korean sentence matches nothing; the relaxed retry still finds it.
    expect(await files("역색인 구조를 설명하는 문서를 찾고 싶다")).toEqual([
      expect.stringContaining("ko.md"),
    ]);
  });

  test("the relaxed retry needs three terms", async () => {
    expect(await files("역색인 고래")).toEqual([]);
  });

  test("negated Hangul terms exclude documents", async () => {
    expect(await files("구조를 -검색")).toEqual([]);
  });

  test("Han and kana queries are unchanged", async () => {
    expect(await files("关键词检索")).toEqual([expect.stringContaining("zh.md")]);
    expect(await files("検索品質")).toEqual([expect.stringContaining("ja.md")]);
  });
});

describe("containsHangul", () => {
  test("any Hangul syllable or jamo makes a Hangul query", () => {
    expect(containsHangul("검색 품질")).toBe(true);
    expect(containsHangul("tf-idf 말고 흔한 단어 패널티")).toBe(true);
    expect(containsHangul("ㅋㅋ")).toBe(true);
  });

  test("Latin, Han, kana and empty text are not", () => {
    expect(containsHangul("RAG")).toBe(false);
    expect(containsHangul("中文检索 検索")).toBe(false);
    expect(containsHangul("")).toBe(false);
  });

  test("repeated calls give the same answer (no global-regex state)", () => {
    expect([containsHangul("검색"), containsHangul("검색"), containsHangul("검색")]).toEqual([true, true, true]);
  });
});

describe("stripHangulNegation", () => {
  test("keeps only the clause after 말고", () => {
    expect(stripHangulNegation("tf-idf 말고 흔한 단어 패널티가 들어간 순위 공식")).toBe("흔한 단어 패널티가 들어간 순위 공식");
  });

  test("빼고 and the 제외 forms are markers too, with a particle on X", () => {
    expect(stripHangulNegation("감사 로그를 빼고 작성자 기록")).toBe("작성자 기록");
    expect(stripHangulNegation("감사 로그를 제외하고 작성자 기록")).toBe("작성자 기록");
    expect(stripHangulNegation("감사 로그를 제외한 작성자 기록")).toBe("작성자 기록");
  });

  test("with several markers the text after the last one wins", () => {
    expect(stripHangulNegation("elo 말고 pagerank 말고 등수 역수 합산")).toBe("등수 역수 합산");
  });

  test("bare 제외 is not a marker: it is also a noun", () => {
    expect(stripHangulNegation("검색 제외 설정 방법")).toBe("검색 제외 설정 방법");
  });

  test("아닌 is not a marker: it also states a condition", () => {
    expect(stripHangulNegation("캐시가 아닌 경우 처리")).toBe("캐시가 아닌 경우 처리");
  });

  test("an empty X or Y returns the query unchanged", () => {
    expect(stripHangulNegation("tf-idf 말고")).toBe("tf-idf 말고");
    expect(stripHangulNegation("말고 순위 공식")).toBe("말고 순위 공식");
  });

  test("a quoted phrase returns the query unchanged", () => {
    expect(stripHangulNegation('"tf-idf 말고" 순위 공식')).toBe('"tf-idf 말고" 순위 공식');
  });

  test("text without a whitespace-delimited marker is unchanged", () => {
    expect(stripHangulNegation("검색 품질을 올리는 방법")).toBe("검색 품질을 올리는 방법");
    expect(stripHangulNegation("not tf-idf but bm25")).toBe("not tf-idf but bm25");
  });

  test("a Y of only -exclusions returns the query unchanged (lex needs a positive term)", () => {
    expect(stripHangulNegation("tf-idf 말고 -bm25")).toBe("tf-idf 말고 -bm25");
  });

  test("a stripped lex query still passes lex validation", () => {
    const stripped = stripHangulNegation("tf-idf 말고 흔한 단어 -불용어");
    expect(stripped).toBe("흔한 단어 -불용어");
    expect(validateLexQuery(stripped)).toBeNull();
  });

  test("deliberate limitation: a marker glued to X is not split", () => {
    expect(stripHangulNegation("이거말고 순위 공식")).toBe("이거말고 순위 공식");
  });
});

describe("hybridQuery expansion for Hangul queries", () => {
  let root: string;
  let store: QMDStore;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "qmd-hangul-expand-"));
    const docs = join(root, "docs");
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, "ko.md"), "# 검색 품질\n\n역색인 구조를 설명한다. tf-idf 대신 BM25 를 쓴다.\n");
    await writeFile(join(docs, "en.md"), "# hybrid search notes\n\nBM25 and vector lists fused with RRF.\n");
    store = await createStore({
      dbPath: join(root, "index.sqlite"),
      config: { collections: { docs: { path: docs, pattern: "**/*.md" } } },
    });
    await store.update();
  });

  afterAll(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  // intent turns the strong-signal bypass off, so only the Hangul rule can skip expansion here.
  const expansionCalls = async (query: string) => {
    const expand = vi.fn(async () => []);
    store.internal.expandQuery = expand;
    await hybridQuery(store.internal, query, { skipRerank: true, intent: "search quality notes" });
    return expand.mock.calls.length;
  };

  test("a Hangul query is searched without LLM expansion", async () => {
    expect(await expansionCalls("검색 품질을 올리는 방법")).toBe(0);
  });

  test("a script-mixed query with Hangul is searched without expansion", async () => {
    expect(await expansionCalls("tf-idf 말고 흔한 단어 패널티")).toBe(0);
  });

  test("a Latin-only query is still expanded", async () => {
    expect(await expansionCalls("hybrid search notes")).toBe(1);
  });
});

describe("structuredSearch weight for a relaxed lex list", () => {
  let root: string;
  let store: QMDStore;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "qmd-hangul-structured-"));
    const docs = join(root, "docs");
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, "ko.md"), "# 검색 품질\n\n역색인 구조를 설명한다.\n");
    store = await createStore({
      dbPath: join(root, "index.sqlite"),
      config: { collections: { docs: { path: docs, pattern: "**/*.md" } } },
    });
    await store.update();
  });

  afterAll(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  const lexWeight = async (query: string) => {
    const results = await structuredSearch(store.internal, [{ type: "lex", query }], { skipRerank: true, explain: true });
    return results[0]?.explain?.rrf.contributions[0]?.weight;
  };

  test("a lex line whose words all match keeps the first-list weight", async () => {
    expect(await lexWeight("검색 품질")).toBe(2.0);
  });

  test("a lex line that only matched through the any-word retry forfeits the first-list boost", async () => {
    expect(await lexWeight("역색인 구조를 설명하는 문서를 찾고 싶다")).toBe(0.25);
  });
});

describe("negation queries through hybridQuery and structuredSearch", () => {
  let root: string;
  let store: QMDStore;
  const vecQueries: string[] = [];
  const rerankQueries: string[] = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "qmd-hangul-negation-"));
    const docs = join(root, "docs");
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, "tf-idf.md"), "# tf-idf\n\n단어 빈도와 역문서 빈도를 곱한다.\n");
    await writeFile(join(docs, "bm25.md"), "# 순위 공식\n\n흔한 단어 패널티가 들어간 순위 공식이다.\n");
    store = await createStore({
      dbPath: join(root, "index.sqlite"),
      config: { collections: { docs: { path: docs, pattern: "**/*.md" } } },
    });
    await store.update();
    // An empty vec table turns the vector path on; the stubs record what each list was asked.
    store.internal.db.exec(`CREATE VIRTUAL TABLE vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[1] distance_metric=cosine)`);
    store.internal.llm = {
      embedModelName: "stub",
      embedBatch: async (texts: string[]) => texts.map(() => ({ embedding: [1] })),
    } as any; // any: mock implements only what the vector path reads
    store.internal.searchVec = vi.fn(async (query: string) => {
      vecQueries.push(query);
      return [];
    });
    store.internal.rerank = vi.fn(async (query: string, documents: { file: string }[]) => {
      rerankQueries.push(query);
      return documents.map((d) => ({ file: d.file, score: 0.5 }));
    });
  });

  afterAll(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  const reset = () => {
    vecQueries.length = 0;
    rerankQueries.length = 0;
  };

  const contributionQueries = (results: Awaited<ReturnType<typeof hybridQuery>>) =>
    [...new Set(results.flatMap((r) => r.explain?.rrf.contributions.map((c) => c.query) ?? []))];

  test("hybridQuery sends only Y to lex, vec and rerank", async () => {
    reset();
    const results = await hybridQuery(store.internal, "tf-idf 말고 흔한 단어 패널티", { explain: true });
    expect(contributionQueries(results)).toEqual(["흔한 단어 패널티"]);
    expect(vecQueries).toEqual(["흔한 단어 패널티"]);
    expect(rerankQueries).toEqual(["흔한 단어 패널티"]);
  });

  test("structuredSearch sends only Y to lex, vec and rerank", async () => {
    reset();
    const results = await structuredSearch(store.internal, [
      { type: "lex", query: "tf-idf 말고 흔한 단어 패널티" },
      { type: "vec", query: "tf-idf 말고 흔한 단어 패널티가 들어간 공식" },
    ], { explain: true });
    expect(contributionQueries(results)).toEqual(["흔한 단어 패널티"]);
    expect(vecQueries).toEqual(["흔한 단어 패널티가 들어간 공식"]);
    expect(rerankQueries).toEqual(["흔한 단어 패널티"]);
  });

  test("structuredSearch leaves hyde passages and intent as written", async () => {
    reset();
    const hyde = "tf-idf 말고 흔한 단어에 패널티를 주는 순위 공식을 설명하는 문서";
    const rerank = vi.fn(store.internal.rerank);
    store.internal.rerank = rerank;
    await structuredSearch(store.internal, [
      { type: "lex", query: "tf-idf 말고 순위 공식" },
      { type: "hyde", query: hyde },
    ], { intent: "tf-idf 말고 다른 공식" });
    expect(vecQueries).toEqual([hyde]);
    expect(rerank.mock.calls[0]?.[0]).toBe("순위 공식");
    expect(rerank.mock.calls[0]?.[3]).toBe("tf-idf 말고 다른 공식");
  });

  test("a query without a marker reaches every list unchanged", async () => {
    reset();
    await hybridQuery(store.internal, "흔한 단어 패널티", {});
    expect(vecQueries).toEqual(["흔한 단어 패널티"]);
    expect(rerankQueries).toEqual(["흔한 단어 패널티"]);
  });
});
