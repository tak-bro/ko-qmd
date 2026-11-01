/**
 * run.ts — LLM-as-judge pass over a judge query set.
 *
 *   tsx scripts/judge/run.ts <bench.json> <queries.json> <out-judgments.json>
 *
 * <bench.json> is `qmd bench --json` over <queries.json> (scripts/judge-ko.sh runs it through
 * bench-ko.sh). For every query the judge grades the pool — the union of each backend's top 10 —
 * in one listwise prompt, once per seed in JUDGE_SEEDS. Each seed shuffles the pool into a
 * different order while Ollama's sampling seed stays fixed, so the second pass measures position
 * bias alone.
 *
 * Env: JUDGE_MODEL (qwen3:8b) · OLLAMA_HOST (http://127.0.0.1:11434) · JUDGE_SEEDS (1,2)
 *      JUDGE_BACKENDS (bm25,hybrid,full) · JUDGE_CORPUS (test/fixtures/ko-vault) · JUDGE_COMMIT
 * Exit: 0 every query graded · 2 a query failed validation twice, or bad input.
 * A failed query is recorded under `errors`, never filled with zeros.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, arch } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mulberry32 } from "../../src/bench/gate.js";
import type { BenchmarkResult } from "../../src/bench/types.js";
import { ollamaChat, type Chat } from "./ollama.js";
import { buildPools, loadDoc, type Pool, type QuerySet } from "./pool.js";

export interface PoolDoc {
  file: string;
  title: string;
  body: string;
}

export type Grades = Record<string, number>;

export const GRADE_SCHEMA = {
  type: "object",
  properties: {
    grades: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, grade: { type: "integer", minimum: 0, maximum: 3 } },
        required: ["id", "grade"],
      },
    },
  },
  required: ["grades"],
} as const;

export function systemPrompt(rubric: string): string {
  return [
    "너는 한국어 검색 결과의 관련도를 매기는 평가자다. 아래 기준표대로 문서마다 0~3 등급을 매긴다.",
    "",
    rubric.trim(),
    "",
    '응답은 JSON 하나다: {"grades":[{"id":"d1","grade":0}, ...]}. 목록의 모든 id 에 정확히 한 번씩 등급을 준다.',
  ].join("\n");
}

export function userPrompt(query: string, docs: readonly { id: string; title: string; body: string }[]): string {
  const blocks = docs.map(d => `[${d.id}] ${d.title}\n${d.body}`);
  return `질의: ${query}\n\n문서 ${docs.length}개:\n\n${blocks.join("\n\n")}`;
}

/** Fisher–Yates with a seeded PRNG: the same seed always gives the same order. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Validates a judge reply against the ids it was shown. Returns grades by id or a reason. */
export function parseGrades(content: string, ids: readonly string[]): { grades: Grades } | { reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { reason: "reply is not JSON" };
  }
  const list = (parsed as { grades?: unknown } | null)?.grades;
  if (!Array.isArray(list)) return { reason: "reply has no grades array" };
  const want = new Set(ids);
  const grades: Grades = {};
  for (const item of list as { id?: unknown; grade?: unknown }[]) {
    const id = item?.id;
    const grade = item?.grade;
    if (typeof id !== "string" || !want.has(id)) return { reason: `unknown id ${JSON.stringify(id)}` };
    if (id in grades) return { reason: `id ${id} graded twice` };
    if (typeof grade !== "number" || !Number.isInteger(grade) || grade < 0 || grade > 3) {
      return { reason: `id ${id} has grade ${JSON.stringify(grade)}, want an integer 0-3` };
    }
    grades[id] = grade;
  }
  const missing = ids.filter(id => !(id in grades));
  if (missing.length) return { reason: `missing ids ${missing.join(",")}` };
  return { grades };
}

/**
 * Grades one pool in the order `seed` shuffles it to. One retry, told what was wrong;
 * a second bad reply throws so the caller records the query as failed.
 */
export async function judgeQuery(
  query: string,
  docs: readonly PoolDoc[],
  seed: number,
  rubric: string,
  chat: Chat,
): Promise<Grades> {
  const order = shuffled(docs, seed).map((d, i) => ({ ...d, id: `d${i + 1}` }));
  const ids = order.map(d => d.id);
  const system = systemPrompt(rubric);
  let user = userPrompt(query, order);
  let reason = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = parseGrades(await chat(system, user), ids);
    if ("grades" in result) {
      const byFile: Grades = {};
      for (const d of order) byFile[d.file] = result.grades[d.id]!;
      return byFile;
    }
    reason = result.reason;
    user = `${userPrompt(query, order)}\n\n이전 응답이 형식에 맞지 않았다(${reason}). 모든 id 에 0~3 정수 등급을 한 번씩 준다.`;
  }
  throw new Error(`judge reply invalid twice: ${reason}`);
}

