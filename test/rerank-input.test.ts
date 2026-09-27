/**
 * rerank-input.test.ts - what the reranker is shown. Pins the behaviour both search paths had
 * inline before it moved to src/rerank-input.ts: the query string (also the rerank cache key),
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

  test("an intent word counts half a query word", () => {
    expect(selectRerankChunk(chunks("latency budget", "ranking formula"), "ranking", ["latency", "budget"])).toBe(0);
    expect(selectRerankChunk(chunks("latency", "ranking"), "ranking", ["latency"])).toBe(1);
  });

  test("a tie keeps the earlier chunk, and no match picks the first", () => {
    expect(selectRerankChunk(chunks("ranking a", "ranking b"), "ranking", [])).toBe(0);
    expect(selectRerankChunk(chunks("alpha", "beta"), "gamma", [])).toBe(0);
  });
});

describe("formatRerankDoc", () => {
  test("sends the chunk text unchanged", () => {
    expect(formatRerankDoc("본문 청크", { file: "wiki/a.md", title: "제목", displayPath: "wiki/a.md" })).toBe("본문 청크");
  });
});
