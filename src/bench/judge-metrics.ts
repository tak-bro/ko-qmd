/**
 * Agreement and ranking metrics for LLM-as-judge relevance grades (0–3).
 *
 * Pure functions, no I/O. `scripts/judge/report.ts` feeds them the judge's grades, the
 * hand labels and the bench rankings. Grades follow the rubric in
 * test/fixtures/ko-vault/judge/rubric.md: 0 unrelated … 3 answers the query.
 */

import { DEFAULT_BOOTSTRAP, mulberry32, type BootstrapOptions } from "./gate.js";

export const GRADES = 4;

function assertPairs(a: readonly number[], b: readonly number[], where: string): void {
  if (a.length !== b.length) throw new Error(`${where}: length mismatch (${a.length} vs ${b.length})`);
  if (a.length === 0) throw new Error(`${where}: empty input`);
}

function assertGrade(g: number, where: string): void {
  if (!Number.isInteger(g) || g < 0 || g >= GRADES) {
    throw new Error(`${where}: grade must be an integer 0-${GRADES - 1}, got ${g}`);
  }
}

/**
 * Kappa from a confusion matrix with disagreement weights w(i, j):
 * 1 - Σ w·observed / Σ w·expected. With 0/1 weights this is Cohen's kappa.
 * NaN when both raters used one and the same category (no disagreement is possible).
 */
function kappa(a: readonly number[], b: readonly number[], weight: (i: number, j: number) => number, where: string): number {
  assertPairs(a, b, where);
  const k = GRADES;
  const observed = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let n = 0; n < a.length; n++) {
    assertGrade(a[n]!, where);
    assertGrade(b[n]!, where);
    observed[a[n]!]![b[n]!]!++;
  }
  const rows = observed.map(r => r.reduce((s, x) => s + x, 0));
  const cols = observed[0]!.map((_, j) => observed.reduce((s, r) => s + r[j]!, 0));
  let num = 0;
  let den = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const w = weight(i, j);
      num += w * observed[i]![j]!;
      den += w * (rows[i]! * cols[j]!) / a.length;
    }
  }
  if (den === 0) return num === 0 ? Number.NaN : 0;
  return 1 - num / den;
}

/** Cohen's kappa: every disagreement costs the same. */
export function cohenKappa(a: readonly number[], b: readonly number[]): number {
  return kappa(a, b, (i, j) => (i === j ? 0 : 1), "cohenKappa");
}

/** Quadratic weighted kappa: a 1-grade miss costs 1/9 of a 3-grade miss. */
export function weightedKappa(a: readonly number[], b: readonly number[]): number {
  return kappa(a, b, (i, j) => ((i - j) ** 2) / ((GRADES - 1) ** 2), "weightedKappa");
}

function dcg(grades: readonly number[], k: number): number {
  let sum = 0;
  for (let i = 0; i < Math.min(k, grades.length); i++) sum += (2 ** grades[i]! - 1) / Math.log2(i + 2);
  return sum;
}

/**
 * nDCG@k with gain 2^g - 1. `ranked` is the grade at each rank of one system's list;
 * `pool` is every judged grade for the query (all systems), whose best k form the ideal.
 * NaN when the pool holds no relevant document — the query cannot tell systems apart.
 */
export function ndcgAt(ranked: readonly number[], pool: readonly number[], k = 10): number {
  const ideal = dcg([...pool].sort((x, y) => y - x), k);
  if (ideal === 0) return Number.NaN;
  return dcg(ranked, k) / ideal;
}

/** Share of items whose grade differs between two judging passes. */
export function flipRate(a: readonly number[], b: readonly number[]): number {
  assertPairs(a, b, "flipRate");
  let flips = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) flips++;
  return flips / a.length;
}

export interface StatInterval {
  value: number;
  lo: number;
  hi: number;
  /** Resamples where the statistic was NaN (e.g. kappa on a one-category draw); left out of lo/hi. */
  undefinedDraws: number;
}

/**
 * Percentile bootstrap of any statistic over items resampled with replacement.
 * Items are whole queries, so pairs from one query move together.
 */
export function bootstrapStatistic<T>(
  items: readonly T[],
  stat: (sample: T[]) => number,
  options: BootstrapOptions = {},
): StatInterval {
  if (items.length === 0) throw new Error("bootstrapStatistic: empty input");
  const { iters, seed, alpha } = { ...DEFAULT_BOOTSTRAP, ...options };
  const rand = mulberry32(seed);
  const n = items.length;
  const values: number[] = [];
  let undefinedDraws = 0;
  for (let i = 0; i < iters; i++) {
    const sample: T[] = new Array(n);
    for (let j = 0; j < n; j++) sample[j] = items[Math.floor(rand() * n)]!;
    const v = stat(sample);
    if (Number.isNaN(v)) undefinedDraws++;
    else values.push(v);
  }
  values.sort((x, y) => x - y);
  const last = values.length - 1;
  return {
    value: stat([...items]),
    lo: values.length ? values[Math.floor((alpha / 2) * last)]! : Number.NaN,
    hi: values.length ? values[Math.ceil((1 - alpha / 2) * last)]! : Number.NaN,
    undefinedDraws,
  };
}
