import { describe, expect, test } from "vitest";
import { buildRrfTrace, reciprocalRankFusion, type RankedResult, type RRFContributionTrace } from "../src/store";
import { explainGroupLines } from "../src/cli/qmd.ts";

describe("buildRrfTrace", () => {
  test("matches reciprocalRankFusion totals and records per-list contributions", () => {
    const list1: RankedResult[] = [
      { file: "qmd://docs/a.md", displayPath: "docs/a.md", title: "A", body: "", score: 0.92 },
      { file: "qmd://docs/b.md", displayPath: "docs/b.md", title: "B", body: "", score: 0.81 },
    ];
    const list2: RankedResult[] = [
      { file: "qmd://docs/b.md", displayPath: "docs/b.md", title: "B", body: "", score: 0.77 },
      { file: "qmd://docs/a.md", displayPath: "docs/a.md", title: "A", body: "", score: 0.65 },
    ];

    const weights = [2.0, 1.0];
    const traces = buildRrfTrace(
      [list1, list2],
      weights,
      [
        { source: "fts", queryType: "lex", query: "lex query" },
        { source: "vec", queryType: "vec", query: "vec query" },
      ]
    );
    const fused = reciprocalRankFusion([list1, list2], weights);

    for (const result of fused) {
      const trace = traces.get(result.file);
      expect(trace).toBeDefined();
      expect(trace!.totalScore).toBeCloseTo(result.score, 10);
    }

    const aTrace = traces.get("qmd://docs/a.md")!;
    expect(aTrace.contributions).toHaveLength(2);
    expect(aTrace.contributions[0]?.source).toBe("fts");
    expect(aTrace.contributions[1]?.source).toBe("vec");
    expect(aTrace.topRank).toBe(1);
    expect(aTrace.topRankBonus).toBeCloseTo(0.05, 10);
  });

  test("applies top-rank bonus thresholds correctly", () => {
    const list: RankedResult[] = [
      { file: "qmd://docs/r1.md", displayPath: "docs/r1.md", title: "R1", body: "", score: 0.9 },
      { file: "qmd://docs/r2.md", displayPath: "docs/r2.md", title: "R2", body: "", score: 0.8 },
      { file: "qmd://docs/r3.md", displayPath: "docs/r3.md", title: "R3", body: "", score: 0.7 },
      { file: "qmd://docs/r4.md", displayPath: "docs/r4.md", title: "R4", body: "", score: 0.6 },
    ];

    const traces = buildRrfTrace([list], [1.0], [{ source: "fts", queryType: "lex", query: "rank" }]);

    expect(traces.get("qmd://docs/r1.md")?.topRankBonus).toBeCloseTo(0.05, 10);
    expect(traces.get("qmd://docs/r2.md")?.topRankBonus).toBeCloseTo(0.02, 10);
    expect(traces.get("qmd://docs/r3.md")?.topRankBonus).toBeCloseTo(0.02, 10);
    expect(traces.get("qmd://docs/r4.md")?.topRankBonus).toBeCloseTo(0.0, 10);
  });
});

/**
 * `--explain` group ranks.
 *
 * Expansion turns one query into a dozen, fuses their lists and reports one number. A single
 * fused rank cannot distinguish "first in the hyde list and nowhere else" from "middling
 * everywhere", and those two call for different fixes, so the trace has to survive to the
 * output rather than being collapsed into a top-three summary.
 */
describe("explainGroupLines", () => {
  const contribution = (over: Partial<RRFContributionTrace> = {}): RRFContributionTrace => ({
    listIndex: 0,
    source: "fts",
    queryType: "lex",
    query: "tokenizer",
    rank: 1,
    weight: 1,
    backendScore: 0.8,
    rrfContribution: 0.016,
    ...over,
  });

  test("gives every sub-query its own line, not just the top few", () => {
    const lines = explainGroupLines([
      contribution({ rrfContribution: 0.004, queryType: "hyde", source: "vec" }),
      contribution({ rrfContribution: 0.016 }),
      contribution({ rrfContribution: 0.008, queryType: "vec", source: "vec" }),
      contribution({ rrfContribution: 0.002, queryType: "original" }),
    ]);
    expect(lines).toHaveLength(5);   // one header, four sub-queries
    expect(lines[0]).toContain("4 of the expansion's lists");
  });

  test("orders by contribution, so what earned the score reads first", () => {
    const lines = explainGroupLines([
      contribution({ rrfContribution: 0.002, queryType: "original" }),
      contribution({ rrfContribution: 0.016, queryType: "lex" }),
    ]);
    expect(lines[1]).toContain("fts/lex");
    expect(lines[2]).toContain("fts/original");
  });

  test("keeps each sub-query's own rank, which the fused rank cannot show", () => {
    const lines = explainGroupLines([
      contribution({ rank: 1, queryType: "hyde", source: "vec", rrfContribution: 0.016 }),
      contribution({ rank: 37, queryType: "lex", rrfContribution: 0.010 }),
    ]);
    expect(lines[1]).toContain("#1");
    expect(lines[2]).toContain("#37");
  });

  test("shows the sub-query text, so a score reads back to the query that earned it", () => {
    const lines = explainGroupLines([contribution({ query: "how does the tokenizer split Hangul" })]);
    expect(lines[1]).toContain("how does the tokenizer split Hangul");
  });

  test("truncates a hyde paragraph instead of wrapping the terminal", () => {
    const lines = explainGroupLines([contribution({ query: "x".repeat(200), queryType: "hyde" })]);
    expect(lines[1]!.length).toBeLessThan(120);
    expect(lines[1]).toContain("...");
  });

  test("collapses newlines — a hyde sub-query is a paragraph", () => {
    const lines = explainGroupLines([contribution({ query: "first line\nsecond line" })]);
    expect(lines[1]).toContain("first line second line");
    expect(lines[1]).not.toContain("\n");
  });

  test("a document no list placed produces nothing rather than an empty header", () => {
    expect(explainGroupLines([])).toEqual([]);
  });
});
