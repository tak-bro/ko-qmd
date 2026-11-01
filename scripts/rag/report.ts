/**
 * report.ts — stage-3 numbers for one prompt variant, or a before/after pair.
 *
 *   tsx scripts/rag/report.ts <contexts.json> <answers-A.json> <grades-A.json> [<answers-B.json> <grades-B.json>] [--out report.json]
 *
 * Lines (one RUN block per variant, then DIFF lines for B − A):
 *   RUN        prompt, model, judge, questions, sentences, partial, uncited, errors
 *   FAITH      share of answer sentences fully supported by their cited chunks, mean over answered questions
 *   CITE       share of citations whose chunk alone supports its sentence
 *   GOLDCITE   answered answerable questions that cite an expected file (no judge)
 *   CONTEXT    answerable questions whose expected file reached the prompt (retrieval, no judge)
 *   ABSTAIN    "모른다" rate on near-miss + off-corpus questions (higher is better) and on answerable ones
 *   DIFF       B − A per metric, paired by question, with a 95% bootstrap interval
 * Intervals are 95% bootstrap over questions (seed 20261031, 10000 draws).
 * A question with an answer or grading error is left out of both runs and counted in `errors`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  citationPrecision,
  faithfulness,
  pairedDiff,
  summarizeRun,
  ANSWERABLE,
  type MetricSummary,
  type PairedDiff,
  type QuestionOutcome,
  type RagSummary,
} from "../../src/bench/rag-metrics.js";
import type { Answers } from "./answer.js";
import type { Grades } from "./grade.js";
import type { Contexts } from "./retrieve.js";

export interface Run {
  answers: Answers;
  grades: Grades;
}

export function failedIds(runs: readonly Run[]): Set<string> {
  const ids = new Set<string>();
  for (const r of runs) for (const id of [...Object.keys(r.answers.errors), ...Object.keys(r.grades.errors)]) ids.add(id);
  return ids;
}

/** Joins one run's answers and grades with the contexts. Questions in `skip` are left out. */
export function outcomes(contexts: Contexts, run: Run, skip: ReadonlySet<string>): QuestionOutcome[] {
  const out: QuestionOutcome[] = [];
  for (const q of contexts.questions) {
    if (skip.has(q.id)) continue;
    const answer = run.answers.answers[q.id];
    const grades = run.grades.grades[q.id];
    if (!answer || !grades) throw new Error(`question ${q.id} has no ${answer ? "grades" : "answer"} and no recorded error`);
    if (grades.length !== answer.sentences.length) throw new Error(`question ${q.id}: ${grades.length} grades for ${answer.sentences.length} sentences`);
    const cited = new Set(answer.sentences.flatMap(s => s.citations).map(n => q.chunks[n - 1]!.file));
    out.push({
      id: q.id,
      type: q.type,
      abstained: answer.unknown,
      sentences: grades,
      citedFiles: [...cited],
      contextFiles: q.chunks.map(c => c.file),
      expectedFiles: q.expected_files,
    });
  }
  return out;
}

const abstainUnanswerable = (o: QuestionOutcome) => (ANSWERABLE.has(o.type) ? Number.NaN : o.abstained ? 1 : 0);
const abstainAnswerable = (o: QuestionOutcome) => (ANSWERABLE.has(o.type) ? (o.abstained ? 1 : 0) : Number.NaN);

export interface RagReport {
  runs: { prompt: string; model: string; judge: string; summary: RagSummary }[];
  errors: string[];
  diff?: { faithfulness: PairedDiff; citation_precision: PairedDiff; abstain_unanswerable: PairedDiff; abstain_answerable: PairedDiff };
}

export function buildReport(contexts: Contexts, runs: readonly Run[]): RagReport {
  const skip = failedIds(runs);
  const joined = runs.map(r => outcomes(contexts, r, skip));
  const report: RagReport = {
    runs: runs.map((r, i) => ({ prompt: r.answers.conditions.prompt, model: r.answers.conditions.model, judge: r.grades.conditions.model, summary: summarizeRun(joined[i]!) })),
    errors: [...skip].sort(),
  };
  if (joined.length === 2) {
    const [a, b] = joined as [QuestionOutcome[], QuestionOutcome[]];
    report.diff = {
      faithfulness: pairedDiff(a, b, faithfulness),
      citation_precision: pairedDiff(a, b, citationPrecision),
      abstain_unanswerable: pairedDiff(a, b, abstainUnanswerable),
      abstain_answerable: pairedDiff(a, b, abstainAnswerable),
    };
  }
  return report;
}

const f3 = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : "nan");
const ci = (m: MetricSummary) => `${f3(m.value)} [${f3(m.lo)}, ${f3(m.hi)}] n=${m.n}`;
const d = (x: PairedDiff) => `${x.mean >= 0 ? "+" : ""}${f3(x.mean)} [${f3(x.lo)}, ${f3(x.hi)}] n=${x.n}`;

export function reportLines(r: RagReport): string[] {
  const lines: string[] = [];
  for (const run of r.runs) {
    const s = run.summary;
    lines.push(`RUN prompt=${run.prompt} model=${run.model} judge=${run.judge} questions=${s.questions} sentences=${s.sentences} partial=${s.partial} uncited=${s.uncited} errors=${r.errors.length}`);
    lines.push(`FAITH ${ci(s.faithfulness)}`);
    lines.push(`CITE ${ci(s.citation_precision)}`);
    lines.push(`GOLDCITE ${ci(s.cites_expected)}`);
    lines.push(`CONTEXT ${ci(s.context_recall)}`);
    lines.push(`ABSTAIN unanswerable=${ci(s.abstain_unanswerable)} answerable=${ci(s.abstain_answerable)}`);
  }
  if (r.diff) {
    const [a, b] = r.runs;
    const label = `${b!.prompt}-${a!.prompt}`;
    lines.push(`DIFF ${label} faith=${d(r.diff.faithfulness)}`);
    lines.push(`DIFF ${label} cite=${d(r.diff.citation_precision)}`);
    lines.push(`DIFF ${label} abstain_unanswerable=${d(r.diff.abstain_unanswerable)}`);
    lines.push(`DIFF ${label} abstain_answerable=${d(r.diff.abstain_answerable)}`);
  }
  if (r.errors.length) lines.push(`ERRORS ${r.errors.join(" ")}`);
  return lines;
}

export function main(argv: string[]): number {
  const outAt = argv.indexOf("--out");
  const outPath = outAt >= 0 ? argv[outAt + 1] : undefined;
  const paths = outAt >= 0 ? argv.filter((_, i) => i !== outAt && i !== outAt + 1) : argv;
  if (paths.length !== 3 && paths.length !== 5) {
    console.error("usage: tsx scripts/rag/report.ts <contexts.json> <answers-A.json> <grades-A.json> [<answers-B.json> <grades-B.json>] [--out report.json]");
    return 2;
  }
  const read = <T>(p: string) => JSON.parse(readFileSync(p, "utf8")) as T;
  const contexts = read<Contexts>(paths[0]!);
  const runs: Run[] = [];
  for (let i = 1; i < paths.length; i += 2) runs.push({ answers: read<Answers>(paths[i]!), grades: read<Grades>(paths[i + 1]!) });
  const shas = new Set(runs.map(r => r.grades.conditions.rubric_sha256));
  if (shas.size > 1) {
    console.error("the two runs were graded on different rubrics");
    return 2;
  }
  const report = buildReport(contexts, runs);
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
