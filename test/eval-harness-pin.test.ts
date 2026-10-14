/**
 * Pin the model-free parts of test/eval-harness.ts.
 *
 * The harness is a manual script (`bun test/eval-harness.ts`); no .test.ts
 * imported it, so its catch→[] silent failures and Hit@1/3/5 aggregation
 * were unpinned. These tests lock the current behavior with stubbed exec
 * functions — no model download, no index, no subprocess.
 */

import { describe, test, expect } from "vitest";
import {
  escapeQuery,
  findFirstHitRank,
  scoreQueries,
  emptyScores,
  runSearch,
  runQuery,
  evalQueries,
  type EvalQuery,
  type SearchResult,
  type SearchRunner,
} from "./eval-harness.js";

function makeResult(file: string): SearchResult {
  return { file, score: 1, title: file };
}

describe("escapeQuery pins current quote handling", () => {
  test("plain query passes through", () => {
    expect(escapeQuery("API versioning")).toBe("API versioning");
  });

  test("double quotes are backslash-escaped", () => {
    expect(escapeQuery('say "hi"')).toBe('say \\"hi\\"');
  });

  test("multiple quotes each escaped", () => {
    expect(escapeQuery('"a" "b"')).toBe('\\"a\\" \\"b\\"');
  });

  test("empty query stays empty (no validation throw)", () => {
    expect(escapeQuery("")).toBe("");
  });

  test("single quotes are left alone", () => {
    expect(escapeQuery("it's")).toBe("it's");
  });
});

describe("findFirstHitRank pins current matching", () => {
  test("returns -1 for empty results", () => {
    expect(findFirstHitRank([], "api-design")).toBe(-1);
  });

  test("hit at rank 1", () => {
    const results = [makeResult("api-design.md"), makeResult("other.md")];
    expect(findFirstHitRank(results, "api-design")).toBe(1);
  });

  test("hit at later rank", () => {
    const results = [
      makeResult("a.md"),
      makeResult("b.md"),
      makeResult("observability.md"),
    ];
    expect(findFirstHitRank(results, "observability")).toBe(3);
  });

  test("miss returns -1", () => {
    const results = [makeResult("a.md"), makeResult("b.md")];
    expect(findFirstHitRank(results, "api-design")).toBe(-1);
  });

  test("file match is case-insensitive", () => {
    const results = [makeResult("API-DESIGN.md")];
    expect(findFirstHitRank(results, "api-design")).toBe(1);
  });

  test("expectedDoc keeps current case sensitivity (uppercase misses)", () => {
    const results = [makeResult("api-design.md")];
    expect(findFirstHitRank(results, "API-DESIGN")).toBe(-1);
  });

  test("first match wins", () => {
    const results = [makeResult("api-design-v1.md"), makeResult("api-design-v2.md")];
    expect(findFirstHitRank(results, "api-design")).toBe(1);
  });

  test("rank beyond 5 is still reported (cutoff lives in aggregation)", () => {
    const results = [
      makeResult("a.md"),
      makeResult("b.md"),
      makeResult("c.md"),
      makeResult("d.md"),
      makeResult("e.md"),
      makeResult("api-design.md"),
    ];
    expect(findFirstHitRank(results, "api-design")).toBe(6);
  });
});

