/**
 * Lex CI gate verdict (src/bench/gate.ts).
 *
 * The gate compares per-query recall@5 and reciprocal rank against a committed
 * baseline with a seeded paired bootstrap. Only a drop whose 95% interval
 * stays below zero fails; a drop the interval cannot tell from query-sampling
 * luck warns and names the queries.
 */

import { describe, test, expect } from "vitest";
import {
  compareToBaseline,
  meanPerQuery,
  noiseAcrossRuns,
  pairedBootstrap,
  perQueryMetrics,
  type ComparedVerdict,
  type GateVerdict,
  type PerQuery,
} from "../src/bench/gate.js";
import type { BenchmarkResult } from "../src/bench/types.js";

function uniform(n: number, r5: number, rr: number): PerQuery {
  const out: PerQuery = {};
  for (let i = 0; i < n; i++) out[`q${i}`] = { r5, rr };
  return out;
}

describe("pairedBootstrap", () => {
  test("the same seed gives the same interval", () => {
    const deltas = [0, -1, 0.5, 0, 0, -0.5, 1, 0, -1, 0];
    const a = pairedBootstrap(deltas, { seed: 7 });
    const b = pairedBootstrap(deltas, { seed: 7 });
    expect(a).toEqual(b);
    expect(a.lo).toBeLessThanOrEqual(a.mean);
    expect(a.hi).toBeGreaterThanOrEqual(a.mean);
  });

  test("all-zero deltas give a zero-width interval at zero", () => {
    expect(pairedBootstrap([0, 0, 0, 0], { seed: 1 })).toEqual({ mean: 0, lo: 0, hi: 0 });
  });

  test("an empty delta list throws instead of reporting a zero mean", () => {
    expect(() => pairedBootstrap([], { seed: 1 })).toThrow(/no queries/);
  });
});

function compared(v: GateVerdict): ComparedVerdict {
  if (v.kind !== "compared") throw new Error(`expected a compared verdict, got ${v.kind}: ${v.reason}`);
  return v;
}

