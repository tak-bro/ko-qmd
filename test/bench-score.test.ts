/**
 * Tests for the benchmark scoring functions.
 */

import { describe, test, expect } from "vitest";
import { normalizePath, pathsMatch, scoreResults } from "../src/bench/score.js";
import { computeHardSummary, computeSummaryByType } from "../src/bench/bench.js";
import type { QueryResult, BackendResult } from "../src/bench/types.js";

describe("normalizePath", () => {
  test("lowercases path", () => {
    expect(normalizePath("Resources/Concepts/Context Engineering.md"))
      .toBe("resources/concepts/context engineering.md");
  });

  test("strips qmd:// prefix", () => {
    expect(normalizePath("qmd://collection/docs/readme.md"))
      .toBe("docs/readme.md");
  });

  test("strips leading/trailing slashes", () => {
    expect(normalizePath("/docs/readme.md/")).toBe("docs/readme.md");
  });

  test("handles plain filename", () => {
    expect(normalizePath("readme.md")).toBe("readme.md");
  });
});

describe("pathsMatch", () => {
  test("exact match", () => {
    expect(pathsMatch("docs/readme.md", "docs/readme.md")).toBe(true);
  });

  test("case-insensitive match", () => {
    expect(pathsMatch("Docs/README.md", "docs/readme.md")).toBe(true);
  });

  test("suffix match (result is longer)", () => {
    expect(pathsMatch("/full/path/docs/readme.md", "docs/readme.md")).toBe(true);
  });

  test("suffix match (expected is longer)", () => {
    expect(pathsMatch("readme.md", "docs/readme.md")).toBe(true);
  });

  test("qmd:// prefix handled", () => {
    expect(pathsMatch("qmd://col/docs/readme.md", "docs/readme.md")).toBe(true);
  });

  test("different files don't match", () => {
    expect(pathsMatch("docs/readme.md", "docs/other.md")).toBe(false);
  });
});

describe("scoreResults", () => {
  test("perfect score: all expected in top-k", () => {
    const result = scoreResults(
      ["a.md", "b.md", "c.md"],
      ["a.md", "b.md"],
      2,
    );
    expect(result.precision_at_k).toBe(1);
    expect(result.recall).toBe(1);
    expect(result.mrr).toBe(1);
    expect(result.f1).toBe(1);
    expect(result.hits_at_k).toBe(2);
  });

  test("zero score: none found", () => {
    const result = scoreResults(
      ["x.md", "y.md", "z.md"],
      ["a.md", "b.md"],
      2,
    );
    expect(result.precision_at_k).toBe(0);
    expect(result.recall).toBe(0);
    expect(result.mrr).toBe(0);
    expect(result.f1).toBe(0);
    expect(result.hits_at_k).toBe(0);
  });

  test("partial: found outside top-k", () => {
    const result = scoreResults(
      ["x.md", "y.md", "a.md"],
      ["a.md"],
      1,
    );
    expect(result.precision_at_k).toBe(0); // not in top-1
    expect(result.recall).toBe(1); // found somewhere
    expect(result.mrr).toBeCloseTo(1 / 3); // rank 3
    expect(result.hits_at_k).toBe(0);
  });

  test("MRR: first relevant at rank 2", () => {
    const result = scoreResults(
      ["x.md", "a.md", "b.md"],
      ["a.md", "b.md"],
      3,
    );
    expect(result.mrr).toBeCloseTo(0.5); // 1/2
  });

  test("reports recall@1/3/5 and matched documents", () => {
    const result = scoreResults(
      ["x.md", "qmd://concepts/a.md", "docs/b.md", "docs/c.md", "docs/d.md"],
      ["concepts/a.md", "b.md", "missing.md"],
      3,
    );

    expect(result.recall_at_1).toBe(0);
    expect(result.recall_at_3).toBeCloseTo(2 / 3);
    expect(result.recall_at_5).toBeCloseTo(2 / 3);
    expect(result.matched_files).toEqual(["concepts/a.md", "b.md"]);
    expect(result.unmatched_expected_files).toEqual(["missing.md"]);
  });

  test("empty results", () => {
    const result = scoreResults([], ["a.md"], 1);
    expect(result.precision_at_k).toBe(0);
    expect(result.recall).toBe(0);
    expect(result.mrr).toBe(0);
  });

  test("empty expected", () => {
    const result = scoreResults(["a.md"], [], 1);
    expect(result.precision_at_k).toBe(0);
    expect(result.recall).toBe(0);
  });
});

const qr = (id: string, type: string, backends: Record<string, Pick<BackendResult, "recall_at_1" | "mrr">>): QueryResult => ({
  id,
  query: id,
  type,
  backends: Object.fromEntries(
    Object.entries(backends).map(([name, b]) => [
      name,
      {
        precision_at_k: 0,
        recall: 0,
        recall_at_1: b.recall_at_1,
        recall_at_3: 0,
        recall_at_5: 0,
        mrr: b.mrr,
        f1: 0,
        hits_at_k: 0,
        total_expected: 1,
        latency_ms: 0,
        top_files: [],
        matched_files: [],
        unmatched_expected_files: [],
      },
    ])
  ),
});

