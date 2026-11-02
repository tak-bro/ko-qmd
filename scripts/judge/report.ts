/**
 * report.ts — turn judge grades (and hand labels, once they exist) into the stage-2 numbers.
 *
 *   tsx scripts/judge/report.ts <judgments.json> <queries.json> [labels.json] [out-report.json]
 *
 * Lines on stdout:
 *   JUDGE     model, queries, graded pairs, seconds
 *   POSITION  grades that changed when the pool was reshuffled (pass 1 vs pass 2)
 *   GOLD      goldset answer files the judge graded ≥ 2 — a label-free sanity check
 *   OFFCORPUS off-corpus pool documents the judge graded 0
 *   NDCG      per query set and backend: mean nDCG@10 with a bootstrap 95% interval
 *   NDCG-DIFF per query set: paired difference of each backend against bm25
 *   KAPPA     judge vs hand labels (Cohen and quadratic weighted) with intervals, or "pending"
 * Exit: 0 · 2 bad input.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { pairedBootstrap } from "../../src/bench/gate.js";
import { bootstrapStatistic, cohenKappa, flipRate, GRADES, ndcgAt, weightedKappa } from "../../src/bench/judge-metrics.js";
import type { LabelFile } from "./label.js";
import type { QuerySet } from "./pool.js";
import type { Grades, Judgments } from "./run.js";

interface MeanCI {
  mean: number;
  lo: number;
  hi: number;
  n: number;
  /** Queries left out because their pool held no relevant document (nDCG undefined). */
  undefined: number;
  /** Queries of the set the judge failed on in pass 1 (no grades, so no nDCG). */
  failed: number;
}

interface KappaCI {
  value: number;
  lo: number;
  hi: number;
  /** Resamples where kappa was undefined; left out of lo/hi. */
  undefined_draws: number;
}

export interface Report {
  conditions: Judgments["conditions"];
  graded_queries: number;
  graded_pairs: number;
  errors: Record<string, string>;
  position: { pairs: number; flip_rate: number; weighted_kappa: number } | null;
  /** Goldset answer files: how many any backend retrieved, and how many the judge graded ≥ 2. */
  gold: { retrieved: number; graded_relevant: number; total: number };
  off_corpus: { graded_zero: number; total: number };
  ndcg: Record<string, Record<string, MeanCI>>;
  ndcg_diff: Record<string, Record<string, { delta: number; lo: number; hi: number; n: number }>>;
  kappa:
    | { status: "pending"; labels: number }
    | {
        status: "measured";
        pairs: number;
        queries: number;
        /** Labels on queries the judge failed on — not compared. */
        unjudged: number;
        cohen: KappaCI;
        weighted: KappaCI;
        exact_agreement: number;
        /** confusion[human][judge] */
        confusion: number[][];
      };
}

const SETS: Record<string, (type: string, gold: boolean) => boolean> = {
  goldset: (_t, gold) => gold,
  open: t => t === "open",
};

function meanCI(values: number[], failed: number): MeanCI {
  const defined = values.filter(v => !Number.isNaN(v));
  const left = values.length - defined.length;
  if (defined.length === 0) return { mean: Number.NaN, lo: Number.NaN, hi: Number.NaN, n: 0, undefined: left, failed };
  const ci = pairedBootstrap(defined);
  return { mean: ci.mean, lo: ci.lo, hi: ci.hi, n: defined.length, undefined: left, failed };
}

function gradeOf(g: Grades, file: string, id: string): number {
  const grade = g[file];
  if (grade === undefined) throw new Error(`query ${id}: ${file} has no grade — judgments do not match their pools`);
  return grade;
}

