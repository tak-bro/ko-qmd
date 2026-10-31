/**
 * Verdict logic for the lex CI gate (scripts/bench-lex-gate.sh).
 *
 * The gate benches bm25 over the ko-vault goldset and compares each query's
 * recall@5 and reciprocal rank with a committed baseline. A paired bootstrap
 * over the queries gives a 95% interval for the mean change of each metric:
 *
 *   FAIL — an interval lies wholly below zero (a drop the query sample cannot
 *          explain), or the query set differs from the baseline's.
 *   WARN — no such interval, but some query scores lower than its baseline.
 *   PASS — no query scores lower.
 *
 * bm25 has no sampling step, so the interval measures query-set luck, not
 * run-to-run noise. Run-to-run noise is measured separately by benching N
 * fresh indexes and comparing them (noiseAcrossRuns).
 *
 * Pure functions only — the script owns I/O.
 */

import type { BenchmarkResult } from "./types.js";

export interface QueryMetrics {
  /** recall@5 */
  r5: number;
  /** reciprocal rank of the first relevant result */
  rr: number;
}

/** Query id → metrics. */
export type PerQuery = Record<string, QueryMetrics>;

export interface BootstrapOptions {
  iters?: number;
  seed?: number;
  /** Two-sided miss rate; 0.05 gives a 95% interval. */
  alpha?: number;
}

export interface Interval {
  mean: number;
  lo: number;
  hi: number;
}

export interface MetricVerdict {
  baseline: number;
  current: number;
  /** current − baseline mean */
  delta: number;
  /** bootstrap interval of delta */
  lo: number;
  hi: number;
}

export interface DroppedQuery {
  id: string;
  r5: [baseline: number, current: number];
  rr: [baseline: number, current: number];
}

/** The baseline and the current run cover different queries, so nothing is compared. */
export interface StaleVerdict {
  kind: "stale";
  status: "FAIL";
  reason: string;
  /** baseline ids absent from the current run */
  missing: string[];
  /** current ids absent from the baseline */
  added: string[];
}

export interface ComparedVerdict {
  kind: "compared";
  status: "PASS" | "WARN" | "FAIL";
  reason: string;
  r5: MetricVerdict;
  mrr: MetricVerdict;
  dropped: DroppedQuery[];
  /** queries that score higher on some metric and lower on none */
  improved: number;
}

export type GateVerdict = StaleVerdict | ComparedVerdict;

export const DEFAULT_BOOTSTRAP = { iters: 10_000, seed: 20261031, alpha: 0.05 } as const;

/**
 * Per-query changes smaller than this count as zero. Averaging identical runs drifts by ~1e-16
 * (mean([0.7, 0.7, 0.7]) < 0.7), and with every other delta exactly zero that drift alone would
 * put the whole bootstrap below zero. Real changes are multiples of 1/k or 1/rank, far above it.
 */
const EPSILON = 1e-9;

/** mulberry32 — small seeded PRNG so a CI rerun draws the same resamples. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(xs: readonly number[]): number {
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/** Percentile bootstrap interval of the mean of `deltas`, resampling queries with replacement. */
export function pairedBootstrap(deltas: readonly number[], options: BootstrapOptions = {}): Interval {
  if (deltas.length === 0) throw new Error("pairedBootstrap: no queries to resample");
  const { iters, seed, alpha } = { ...DEFAULT_BOOTSTRAP, ...options };
  const rand = mulberry32(seed);
  const n = deltas.length;
  const means = new Float64Array(iters);
  for (let i = 0; i < iters; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += deltas[Math.floor(rand() * n)]!;
    means[i] = sum / n;
  }
  means.sort();
  return {
    mean: mean(deltas),
    lo: means[Math.floor((alpha / 2) * (iters - 1))]!,
    hi: means[Math.ceil((1 - alpha / 2) * (iters - 1))]!,
  };
}

function assertMetrics(id: string, m: QueryMetrics | undefined, where: string): QueryMetrics {
  for (const key of ["r5", "rr"] as const) {
    const v = m?.[key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`${where}: query ${id} has no numeric ${key} (got ${JSON.stringify(v)})`);
    }
  }
  return m!;
}

function metricVerdict(base: number[], cur: number[], options: BootstrapOptions): MetricVerdict {
  const deltas = cur.map((c, i) => {
    const d = c - base[i]!;
    return Math.abs(d) < EPSILON ? 0 : d;
  });
  const { lo, hi } = pairedBootstrap(deltas, options);
  const baseline = mean(base);
  const current = mean(cur);
  return { baseline, current, delta: current - baseline, lo, hi };
}

