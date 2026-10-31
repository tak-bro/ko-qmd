/**
 * bench-lex-gate.ts — the verdict half of scripts/bench-lex-gate.sh.
 *
 *   tsx scripts/bench-lex-gate.ts check  <baseline.json> <run.json>...
 *   tsx scripts/bench-lex-gate.ts update <baseline.json> <run.json>...
 *
 * Each <run.json> is a `qmd bench --backend bm25 --json` result over the same goldset.
 * `check` prints the NOISE / LEX / DELTA / DROP / GATE lines and exits 1 on FAIL.
 * `update` rewrites the baseline from the per-query mean of the runs.
 * LEX_COMMIT names the measured commit in the baseline's conditions.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import {
  compareToBaseline,
  DEFAULT_BOOTSTRAP,
  meanPerQuery,
  noiseAcrossRuns,
  perQueryMetrics,
  type PerQuery,
} from "../src/bench/gate.js";
import type { BenchmarkResult } from "../src/bench/types.js";

interface Baseline {
  description: string;
  conditions: {
    commit: string;
    date: string;
    os: string;
    cpu: string;
    node: string;
    reps: number;
    noise_differing: number;
  };
  summary: { r5: number; mrr: number; n: number };
  queries: PerQuery;
}

const f4 = (x: number) => x.toFixed(4);

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function readBaseline(path: string): Baseline {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot read baseline ${path}: ${error instanceof Error ? error.message : String(error)} — create it with --update-baseline`,
      { cause: error },
    );
  }
  const queries = (parsed as { queries?: unknown } | null)?.queries;
  if (typeof queries !== "object" || queries === null || Array.isArray(queries)) {
    throw new Error(`baseline ${path} has no "queries" object`);
  }
  // Per-query values are checked by compareToBaseline, which throws on a missing or non-numeric metric.
  return parsed as Baseline;
}

function main(argv: string[]): number {
  const [mode, baselinePath, ...runPaths] = argv;
  if ((mode !== "check" && mode !== "update") || !baselinePath || runPaths.length === 0) {
    console.error("usage: tsx scripts/bench-lex-gate.ts <check|update> <baseline.json> <run.json>...");
    return 2;
  }

  const runs = runPaths.map(p => perQueryMetrics(JSON.parse(readFileSync(p, "utf8")) as BenchmarkResult, "bm25"));
  const noise = noiseAcrossRuns(runs);
  const current = meanPerQuery(runs);
  const ids = Object.keys(current);
  const r5 = mean(ids.map(id => current[id]!.r5));
  const mrr = mean(ids.map(id => current[id]!.rr));
  console.log(`NOISE reps=${runs.length} differing=${noise.differing.length} max_abs=${f4(noise.maxAbs)}`
    + (noise.differing.length > 0 ? ` ids=${noise.differing.join(",")}` : ""));

  if (mode === "update") {
    const baseline: Baseline = {
      description: "Lex (bm25) per-query recall@5 and reciprocal rank on test/fixtures/ko-vault/ko-bench.json. "
        + "Written by `bash scripts/bench-lex-gate.sh --update-baseline`; values are the mean over `reps` fresh-index runs.",
      conditions: {
        commit: process.env.LEX_COMMIT ?? "unknown",
        date: new Date().toISOString().slice(0, 10),
        os: `${platform()}-${arch()}`,
        cpu: cpus()[0]?.model ?? "unknown",
        node: process.version,
        reps: runs.length,
        noise_differing: noise.differing.length,
      },
      summary: { r5: Number(f4(r5)), mrr: Number(f4(mrr)), n: ids.length },
      queries: Object.fromEntries(Object.keys(current).sort().map(id => [id, current[id]!])),
    };
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`LEX r5=${f4(r5)} mrr=${f4(mrr)} n=${ids.length}`);
    console.log(`BASELINE written ${baselinePath}`);
    return 0;
  }

  const baseline = readBaseline(baselinePath);
  const v = compareToBaseline(baseline.queries, current);
  if (v.kind === "stale") {
    console.log(`LEX r5=${f4(r5)} mrr=${f4(mrr)} n=${ids.length}`);
    if (v.missing.length > 0) console.log(`STALE missing=${v.missing.join(",")}`);
    if (v.added.length > 0) console.log(`STALE added=${v.added.join(",")}`);
  } else {
    console.log(`LEX r5=${f4(v.r5.current)} mrr=${f4(v.mrr.current)} baseline_r5=${f4(v.r5.baseline)} `
      + `baseline_mrr=${f4(v.mrr.baseline)} n=${ids.length}`);
    console.log(`DELTA r5=${f4(v.r5.delta)} [${f4(v.r5.lo)}, ${f4(v.r5.hi)}] `
      + `mrr=${f4(v.mrr.delta)} [${f4(v.mrr.lo)}, ${f4(v.mrr.hi)}] `
      + `(paired bootstrap, ${DEFAULT_BOOTSTRAP.iters} resamples, seed ${DEFAULT_BOOTSTRAP.seed}, ${100 * (1 - DEFAULT_BOOTSTRAP.alpha)}%)`);
    for (const d of v.dropped) {
      console.log(`DROP ${d.id} r5=${f4(d.r5[0])}->${f4(d.r5[1])} rr=${f4(d.rr[0])}->${f4(d.rr[1])}`);
    }
  }
  console.log(`GATE ${v.status} ${v.reason}`);
  return v.status === "FAIL" ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`bench-lex-gate: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
