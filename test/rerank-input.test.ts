/**
 * rerank-input.test.ts - what the reranker is shown: the query string (also the rerank cache key),
 * which chunk of a document is sent, and the document text built from it.
 */

import { describe, test, expect } from "vitest";
import {
  FIRST_CHUNK_HEAD_START,
  FIRST_CHUNK_HEAD_START_WITH_INTENT,
  formatRerankDoc,
  formatRerankQuery,
  rerankChunkScorer,
  selectRerankChunk,
} from "../src/rerank-input.js";

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

describe("rerankChunkScorer", () => {
  test("a non-Hangul query word longer than two characters counts two points, case-insensitively", () => {
    expect(rerankChunkScorer("BM25 ranking of", [])("bm25 RANKING formula")).toBe(4);
  });

  test("a Hangul query matches by syllable bigrams, so a particle-suffixed word finds its stem", () => {
    expect(rerankChunkScorer("임베딩은 어떻게", [])("임베딩 모델을 바꾼다")).toBe(2);
  });

  test("a Hangul word of two syllables does not count", () => {
    expect(rerankChunkScorer("방법", [])("방법 목록")).toBe(0);
  });

  test("an intent word counts one point, half a non-Hangul query word", () => {
    expect(rerankChunkScorer("ranking", ["latency"])("latency ranking")).toBe(3);
  });
});

describe("selectRerankChunk", () => {
  const many = "alpha beta gamma delta epsilon zeta eta theta iota";

  test("the first chunk wins unless a later one out-scores it by the head start", () => {
    // Nine words = 18 points against the first chunk's head start of 16.
    expect(selectRerankChunk(chunks("intro", many), many, [])).toBe(1);
    expect(selectRerankChunk(chunks("intro", "alpha beta gamma delta"), many, [])).toBe(0);
    expect(FIRST_CHUNK_HEAD_START).toBe(16);
  });

  test("with intent the head start is halved, so intent words can steer to a later chunk", () => {
    const intent = ["latency", "budget", "cost", "throughput", "memory"];
    // ranking (2) + five intent words (5) = 7 stays under the halved head start of 8; alpha (2) more makes 9.
    expect(selectRerankChunk(chunks("intro", `ranking latency budget cost throughput memory`), "ranking", intent)).toBe(0);
    expect(selectRerankChunk(chunks("intro", `ranking alpha latency budget cost throughput memory`), "ranking alpha", intent)).toBe(1);
    expect(FIRST_CHUNK_HEAD_START_WITH_INTENT).toBe(8);
  });

  test("a tie keeps the earlier chunk, and no match picks the first", () => {
    expect(selectRerankChunk(chunks("alpha", "beta"), "gamma", [])).toBe(0);
    expect(selectRerankChunk(chunks("intro", "x", many), many, [])).toBe(2);
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

  test("strips a long CRLF frontmatter block, leaving the body", () => {
    const bare = { ...meta, title: "" };
    expect(formatRerankDoc(`---\r\n${"x".repeat(390)}\r\n---\r\nBODY`, bare)).toBe("BODY");
  });

  test("strips a frontmatter block larger than 4000 chars, leaving the body", () => {
    const bare = { ...meta, title: "" };
    expect(formatRerankDoc(`---\n${"y".repeat(4990)}\n---\nBODY`, bare)).toBe("BODY");
  });

  test("keeps a frontmatter block of exactly 350 chars, strips one of 351", () => {
    const bare = { ...meta, title: "" };
    const block350 = `---\n${"s".repeat(341)}\n---\n`;
    expect(block350.length).toBe(350);
    expect(formatRerankDoc(`${block350}BODY`, bare)).toBe(`${block350}BODY`);
    expect(formatRerankDoc(`---\n${"z".repeat(342)}\n---\nBODY`, bare)).toBe("BODY");
  });
});