export function compareToBaseline(
  baseline: PerQuery,
  current: PerQuery,
  options: BootstrapOptions = {},
): GateVerdict {
  const ids = Object.keys(baseline).sort();
  const missing = ids.filter(id => !(id in current));
  const added = Object.keys(current).filter(id => !(id in baseline)).sort();
  if (missing.length > 0 || added.length > 0) {
    return {
      kind: "stale",
      status: "FAIL",
      reason: `baseline is stale: ${missing.length} baseline queries missing, ${added.length} new — refresh it with --update-baseline`,
      missing,
      added,
    };
  }
  const shared = ids;
  if (shared.length === 0) throw new Error("compareToBaseline: the baseline has no queries");

  const base = shared.map(id => assertMetrics(id, baseline[id], "baseline"));
  const cur = shared.map(id => assertMetrics(id, current[id], "current"));
  const r5 = metricVerdict(base.map(m => m.r5), cur.map(m => m.r5), options);
  const mrr = metricVerdict(base.map(m => m.rr), cur.map(m => m.rr), options);

  const dropped: DroppedQuery[] = [];
  let improved = 0;
  shared.forEach((id, i) => {
    const b = base[i]!;
    const c = cur[i]!;
    const lower = c.r5 < b.r5 - EPSILON || c.rr < b.rr - EPSILON;
    const higher = c.r5 > b.r5 + EPSILON || c.rr > b.rr + EPSILON;
    if (lower) dropped.push({ id, r5: [b.r5, c.r5], rr: [b.rr, c.rr] });
    else if (higher) improved++;
  });

  const failing = [r5.hi < 0 ? "r5" : "", mrr.hi < 0 ? "mrr" : ""].filter(Boolean);
  let status: ComparedVerdict["status"];
  let reason: string;
  if (failing.length > 0) {
    status = "FAIL";
    reason = `95% interval below zero for ${failing.join(", ")}`;
  } else if (dropped.length > 0) {
    status = "WARN";
    reason = `${dropped.length} queries dropped, but no interval lies below zero`;
  } else {
    status = "PASS";
    reason = "no query dropped";
  }
  return { kind: "compared", status, reason, r5, mrr, dropped, improved };
}

/** Per-query recall@5 and reciprocal rank of one backend from a `qmd bench --json` result. */
export function perQueryMetrics(bench: BenchmarkResult, backend: string): PerQuery {
  const out: PerQuery = {};
  for (const r of bench.results) {
    const b = r.backends[backend];
    if (!b) throw new Error(`bench result for query ${r.id} has no ${backend} backend`);
    if (b.error !== undefined) throw new Error(`bench result for query ${r.id}: ${backend} threw: ${b.error}`);
    out[r.id] = assertMetrics(r.id, { r5: b.recall_at_5, rr: b.mrr }, "bench");
  }
  return out;
}

function assertSameQueries(runs: readonly PerQuery[]): string[] {
  if (runs.length === 0) throw new Error("no runs");
  const ids = Object.keys(runs[0]!).sort();
  for (const run of runs) {
    const other = Object.keys(run).sort();
    if (other.length !== ids.length || other.some((id, i) => id !== ids[i])) {
      throw new Error("repeated runs must cover the same queries");
    }
  }
  return ids;
}

/** Queries whose metrics differ between repeated runs, and the largest such difference. */
export function noiseAcrossRuns(runs: readonly PerQuery[]): { differing: string[]; maxAbs: number } {
  const ids = assertSameQueries(runs);
  const differing: string[] = [];
  let maxAbs = 0;
  for (const id of ids) {
    let moved = false;
    for (const key of ["r5", "rr"] as const) {
      const vals = runs.map(r => assertMetrics(id, r[id], "run")[key]);
      const spread = Math.max(...vals) - Math.min(...vals);
      if (spread > 0) moved = true;
      maxAbs = Math.max(maxAbs, spread);
    }
    if (moved) differing.push(id);
  }
  return { differing, maxAbs };
}

/** Per-query mean over repeated runs — the gate's verdict input when runs disagree. */
export function meanPerQuery(runs: readonly PerQuery[]): PerQuery {
  const ids = assertSameQueries(runs);
  const out: PerQuery = {};
  for (const id of ids) {
    out[id] = {
      r5: mean(runs.map(r => assertMetrics(id, r[id], "run").r5)),
      rr: mean(runs.map(r => r[id]!.rr)),
    };
  }
  return out;
}
