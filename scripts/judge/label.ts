/**
 * label.ts — hand-label (query, document) pairs on the judge rubric.
 *
 *   npx tsx scripts/judge/label.ts [judgments.json] [labels.json]
 *
 * Defaults: test/fixtures/ko-vault/judge/judgments.json and labels.json. For every goldset query
 * (one with expected_files) the pairs are 5 documents of its judge pool: the top 2 of `full` and
 * 3 drawn at random from the rest (lower ranks, bm25/hybrid-only hits, unretrieved answers). The
 * rest of the pool sets the nDCG ideal too, so the judge is checked there, not only on top hits.
 * The judge's grades are never shown, and the labeler sees the same text the judge saw. Each label
 * is saved as soon as it is typed, and a rerun skips pairs already labeled.
 *
 * Keys: 0-3 grade · s skip for now · q save and quit. The rubric is printed once at start.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { loadDoc, type Pool, type QuerySet } from "./pool.js";
import { shuffled } from "./run.js";

export interface LabelFile {
  description: string;
  rubric_sha256: string;
  /** query id → corpus path → grade */
  labels: Record<string, Record<string, number>>;
}

export interface Pair {
  id: string;
  query: string;
  file: string;
}

export const LABEL_BACKEND = "full";
export const LABEL_TOP = 2;
export const LABEL_REST = 3;

/**
 * Pairs to label per listed query: top `top` of `backend` plus `rest` seeded draws from the rest
 * of the pool, shuffled together so the labeler cannot read the system's rank off the order.
 */
export function labelPairs(
  pools: readonly Pool[],
  ids: ReadonlySet<string>,
  backend = LABEL_BACKEND,
  top = LABEL_TOP,
  rest = LABEL_REST,
): Pair[] {
  const pairs: Pair[] = [];
  for (const [i, pool] of pools.entries()) {
    if (!ids.has(pool.id)) continue;
    const ranking = pool.rankings[backend];
    if (!ranking) throw new Error(`pool ${pool.id} has no ${backend} ranking`);
    const head = ranking.slice(0, top);
    const tail = shuffled(pool.files.filter(f => !head.includes(f)), 2000 + i).slice(0, rest);
    for (const file of shuffled([...head, ...tail], 1000 + i)) pairs.push({ id: pool.id, query: pool.query, file });
  }
  return pairs;
}

export interface LabelIO {
  /** Next answer, or null at end of input. */
  ask(prompt: string): Promise<string | null>;
  print(text: string): void;
  save(labels: LabelFile): void;
}

/** Walks the unlabeled pairs. Returns how many labels were added this run. */
export async function runLabeling(pairs: readonly Pair[], file: LabelFile, corpus: string, io: LabelIO): Promise<number> {
  const todo = pairs.filter(p => file.labels[p.id]?.[p.file] === undefined);
  io.print(`${pairs.length - todo.length}/${pairs.length} labeled, ${todo.length} to go`);
  let added = 0;
  for (const [i, pair] of todo.entries()) {
    const doc = loadDoc(corpus, pair.file);
    io.print(`\n[${i + 1}/${todo.length}] 질의: ${pair.query}\n--- ${pair.file}\n# ${doc.title}\n${doc.body}\n`);
    for (;;) {
      const answer = await io.ask("등급 0-3 · s 건너뛰기 · q 저장 후 종료 > ");
      if (answer === null) return added;
      const a = answer.trim().toLowerCase();
      if (a === "q") return added;
      if (a === "s") break;
      if (/^[0-3]$/.test(a)) {
        (file.labels[pair.id] ??= {})[pair.file] = Number(a);
        io.save(file);
        added++;
        break;
      }
      io.print("0, 1, 2, 3, s, q 중 하나");
    }
  }
  return added;
}

async function main(argv: string[]): Promise<number> {
  const judgePath = argv[0] ?? "test/fixtures/ko-vault/judge/judgments.json";
  const labelPath = argv[1] ?? "test/fixtures/ko-vault/judge/labels.json";
  const corpus = process.env.JUDGE_CORPUS ?? "test/fixtures/ko-vault";
  const rubric = readFileSync(join(corpus, "judge", "rubric.md"), "utf8");
  const rubricSha = createHash("sha256").update(rubric).digest("hex");
  const judgments = JSON.parse(readFileSync(judgePath, "utf8")) as { pools: Pool[] };
  const querySet = JSON.parse(readFileSync(join(corpus, "judge", "queries.json"), "utf8")) as QuerySet;
  const goldIds = new Set(querySet.queries.filter(q => q.expected_files.length > 0).map(q => q.id));

  const file: LabelFile = existsSync(labelPath)
    ? (JSON.parse(readFileSync(labelPath, "utf8")) as LabelFile)
    : { description: `Hand labels (0-3) on rubric.md: per goldset query, top ${LABEL_TOP} of ${LABEL_BACKEND} + ${LABEL_REST} random from the rest of the judge pool`, rubric_sha256: rubricSha, labels: {} };
  if (file.rubric_sha256 !== rubricSha) {
    console.error(`labels were made on another rubric (${file.rubric_sha256.slice(0, 8)} vs ${rubricSha.slice(0, 8)}) — relabel or restore the rubric`);
    return 2;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  console.log(rubric);
  const added = await runLabeling(labelPairs(judgments.pools, goldIds), file, corpus, {
    ask: async prompt => (closed ? null : rl.question(prompt).catch(() => null)),
    print: text => console.log(text),
    save: labels => writeFileSync(labelPath, `${JSON.stringify(labels, null, 2)}\n`),
  });
  rl.close();
  console.log(`\n+${added} labels → ${labelPath}`);
  return 0;
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
