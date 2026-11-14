import { describe, expect, test } from "vitest";
import type { LabelFile } from "../scripts/judge/label.js";
import type { QuerySet } from "../scripts/judge/pool.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, main, reportLines } from "../scripts/judge/report.js";
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
      mode: "listwise",
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
    expect(r.position!.weighted_kappa).toBeGreaterThan(0);
    expect(r.position!.weighted_kappa).toBeLessThan(1);
  });

  test("gold and off-corpus sanity counts read the first pass", () => {
    const r = buildReport(judgments(), querySet);
    expect(r.gold).toEqual({ retrieved: 2, graded_relevant: 1, total: 2 });
    expect(r.off_corpus).toEqual({ graded_zero: 1, total: 1 });
  });

  test("nDCG uses each backend's ranking against the pooled grades, per query set", () => {
    const r = buildReport(judgments(), querySet);
    expect(r.ndcg.goldset!.full!.mean).toBe(1);
    expect(r.ndcg.goldset!.bm25!.mean).toBeLessThan(1);
    expect(r.ndcg.goldset!.bm25!.n).toBe(2);
    expect(r.ndcg.open!.full!.mean).toBe(1);
    expect(r.ndcg_diff.goldset!["full-bm25"]!.delta).toBeGreaterThan(0);
    for (const m of [r.ndcg.goldset!.bm25!, r.ndcg.goldset!.full!]) {
      expect(m.lo).toBeLessThanOrEqual(m.mean);
      expect(m.hi).toBeGreaterThanOrEqual(m.mean);
    }
  });

  test("a query the judge failed on in pass 1 is counted as failed in its set, not dropped silently", () => {
    const j = judgments();
    delete j.passes[0]!.grades.g2;
    j.passes[0]!.errors = { g2: "judge reply invalid twice" };
    const m = buildReport(j, querySet).ndcg.goldset!.bm25!;
    expect(m.n).toBe(1);
    expect(m.failed).toBe(1);
  });

  test("a ranked file without a grade throws: judgments and pools disagree", () => {
    const j = judgments();
    delete j.passes[0]!.grades.g1!["z.md"];
    expect(() => buildReport(j, querySet)).toThrow(/z.md has no grade/);
  });

  test("off-corpus queries are in no nDCG set: they feed only the OFFCORPUS check", () => {
    const r = buildReport(judgments(), querySet);
    expect(r.ndcg.open!.full!.n + r.ndcg.open!.full!.undefined).toBe(1);
    expect(r.ndcg.goldset!.full!.n + r.ndcg.goldset!.full!.undefined).toBe(2);
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
    expect(k.unjudged).toBe(0);
    for (const c of [k.cohen, k.weighted]) {
      expect(c.lo).toBeLessThanOrEqual(c.value);
      expect(c.hi).toBeGreaterThanOrEqual(c.value);
      expect(c.undefined_draws).toBeGreaterThanOrEqual(0);
    }
  });

  test("labels on a query the judge failed on are counted as unjudged", () => {
    const j = judgments();
    delete j.passes[0]!.grades.g2;
    const labels: LabelFile = { description: "", rubric_sha256: "r", labels: { g1: { "a.md": 3, "z.md": 0 }, g2: { "b.md": 2 } } };
    const k = buildReport(j, querySet, labels).kappa;
    expect(k.status === "measured" && k.unjudged).toBe(1);
  });

  test("failed queries are listed with their seed", () => {
    const j = judgments();
    j.passes[1]!.errors = { o1: "judge reply invalid twice" };
    expect(buildReport(j, querySet).errors).toEqual({ "o1@seed2": "judge reply invalid twice" });
  });
});

describe("main", () => {
  function files(labelsSha: string) {
    const dir = mkdtempSync(join(tmpdir(), "judge-report-"));
    const paths = {
      judgments: join(dir, "judgments.json"),
      queries: join(dir, "queries.json"),
      labels: join(dir, "labels.json"),
      out: join(dir, "report.json"),
    };
    writeFileSync(paths.judgments, JSON.stringify(judgments()));
    writeFileSync(paths.queries, JSON.stringify(querySet));
    writeFileSync(paths.labels, JSON.stringify({ description: "", rubric_sha256: labelsSha, labels: { g1: { "a.md": 3, "z.md": 0 } } }));
    return paths;
  }

  test("writes the report JSON it printed", () => {
    const p = files("r");
    expect(main([p.judgments, p.queries, p.labels, p.out])).toBe(0);
    const written = JSON.parse(readFileSync(p.out, "utf8")) as { kappa: { status: string; pairs: number } };
    expect(written.kappa).toMatchObject({ status: "measured", pairs: 2 });
  });

  test("labels made on another rubric exit 2 and write nothing", () => {
    const p = files("other");
    expect(main([p.judgments, p.queries, p.labels, p.out])).toBe(2);
    expect(() => readFileSync(p.out)).toThrow();
  });
});

describe("reportLines", () => {
  test("prints one line per measure, with KAPPA pending before labels", () => {
    const lines = reportLines(buildReport(judgments(), querySet));
    expect(lines[0]).toBe("JUDGE model=m mode=listwise queries=4 pairs=7 seconds=5 errors=0");
    expect(lines.some(l => l.startsWith("POSITION flip=0.143"))).toBe(true);
    expect(lines.some(l => l.startsWith("NDCG set=goldset backend=full mean=1.000"))).toBe(true);
    expect(lines.some(l => l.startsWith("NDCG-DIFF set=goldset full-bm25"))).toBe(true);
    expect(lines.at(-1)).toBe("KAPPA pending labels=0");
  });
});
