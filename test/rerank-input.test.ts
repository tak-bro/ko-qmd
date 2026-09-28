/**
 * rerank-input.test.ts - what the reranker is shown: the query string (also the rerank cache key),
 * which chunk of a document is sent, and the document text built from it.
 */

import { describe, test, expect } from "vitest";
import { formatRerankDoc, formatRerankQuery, selectRerankChunk } from "../src/rerank-input.js";

const chunks = (...texts: string[]) => texts.map((text, i) => ({ text, pos: i * 100 }));

describe("formatRerankQuery", () => {
  test("prepends intent with a blank line", () => {
    expect(formatRerankQuery("순위 공식", "search ranking")).toBe("search ranking\n\n순위 공식");
  });

  test("is the query alone without intent", () => {
    expect(formatRerankQuery("순위 공식")).toBe("순위 공식");
    expect(formatRerankQuery("순위 공식", "")).toBe("순위 공식");
  });
});

describe("selectRerankChunk", () => {
  test("picks the chunk with the most query words, case-insensitively", () => {
    expect(selectRerankChunk(chunks("intro text", "BM25 ranking formula", "ranking only"), "bm25 ranking", [])).toBe(1);
  });

  test("ignores query words of two characters or fewer", () => {
    expect(selectRerankChunk(chunks("an of to", "tokenizer notes"), "an of tokenizer", [])).toBe(1);
  });

  test("an intent word counts a quarter of an ASCII query word", () => {
    expect(selectRerankChunk(chunks("latency budget x y z", "ranking formula"), "ranking", ["latency", "budget", "x", "y", "z"])).toBe(0);
    expect(selectRerankChunk(chunks("latency budget", "ranking"), "ranking", ["latency", "budget"])).toBe(1);
  });

  test("a Hangul query matches by syllable bigrams, so a particle-suffixed word finds its stem", () => {
    expect(selectRerankChunk(chunks("서론", "임베딩 모델을 바꾼다"), "임베딩은 어떻게", [])).toBe(1);
  });

  test("a Hangul word of two syllables does not count", () => {
    expect(selectRerankChunk(chunks("다른 내용", "방법 목록"), "방법", [])).toBe(0);
  });

  test("an ASCII query word outweighs one Hangul bigram", () => {
    expect(selectRerankChunk(chunks("임베 설명", "bm25 설명"), "bm25 임베딩", [])).toBe(1);
  });

  test("a tie keeps the earlier chunk, and no match picks the first", () => {
    expect(selectRerankChunk(chunks("ranking a", "ranking b"), "ranking", [])).toBe(0);
    expect(selectRerankChunk(chunks("alpha", "beta"), "gamma", [])).toBe(0);
  });
});

describe("formatRerankDoc", () => {
  const meta = { file: "wiki/a.md", title: "제목", displayPath: "wiki/a.md" };

  test("leads a chunk that lacks the title with it", () => {
    expect(formatRerankDoc("본문 청크", meta)).toBe("# 제목\n\n본문 청크");
  });

  test("sends a chunk that already holds the title, or a titleless note, unchanged", () => {
    expect(formatRerankDoc("# 제목\n본문", meta)).toBe("# 제목\n본문");
    expect(formatRerankDoc("본문 청크", { ...meta, title: "" })).toBe("본문 청크");
  });
});
