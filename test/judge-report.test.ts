import { describe, expect, test } from "vitest";
import type { LabelFile } from "../scripts/judge/label.js";
import type { QuerySet } from "../scripts/judge/pool.js";
import { buildReport, reportLines } from "../scripts/judge/report.js";
import type { Judgments } from "../scripts/judge/run.js";

const querySet: QuerySet = {
  description: "",
  queries: [
    { id: "g1", query: "a", type: "exact", expected_files: ["a.md"] },
    { id: "g2", query: "b", type: "alias", expected_files: ["b.md"] },
    { id: "o1", query: "c", type: "open", expected_files: [] },
    { id: "x1", query: "pasta", type: "off-corpus", expected_files: [] },
  ],
};
function judgments(): Judgments {
  return {
    description: "",
    conditions: {
      model: "m",
      commit: "c",
      date: "d",
      os: "o",
      cpu: "p",
      rubric_sha256: "r",
      backends: ["bm25", "full"],
      k: 10,
      seeds: [1, 2],
      seconds: 5,
    },
    pools: [
      { id: "g1", query: "a", files: ["a.md", "z.md"], rankings: { bm25: ["z.md", "a.md"], full: ["a.md", "z.md"] } },
      { id: "g2", query: "b", files: ["b.md", "z.md"], rankings: { bm25: ["b.md", "z.md"], full: ["b.md", "z.md"] } },
      { id: "o1", query: "c", files: ["c.md", "z.md"], rankings: { bm25: ["z.md", "c.md"], full: ["c.md", "z.md"] } },
      { id: "x1", query: "pasta", files: ["z.md"], rankings: { bm25: ["z.md"], full: ["z.md"] } },
    ],
    passes: [
      {
        seed: 1,
        grades: { g1: { "a.md": 3, "z.md": 0 }, g2: { "b.md": 1, "z.md": 0 }, o1: { "c.md": 2, "z.md": 1 }, x1: { "z.md": 0 } },
        errors: {},
      },
      {
        seed: 2,
        grades: { g1: { "a.md": 3, "z.md": 1 }, g2: { "b.md": 1, "z.md": 0 }, o1: { "c.md": 2, "z.md": 1 }, x1: { "z.md": 0 } },
        errors: {},
      },
    ],
  };
}

describe("buildReport", () => {
  test("position flips count grades that changed between the two passes", () => {
    const r = buildReport(judgments(), querySet);
    expect(r.position).toMatchObject({ pairs: 7, flip_rate: 1 / 7 });
  });

  test("gold and off-corpus sanity counts read the first pass", () => {
    const r = buildReport(judgments(), querySet);
    expect(r.gold).toEqual({ graded_relevant: 1, total: 2 });
    expect(r.off_corpus).toEqual({ graded_zero: 1, total: 1 });
  });

  test("nDCG uses each backend's ranking against the pooled grades, per query set", () => {
    const r = buildReport(judgments(), querySet);
    expect(r.ndcg.goldset!.full!.mean).toBe(1);
    expect(r.ndcg.goldset!.bm25!.mean).toBeLessThan(1);
    expect(r.ndcg.goldset!.bm25!.n).toBe(2);
    expect(r.ndcg.open!.full!.mean).toBe(1);
    expect(r.ndcg_diff.goldset!["full-bm25"]!.delta).toBeGreaterThan(0);
  });

  test("an off-corpus pool with nothing relevant is undefined, not 0, and left out of no set", () => {
    const r = buildReport(judgments(), querySet);
    // x1 is in neither set: it is the OFFCORPUS check, not an nDCG query.
    expect(r.ndcg.open!.full!.n + r.ndcg.open!.full!.undefined).toBe(1);
  });

  test("kappa is pending without labels and measured against them", () => {
    expect(buildReport(judgments(), querySet).kappa).toEqual({ status: "pending", labels: 0 });
    const labels: LabelFile = {
      description: "",
      rubric_sha256: "r",
      labels: { g1: { "a.md": 3, "z.md": 0 }, g2: { "b.md": 2, "z.md": 0 } },
    };
    const k = buildReport(judgments(), querySet, labels).kappa;
    expect(k.status).toBe("measured");
    if (k.status !== "measured") return;
    expect(k.pairs).toBe(4);
    expect(k.queries).toBe(2);
    expect(k.exact_agreement).toBe(0.75);
    expect(k.confusion[2]![1]).toBe(1);
    expect(k.weighted.value).toBeGreaterThan(k.cohen.value);
  });

  test("failed queries are listed with their seed", () => {
    const j = judgments();
    j.passes[1]!.errors = { o1: "judge reply invalid twice" };
    expect(buildReport(j, querySet).errors).toEqual({ "o1@seed2": "judge reply invalid twice" });
  });
});

describe("reportLines", () => {
  test("prints one line per measure, with KAPPA pending before labels", () => {
    const lines = reportLines(buildReport(judgments(), querySet));
    expect(lines[0]).toBe("JUDGE model=m queries=4 pairs=7 seconds=5 errors=0");
    expect(lines.some(l => l.startsWith("POSITION flip=0.143"))).toBe(true);
    expect(lines.some(l => l.startsWith("NDCG set=goldset backend=full mean=1.000"))).toBe(true);
    expect(lines.some(l => l.startsWith("NDCG-DIFF set=goldset full-bm25"))).toBe(true);
    expect(lines.at(-1)).toBe("KAPPA pending labels=0");
  });
});