export function buildReport(judgments: Judgments, querySet: QuerySet, labels?: LabelFile): Report {
  const [first, second] = judgments.passes;
  if (!first) throw new Error("judgments have no passes");
  const grades = first.grades;
  const types = new Map(querySet.queries.map(q => [q.id, q]));
  const errors = Object.fromEntries(judgments.passes.flatMap(p => Object.entries(p.errors).map(([id, e]) => [`${id}@seed${p.seed}`, e])));

  let position: Report["position"] = null;
  if (second) {
    const a: number[] = [];
    const b: number[] = [];
    for (const [id, g] of Object.entries(grades)) {
      const g2 = second.grades[id];
      if (!g2) continue;
      for (const [file, grade] of Object.entries(g)) {
        if (g2[file] === undefined) continue;
        a.push(grade);
        b.push(g2[file]!);
      }
    }
    if (a.length) position = { pairs: a.length, flip_rate: flipRate(a, b), weighted_kappa: weightedKappa(a, b) };
  }

  const gold = { retrieved: 0, graded_relevant: 0, total: 0 };
  const pools = new Map(judgments.pools.map(p => [p.id, p]));
  const offCorpus = { graded_zero: 0, total: 0 };
  for (const [id, g] of Object.entries(grades)) {
    const q = types.get(id);
    if (!q) continue;
    const ranked = new Set(Object.values(pools.get(id)?.rankings ?? {}).flat());
    for (const f of q.expected_files) {
      gold.total++;
      if (ranked.has(f)) gold.retrieved++;
      if (gradeOf(g, f, id) >= 2) gold.graded_relevant++;
    }
    if (q.type === "off-corpus") {
      for (const grade of Object.values(g)) {
        offCorpus.total++;
        if (grade === 0) offCorpus.graded_zero++;
      }
    }
  }

  const ndcg: Report["ndcg"] = {};
  const ndcgDiff: Report["ndcg_diff"] = {};
  const backends = judgments.conditions.backends;
  for (const [set, member] of Object.entries(SETS)) {
    const inSet = judgments.pools.filter(p => {
      const q = types.get(p.id);
      return q && member(q.type, q.expected_files.length > 0);
    });
    const graded = inSet.filter(p => grades[p.id]);
    const failed = inSet.length - graded.length;
    const perBackend: Record<string, number[]> = {};
    for (const b of backends) {
      perBackend[b] = graded.map(p => {
        const g: Grades = grades[p.id]!;
        return ndcgAt((p.rankings[b] ?? []).map(f => gradeOf(g, f, p.id)), Object.values(g), judgments.conditions.k);
      });
    }
    ndcg[set] = Object.fromEntries(backends.map(b => [b, meanCI(perBackend[b]!, failed)]));
    ndcgDiff[set] = {};
    for (const b of backends.filter(x => x !== "bm25" && perBackend.bm25)) {
      const deltas: number[] = [];
      perBackend[b]!.forEach((v, i) => {
        const base = perBackend.bm25![i]!;
        if (!Number.isNaN(v) && !Number.isNaN(base)) deltas.push(v - base);
      });
      if (deltas.length) {
        const ci = pairedBootstrap(deltas);
        ndcgDiff[set]![`${b}-bm25`] = { delta: ci.mean, lo: ci.lo, hi: ci.hi, n: deltas.length };
      }
    }
  }

  let kappa: Report["kappa"] = { status: "pending", labels: 0 };
  if (labels) {
    const byQuery: { human: number; judge: number }[][] = [];
    let total = 0;
    let unjudged = 0;
    for (const [id, l] of Object.entries(labels.labels)) {
      const g = grades[id];
      total += Object.keys(l).length;
      if (!g) {
        unjudged += Object.keys(l).length;
        continue;
      }
      const pairs = Object.entries(l).map(([f, human]) => ({ human, judge: gradeOf(g, f, id) }));
      if (pairs.length) byQuery.push(pairs);
    }
    const flat = byQuery.flat();
    if (flat.length === 0) {
      kappa = { status: "pending", labels: total };
    } else {
      const ci = (fn: (a: number[], b: number[]) => number): KappaCI => {
        const r = bootstrapStatistic(byQuery, sample => {
          const s = sample.flat();
          return fn(s.map(p => p.human), s.map(p => p.judge));
        });
        return { value: r.value, lo: r.lo, hi: r.hi, undefined_draws: r.undefinedDraws };
      };
      const confusion = Array.from({ length: GRADES }, () => new Array<number>(GRADES).fill(0));
      for (const p of flat) confusion[p.human]![p.judge]!++;
      kappa = {
        status: "measured",
        pairs: flat.length,
        queries: byQuery.length,
        unjudged,
        cohen: ci(cohenKappa),
        weighted: ci(weightedKappa),
        exact_agreement: flat.filter(p => p.human === p.judge).length / flat.length,
        confusion,
      };
    }
  }

  return {
    conditions: judgments.conditions,
    graded_queries: Object.keys(grades).length,
    graded_pairs: Object.values(grades).reduce((s, g) => s + Object.keys(g).length, 0),
    errors,
    position,
    gold,
    off_corpus: offCorpus,
    ndcg,
    ndcg_diff: ndcgDiff,
    kappa,
  };
}