export interface Pass {
  seed: number;
  /** query id → corpus path → grade */
  grades: Record<string, Grades>;
  /** query id → why it has no grades */
  errors: Record<string, string>;
}

export interface Judgments {
  description: string;
  conditions: {
    model: string;
    commit: string;
    date: string;
    os: string;
    cpu: string;
    rubric_sha256: string;
    backends: string[];
    k: number;
    seeds: number[];
    seconds: number;
  };
  pools: Pool[];
  passes: Pass[];
}

/** Ollama sampling seed, the same in every pass; JUDGE_SEEDS only reorders the pool. */
export const SAMPLING_SEED = 42;

/**
 * Every pass over every pool. A query whose reply fails validation twice, or whose call throws,
 * lands in that pass's `errors` and gets no grades.
 */
export async function judgeAll(
  pools: readonly Pool[],
  seeds: readonly number[],
  rubric: string,
  chat: Chat,
  load: (file: string) => { title: string; body: string },
  log: (line: string) => void = () => {},
): Promise<Pass[]> {
  const passes: Pass[] = [];
  for (const seed of seeds) {
    const pass: Pass = { seed, grades: {}, errors: {} };
    for (const [i, pool] of pools.entries()) {
      const docs = pool.files.map(file => ({ file, ...load(file) }));
      try {
        pass.grades[pool.id] = await judgeQuery(pool.query, docs, seed, rubric, chat);
      } catch (err) {
        pass.errors[pool.id] = err instanceof Error ? err.message : String(err);
      }
      log(`seed ${seed} ${i + 1}/${pools.length} ${pool.id} docs=${docs.length}${pass.errors[pool.id] ? ` ERROR ${pass.errors[pool.id]}` : ""}`);
    }
    passes.push(pass);
  }
  return passes;
}

export function countFailed(passes: readonly Pass[]): number {
  return passes.reduce((n, p) => n + Object.keys(p.errors).length, 0);
}

/** 0 when every query was graded in every pass, 2 otherwise. */
export function exitCode(passes: readonly Pass[]): 0 | 2 {
  return countFailed(passes) ? 2 : 0;
}

function envList(name: string, fallback: string): string[] {
  const raw = process.env[name] ?? fallback;
  const items = raw.split(",").map(s => s.trim()).filter(Boolean);
  if (!items.length) throw new Error(`${name} is empty`);
  return items;
}

async function main(argv: string[]): Promise<number> {
  const [benchPath, queriesPath, outPath] = argv;
  if (!benchPath || !queriesPath || !outPath) {
    console.error("usage: tsx scripts/judge/run.ts <bench.json> <queries.json> <out-judgments.json>");
    return 2;
  }
  const model = process.env.JUDGE_MODEL ?? "qwen3:8b";
  const host = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  const corpus = process.env.JUDGE_CORPUS ?? "test/fixtures/ko-vault";
  const backends = envList("JUDGE_BACKENDS", "bm25,hybrid,full");
  const seeds = envList("JUDGE_SEEDS", "1,2").map(s => {
    if (!/^\d+$/.test(s)) throw new Error(`JUDGE_SEEDS must be integers, got ${s}`);
    return Number(s);
  });
  const k = 10;

  const rubric = readFileSync(join(corpus, "judge", "rubric.md"), "utf8");
  const bench = JSON.parse(readFileSync(benchPath, "utf8")) as BenchmarkResult;
  const querySet = JSON.parse(readFileSync(queriesPath, "utf8")) as QuerySet;
  const pools = buildPools(bench, querySet, backends, k);

  const started = Date.now();
  // One sampling seed for every pass: only the order changes, so POSITION measures order alone.
  const chat = ollamaChat({ host, model, schema: GRADE_SCHEMA, seed: SAMPLING_SEED });
  const passes = await judgeAll(pools, seeds, rubric, chat, file => loadDoc(corpus, file), line => console.error(line));
  const failed = countFailed(passes);

  const judgments: Judgments = {
    description: "LLM-as-judge grades (0-3) per query pool; see test/fixtures/ko-vault/judge/rubric.md",
    conditions: {
      model,
      commit: process.env.JUDGE_COMMIT ?? "unknown",
      date: new Date().toISOString(),
      os: `${platform()}-${arch()}`,
      cpu: cpus()[0]?.model ?? "unknown",
      rubric_sha256: createHash("sha256").update(rubric).digest("hex"),
      backends,
      k,
      seeds,
      seconds: Math.round((Date.now() - started) / 1000),
    },
    pools,
    passes,
  };
  writeFileSync(outPath, `${JSON.stringify(judgments, null, 2)}\n`);
  console.error(`wrote ${outPath} (${pools.length} queries × ${seeds.length} seeds, ${failed} failed)`);
  return exitCode(passes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    code => process.exit(code),
    err => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(2);
    },
  );
}
