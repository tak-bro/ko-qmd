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

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type QMDStore } from "../src/index.js";
import { normalizeCjkForFTS } from "../src/store.js";
import {
  hangulBigramTail,
  hangulMixedQuery,
  hangulStems,
  hangulTermQuery,
  sharesHangulBigram,
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

describe("searchLex with Hangul particles", () => {
  let root: string;
  let store: QMDStore;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "qmd-hangul-query-"));
    const docs = join(root, "docs");
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, "ko.md"), "# 검색 품질\n\n역색인 구조를 설명한다. qmd 색인은 FTS5 위에서 돈다.\n");
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