describe("scoreQueries pins current aggregation math", () => {
  function runnerFor(rankByQuery: Record<string, number>, expectedDoc: string): SearchRunner {
    return (_query: string) => {
      const rank = rankByQuery[_query] ?? -1;
      if (rank < 1) return [];
      const out: SearchResult[] = [];
      for (let i = 1; i < rank; i++) out.push(makeResult(`miss-${i}.md`));
      out.push(makeResult(`${expectedDoc}.md`));
      return out;
    };
  }

  function singleQuery(difficulty: EvalQuery["difficulty"]): EvalQuery[] {
    return [{ query: "q", expectedDoc: "doc", difficulty, description: "d" }];
  }

  test("all miss still bumps total", () => {
    const scores = scoreQueries(singleQuery("easy"), () => []);
    expect(scores.easy.total).toBe(1);
    expect(scores.easy.hit1).toBe(0);
    expect(scores.easy.hit3).toBe(0);
    expect(scores.easy.hit5).toBe(0);
  });

  test("rank 1 counts toward hit1/hit3/hit5", () => {
    const scores = scoreQueries(singleQuery("easy"), runnerFor({ q: 1 }, "doc"));
    expect(scores.easy).toEqual({ total: 1, hit1: 1, hit3: 1, hit5: 1 });
  });

  test("rank 3 counts toward hit3/hit5 but not hit1", () => {
    const scores = scoreQueries(singleQuery("medium"), runnerFor({ q: 3 }, "doc"));
    expect(scores.medium).toEqual({ total: 1, hit1: 0, hit3: 1, hit5: 1 });
  });

  test("rank 5 counts toward hit5 only", () => {
    const scores = scoreQueries(singleQuery("hard"), runnerFor({ q: 5 }, "doc"));
    expect(scores.hard).toEqual({ total: 1, hit1: 0, hit3: 0, hit5: 1 });
  });

  test("rank 6 counts toward total only", () => {
    const scores = scoreQueries(singleQuery("fusion"), runnerFor({ q: 6 }, "doc"));
    expect(scores.fusion).toEqual({ total: 1, hit1: 0, hit3: 0, hit5: 0 });
  });

  test("buckets stay per difficulty", () => {
    const queries: EvalQuery[] = [
      { query: "e1", expectedDoc: "doc", difficulty: "easy", description: "d" },
      { query: "m1", expectedDoc: "doc", difficulty: "medium", description: "d" },
    ];
    const runFn: SearchRunner = (query: string) =>
      query === "e1" ? [makeResult("doc.md")] : [];
    const scores = scoreQueries(queries, runFn);
    expect(scores.easy.hit1).toBe(1);
    expect(scores.medium.total).toBe(1);
    expect(scores.medium.hit1).toBe(0);
    expect(scores.hard.total).toBe(0);
  });

  test("empty query list yields zero totals", () => {
    expect(scoreQueries([], () => [])).toEqual(emptyScores());
  });
});

describe("runSearch/runQuery silent-failure paths with stubbed exec", () => {
  test("runSearch returns parsed JSON on success", () => {
    const payload = [makeResult("api-design.md")];
    const execStub = (_command: string, _options: { encoding: string; timeout: number }) =>
      JSON.stringify(payload);
    expect(runSearch("API versioning", execStub)).toEqual(payload);
  });

  test("runSearch returns [] when exec throws", () => {
    const failing = (_command: string, _options: { encoding: string; timeout: number }): string => {
      throw new Error("boom");
    };
    expect(runSearch("API versioning", failing)).toEqual([]);
  });

  test("runSearch returns [] on invalid JSON", () => {
    const badJson = () => "not-json{{{";
    expect(runSearch("API versioning", badJson)).toEqual([]);
  });

  test("runQuery returns parsed JSON on success", () => {
    const payload = [makeResult("fundraising.md")];
    const execStub = () => JSON.stringify(payload);
    expect(runQuery("raising money", execStub)).toEqual(payload);
  });

  test("runQuery returns [] when exec throws", () => {
    const failing = (): string => {
      throw new Error("timeout");
    };
    expect(runQuery("raising money", failing)).toEqual([]);
  });

  test("runQuery returns [] on invalid JSON", () => {
    const badJson = () => "";
    expect(runQuery("raising money", badJson)).toEqual([]);
  });

  test("runSearch builds a search command with escaped quotes", () => {
    let seen = "";
    const capture = (command: string) => {
      seen = command;
      return "[]";
    };
    runSearch('say "hi"', capture);
    expect(seen).toContain("search");
    expect(seen).toContain('say \\"hi\\"');
    expect(seen).toContain("--json -n 5");
  });

  test("runQuery builds a query command with escaped quotes", () => {
    let seen = "";
    const capture = (command: string) => {
      seen = command;
      return "[]";
    };
    runQuery('say "hi"', capture);
    expect(seen).toContain("query");
    expect(seen).toContain('say \\"hi\\"');
  });

  test("empty query still invokes exec (no input validation)", () => {
    let calls = 0;
    const counting = () => {
      calls++;
      return "[]";
    };
    expect(runSearch("", counting)).toEqual([]);
    expect(calls).toBe(1);
  });
});

describe("evalQueries fixture sanity", () => {
  test("holds 32 queries, 8 per difficulty", () => {
    expect(evalQueries).toHaveLength(32);
    for (const difficulty of ["easy", "medium", "hard", "fusion"] as const) {
      expect(evalQueries.filter((item) => item.difficulty === difficulty)).toHaveLength(8);
    }
  });

  test("every entry has a non-empty expectedDoc and description", () => {
    for (const item of evalQueries) {
      expect(item.expectedDoc.length).toBeGreaterThan(0);
      expect(item.description.length).toBeGreaterThan(0);
      expect(item.query.length).toBeGreaterThan(0);
    }
  });
});