const f3 = (x: number) => (Number.isNaN(x) ? "nan" : x.toFixed(3));

export function reportLines(r: Report): string[] {
  const lines = [
    `JUDGE model=${r.conditions.model} mode=${r.conditions.mode} queries=${r.graded_queries} pairs=${r.graded_pairs} seconds=${r.conditions.seconds} errors=${Object.keys(r.errors).length}`,
    r.position
      ? `POSITION flip=${f3(r.position.flip_rate)} wkappa=${f3(r.position.weighted_kappa)} pairs=${r.position.pairs} (pass seed ${r.conditions.seeds[0]} vs ${r.conditions.seeds[1]})`
      : "POSITION skipped (one pass)",
    `GOLD graded>=2 ${r.gold.graded_relevant}/${r.gold.total} retrieved=${r.gold.retrieved}`,
    `OFFCORPUS graded=0 ${r.off_corpus.graded_zero}/${r.off_corpus.total}`,
  ];
  for (const [set, byBackend] of Object.entries(r.ndcg)) {
    for (const [b, m] of Object.entries(byBackend)) {
      lines.push(`NDCG set=${set} backend=${b} mean=${f3(m.mean)} [${f3(m.lo)}, ${f3(m.hi)}] n=${m.n} undefined=${m.undefined} failed=${m.failed}`);
    }
    for (const [name, d] of Object.entries(r.ndcg_diff[set] ?? {})) {
      lines.push(`NDCG-DIFF set=${set} ${name} delta=${f3(d.delta)} [${f3(d.lo)}, ${f3(d.hi)}] n=${d.n}`);
    }
  }
  const k = r.kappa;
  lines.push(
    k.status === "pending"
      ? `KAPPA pending labels=${k.labels}`
      : `KAPPA cohen=${f3(k.cohen.value)} [${f3(k.cohen.lo)}, ${f3(k.cohen.hi)}] weighted=${f3(k.weighted.value)} [${f3(k.weighted.lo)}, ${f3(k.weighted.hi)}] exact=${f3(k.exact_agreement)} pairs=${k.pairs} queries=${k.queries} unjudged=${k.unjudged} undefined_draws=${k.cohen.undefined_draws + k.weighted.undefined_draws}`,
  );
  return lines;
}

export function main(argv: string[]): number {
  const [judgePath, queriesPath, labelPath, outPath] = argv;
  if (!judgePath || !queriesPath) {
    console.error("usage: tsx scripts/judge/report.ts <judgments.json> <queries.json> [labels.json] [out-report.json]");
    return 2;
  }
  const judgments = JSON.parse(readFileSync(judgePath, "utf8")) as Judgments;
  const querySet = JSON.parse(readFileSync(queriesPath, "utf8")) as QuerySet;
  const labels = labelPath && existsSync(labelPath) ? (JSON.parse(readFileSync(labelPath, "utf8")) as LabelFile) : undefined;
  if (labels && labels.rubric_sha256 !== judgments.conditions.rubric_sha256) {
    console.error(`labels and judgments used different rubrics (${labels.rubric_sha256.slice(0, 8)} vs ${judgments.conditions.rubric_sha256.slice(0, 8)})`);
    return 2;
  }
  const report = buildReport(judgments, querySet, labels);
  for (const line of reportLines(report)) console.log(line);
  if (outPath) writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }
}