describe("compareToBaseline", () => {
  test("identical results pass", () => {
    const base = uniform(100, 1, 1);
    const v = compared(compareToBaseline(base, structuredClone(base)));
    expect(v.status).toBe("PASS");
    expect(v.dropped).toEqual([]);
    expect(v.r5).toMatchObject({ delta: 0, lo: 0, hi: 0 });
  });

  test("a single dropped query warns and names it, since the interval still reaches zero", () => {
    const base = uniform(100, 1, 1);
    const cur = structuredClone(base);
    cur.q3 = { r5: 0, rr: 0 };
    const v = compared(compareToBaseline(base, cur));
    expect(v.status).toBe("WARN");
    expect(v.r5.hi).toBe(0);
    expect(v.dropped.map(d => d.id)).toEqual(["q3"]);
  });

  test("a broad drop fails on the interval's upper bound", () => {
    const base = uniform(100, 1, 1);
    const cur = structuredClone(base);
    for (let i = 0; i < 30; i++) cur[`q${i}`] = { r5: 0, rr: 0 };
    const v = compared(compareToBaseline(base, cur));
    expect(v.status).toBe("FAIL");
    expect(v.r5.hi).toBeLessThan(0);
    expect(v.mrr.hi).toBeLessThan(0);
    expect(v.reason).toMatch(/r5/);
  });

  test("an MRR-only drop fails even when recall@5 holds", () => {
    const base = uniform(100, 1, 1);
    const cur = structuredClone(base);
    for (let i = 0; i < 40; i++) cur[`q${i}`] = { r5: 1, rr: 0.5 };
    const v = compared(compareToBaseline(base, cur));
    expect(v.status).toBe("FAIL");
    expect(v.r5.hi).toBe(0);
    expect(v.reason).toMatch(/mrr/);
  });

  test("gains offset losses in the mean, but the losing queries are still listed", () => {
    const base = uniform(100, 0.5, 0.5);
    const cur = structuredClone(base);
    for (let i = 0; i < 10; i++) cur[`q${i}`] = { r5: 0, rr: 0 };
    for (let i = 10; i < 30; i++) cur[`q${i}`] = { r5: 1, rr: 1 };
    const v = compared(compareToBaseline(base, cur));
    expect(v.status).toBe("WARN");
    expect(v.r5.delta).toBeGreaterThan(0);
    expect(v.dropped).toHaveLength(10);
    expect(v.improved).toBe(20);
  });

  test("a query set that differs from the baseline fails as a stale baseline", () => {
    const base = uniform(5, 1, 1);
    const cur = structuredClone(base);
    delete (cur as Record<string, unknown>).q4;
    cur.q9 = { r5: 1, rr: 1 };
    const v = compareToBaseline(base, cur);
    expect(v.status).toBe("FAIL");
    expect(v.reason).toMatch(/baseline is stale/);
    expect(v).toMatchObject({ kind: "stale", missing: ["q4"], added: ["q9"] });
  });

  test("a query set with no overlap still returns the stale verdict", () => {
    const v = compareToBaseline(uniform(3, 1, 1), { x1: { r5: 1, rr: 1 } });
    expect(v.status).toBe("FAIL");
    expect(v.reason).toMatch(/--update-baseline/);
    expect(v.kind).toBe("stale");
  });

  test("the mean of identical runs passes against a single run despite float drift", () => {
    // mean([0.7, 0.7, 0.7]) is 0.7 - 1.1e-16 in IEEE doubles.
    const single: PerQuery = {};
    for (let i = 0; i < 50; i++) single[`q${i}`] = { r5: 0.7, rr: 1 / 9 };
    const averaged = meanPerQuery([single, structuredClone(single), structuredClone(single)]);
    const v = compared(compareToBaseline(single, averaged));
    expect(v.status).toBe("PASS");
    expect(v.dropped).toEqual([]);
  });

  test("a non-numeric metric throws instead of scoring as zero", () => {
    const base = uniform(3, 1, 1);
    const cur = structuredClone(base);
    cur.q1 = { r5: Number.NaN, rr: 1 };
    expect(() => compareToBaseline(base, cur)).toThrow(/q1.*r5/);
    // Baselines arrive as JSON, which is how a hand-edited file loses a field.
    const missing: PerQuery = JSON.parse(JSON.stringify({ ...base, q2: { r5: 1 } }));
    expect(() => compareToBaseline(missing, base)).toThrow(/q2.*rr/);
  });
});

describe("repeated runs", () => {
  test("identical runs report no differing query", () => {
    const run = uniform(4, 1, 0.5);
    expect(noiseAcrossRuns([run, structuredClone(run), structuredClone(run)])).toEqual({ differing: [], maxAbs: 0 });
  });

  test("a query that moves between runs is named, and the verdict uses the run mean", () => {
    const a = uniform(4, 1, 1);
    const b = structuredClone(a);
    b.q2 = { r5: 0, rr: 0.5 };
    expect(noiseAcrossRuns([a, b])).toEqual({ differing: ["q2"], maxAbs: 1 });
    expect(meanPerQuery([a, b]).q2).toEqual({ r5: 0.5, rr: 0.75 });
  });

  test("runs over different query sets throw", () => {
    const a = uniform(3, 1, 1);
    const b = uniform(4, 1, 1);
    expect(() => meanPerQuery([a, b])).toThrow(/same queries/);
  });
});

describe("perQueryMetrics", () => {
  test("reads recall@5 and MRR of one backend per query", () => {
    // Only the fields perQueryMetrics reads; the rest of a `qmd bench --json` result is omitted.
    const bench: BenchmarkResult = JSON.parse(JSON.stringify({
      results: [
        { id: "a", query: "x", type: "exact", backends: { bm25: { recall_at_5: 1, mrr: 0.5 } } },
        { id: "b", query: "y", type: "exact", backends: { bm25: { recall_at_5: 0, mrr: 0 } } },
      ],
    }));
    expect(perQueryMetrics(bench, "bm25")).toEqual({ a: { r5: 1, rr: 0.5 }, b: { r5: 0, rr: 0 } });
  });

  test("a result without that backend throws", () => {
    const bench: BenchmarkResult = JSON.parse(JSON.stringify({
      results: [{ id: "a", query: "x", type: "exact", backends: {} }],
    }));
    expect(() => perQueryMetrics(bench, "bm25")).toThrow(/a.*bm25/);
  });
});
