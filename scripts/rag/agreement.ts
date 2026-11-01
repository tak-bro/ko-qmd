/**
 * agreement.ts — how far the faithfulness judge agrees with reference grades on the same sentences.
 *
 *   tsx scripts/rag/agreement.ts <grades-judge.json> <grades-reference.json> [<judge-2> <reference-2> …]
 *
 * Pairs are pooled: every answer sentence graded in both files of a pair counts once. Prints
 *   AGREE  n, exact agreement on support, Cohen kappa on the three support values and on full vs
 *          not full (what faithfulness counts), each with a 95% bootstrap interval over sentences
 *   CONF   support confusion, rows reference full/partial/none, columns judge
 *   CITES  agreement on per-citation supports verdicts
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { bootstrapStatistic, cohenKappa, type StatInterval } from "../../src/bench/judge-metrics.js";
import type { SentenceGrade, Support } from "../../src/bench/rag-metrics.js";
import { SUPPORTS, type Grades } from "./grade.js";

export interface SentencePair {
  judge: SentenceGrade;
  reference: SentenceGrade;
}

export function pairSentences(judge: Grades, reference: Grades): SentencePair[] {
  const pairs: SentencePair[] = [];
  for (const [id, ref] of Object.entries(reference.grades)) {
    const j = judge.grades[id];
    if (!j) continue;
    if (j.length !== ref.length) throw new Error(`question ${id}: ${j.length} judge grades vs ${ref.length} reference grades`);
    for (const [i, r] of ref.entries()) pairs.push({ judge: j[i]!, reference: r });
  }
  return pairs;
}

const code = (s: Support) => SUPPORTS.indexOf(s);

export interface Agreement {
  sentences: number;
  exact: number;
  kappa_support: StatInterval;
  kappa_full: StatInterval;
  /** confusion[reference][judge] in full/partial/none order */
  confusion: number[][];
  citations: { pairs: number; agree: number };
}

export function agreement(pairs: readonly SentencePair[]): Agreement {
  // Uncited sentences are unsupported by rule on both sides, so they would inflate agreement.
  const graded = pairs.filter(p => !p.judge.uncited && !p.reference.uncited);
  if (!graded.length) throw new Error("no cited sentences to compare");
  const kappaOf = (map: (s: Support) => number) => (sample: SentencePair[]) =>
    cohenKappa(sample.map(p => map(p.reference.support)), sample.map(p => map(p.judge.support)));
  const confusion = SUPPORTS.map(() => SUPPORTS.map(() => 0));
  for (const p of graded) confusion[code(p.reference.support)]![code(p.judge.support)]!++;
  let citePairs = 0;
  let citeAgree = 0;
  for (const p of graded) {
    for (const [n, ref] of Object.entries(p.reference.citations)) {
      if (!(n in p.judge.citations)) continue;
      citePairs++;
      if (p.judge.citations[n] === ref) citeAgree++;
    }
  }
  return {
    sentences: graded.length,
    exact: graded.filter(p => p.judge.support === p.reference.support).length / graded.length,
    kappa_support: bootstrapStatistic(graded, kappaOf(code)),
    kappa_full: bootstrapStatistic(graded, kappaOf(s => (s === "full" ? 1 : 0))),
    confusion,
    citations: { pairs: citePairs, agree: citeAgree },
  };
}

const f3 = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : "nan");
const ci = (s: StatInterval) => `${f3(s.value)} [${f3(s.lo)}, ${f3(s.hi)}]`;

export function agreementLines(a: Agreement): string[] {
  return [
    `AGREE n=${a.sentences} exact=${f3(a.exact)} kappa_support=${ci(a.kappa_support)} kappa_full=${ci(a.kappa_full)}`,
    `CONF ref\\judge full/partial/none ${a.confusion.map(r => r.join(",")).join(" | ")}`,
    `CITES pairs=${a.citations.pairs} agree=${a.citations.agree}`,
  ];
}

function main(argv: string[]): number {
  if (argv.length < 2 || argv.length % 2) {
    console.error("usage: tsx scripts/rag/agreement.ts <grades-judge.json> <grades-reference.json> [<judge-2> <reference-2> …]");
    return 2;
  }
  const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Grades;
  const pairs: SentencePair[] = [];
  for (let i = 0; i < argv.length; i += 2) pairs.push(...pairSentences(read(argv[i]!), read(argv[i + 1]!)));
  for (const line of agreementLines(agreement(pairs))) console.log(line);
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