describe("computeSummaryByType", () => {
  test("per-type recall@1/MRR per backend with query count", () => {
    const results: QueryResult[] = [
      qr("q1", "sem-hard", { bm25: { recall_at_1: 1, mrr: 1 } }),
      qr("q2", "sem-hard", { bm25: { recall_at_1: 0, mrr: 0.5 } }),
      qr("q3", "neg", { bm25: { recall_at_1: 0, mrr: 0 }, hybrid: { recall_at_1: 1, mrr: 1 } }),
    ];
    const byType = computeSummaryByType(results);
    expect(byType["sem-hard"]!["bm25"]).toMatchObject({ avg_recall_at_1: 0.5, avg_mrr: 0.75, count: 2 });
    expect(byType["neg"]!["bm25"]).toMatchObject({ avg_recall_at_1: 0, avg_mrr: 0, count: 1 });
    expect(byType["neg"]!["hybrid"]).toMatchObject({ avg_recall_at_1: 1, avg_mrr: 1, count: 1 });
    expect(byType["sem-hard"]!["hybrid"]).toBeUndefined();
  });

  test("a type with zero queries has no entry, so pooling sees no NaN", () => {
    const results: QueryResult[] = [
      qr("q1", "sem-hard", { bm25: { recall_at_1: 1, mrr: 1 } }),
    ];
    const byType = computeSummaryByType(results);
    expect(byType["multi"]).toBeUndefined();
    expect(byType["neg"]).toBeUndefined();
    for (const backends of Object.values(byType)) {
      for (const s of Object.values(backends)) {
        for (const v of Object.values(s)) {
          expect(Number.isFinite(v)).toBe(true);
        }
      }
    }
  });

  test("empty results yield empty summary_by_type", () => {
    expect(computeSummaryByType([])).toEqual({});
  });
});

describe("computeHardSummary", () => {
  test("pools the hard types weighted by query count, ignoring other types", () => {
    const byType = computeSummaryByType([
      qr("s1", "sem-hard", { hybrid: { recall_at_1: 1, mrr: 1 }, full: { recall_at_1: 1, mrr: 1 } }),
      qr("s2", "sem-hard", { hybrid: { recall_at_1: 1, mrr: 1 }, full: { recall_at_1: 1, mrr: 1 } }),
      qr("s3", "sem-hard", { hybrid: { recall_at_1: 1, mrr: 1 }, full: { recall_at_1: 1, mrr: 1 } }),
      qr("n1", "neg", { hybrid: { recall_at_1: 0, mrr: 0.5 }, full: { recall_at_1: 0, mrr: 0.5 } }),
      qr("e1", "exact", { hybrid: { recall_at_1: 0, mrr: 0 }, full: { recall_at_1: 0, mrr: 0 } }),
    ]);
    // 3 sem-hard at 1.0 and 1 neg at 0.0 → 0.75, not the unweighted per-type mean 0.5
    expect(computeHardSummary(byType)).toEqual({
      hybrid_r1: 0.75, hybrid_mrr: 0.875, full_r1: 0.75, full_mrr: 0.875, n: 4,
    });
  });

  test("a missing hard type is skipped, not counted as zero", () => {
    const byType = computeSummaryByType([
      qr("m1", "multi", { hybrid: { recall_at_1: 0.5, mrr: 1 }, full: { recall_at_1: 0.5, mrr: 1 } }),
    ]);
    expect(computeHardSummary(byType)).toMatchObject({ hybrid_r1: 0.5, full_mrr: 1, n: 1 });
  });

  test("no hard queries yields nulls and n=0", () => {
    const byType = computeSummaryByType([qr("e1", "exact", { hybrid: { recall_at_1: 1, mrr: 1 } })]);
    expect(computeHardSummary(byType)).toEqual({
      hybrid_r1: null, hybrid_mrr: null, full_r1: null, full_mrr: null, n: 0,
    });
    expect(computeHardSummary({})).toMatchObject({ n: 0, hybrid_r1: null });
  });

  test("a backend missing from one hard type pools over the types that have it", () => {
    const byType = computeSummaryByType([
      qr("s1", "sem-hard", { hybrid: { recall_at_1: 1, mrr: 1 } }),
      qr("n1", "neg", { hybrid: { recall_at_1: 0, mrr: 0 }, full: { recall_at_1: 1, mrr: 1 } }),
    ]);
    expect(computeHardSummary(byType)).toMatchObject({ hybrid_r1: 0.5, full_r1: 1, n: 2 });
  });
});
