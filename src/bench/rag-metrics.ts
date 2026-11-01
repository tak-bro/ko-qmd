/**
 * Answer-level metrics for the RAG evaluation (eval stage 3). Pure functions — no I/O, no model.
 *
 * An answer is a list of sentences, each citing chunk numbers, or an abstention ("모른다").
 * A judge grades every cited sentence: does the text of the cited chunks support it (full,
 * partial, none), and does each cited chunk on its own support it. A sentence with no citation
 * is never sent to the judge — it counts as unsupported and its missing citation is tallied.
 */

import { pairedBootstrap, type BootstrapOptions, type Interval } from "./gate.js";
import { bootstrapStatistic, type StatInterval } from "./judge-metrics.js";

export type Support = "full" | "partial" | "none";

export interface SentenceGrade {
  support: Support;
  /** Cited chunk number → whether that chunk alone supports the sentence. Empty when uncited. */
  citations: Record<string, boolean>;
  uncited: boolean;
}

export type QuestionType = "single" | "multi" | "near-miss" | "off-corpus";

export interface QuestionOutcome {
  id: string;
  type: QuestionType;
  /** True when the model said it cannot answer from the documents. */
  abstained: boolean;
  /** One grade per answer sentence; empty when abstained. */
  sentences: SentenceGrade[];
  /** Files the answer cited, as corpus paths. */
  citedFiles: string[];
  /** Files retrieved into the prompt, as corpus paths. */
  contextFiles: string[];
  expectedFiles: string[];
}

export const ANSWERABLE: ReadonlySet<QuestionType> = new Set(["single", "multi"]);

/** Share of sentences fully supported by their cited chunks. NaN when nothing was answered. */
export function faithfulness(o: QuestionOutcome): number {
  if (o.abstained || o.sentences.length === 0) return Number.NaN;
  return o.sentences.filter(s => s.support === "full").length / o.sentences.length;
}

/** Share of citations whose chunk supports its sentence. NaN when the answer cites nothing. */
export function citationPrecision(o: QuestionOutcome): number {
  const verdicts = o.sentences.flatMap(s => Object.values(s.citations));
  return verdicts.length ? verdicts.filter(Boolean).length / verdicts.length : Number.NaN;
}

/** 1 when an answered answerable question cites an expected file, 0 when not, NaN otherwise. */
export function citesExpected(o: QuestionOutcome): number {
  if (!ANSWERABLE.has(o.type) || o.abstained) return Number.NaN;
  return o.citedFiles.some(f => o.expectedFiles.includes(f)) ? 1 : 0;
}

/** 1 when an expected file reached the prompt, 0 when not, NaN for unanswerable questions. */
export function contextRecall(o: QuestionOutcome): number {
  if (!ANSWERABLE.has(o.type)) return Number.NaN;
  return o.contextFiles.some(f => o.expectedFiles.includes(f)) ? 1 : 0;
}

/** Mean over the defined values, NaN when none is defined. */
export function definedMean(values: readonly number[]): number {
  const defined = values.filter(v => !Number.isNaN(v));
  return defined.length ? defined.reduce((s, v) => s + v, 0) / defined.length : Number.NaN;
}

export interface MetricSummary extends StatInterval {
  /** Questions the metric is defined on. */
  n: number;
}

function summarize(outcomes: readonly QuestionOutcome[], per: (o: QuestionOutcome) => number, options: BootstrapOptions): MetricSummary {
  const values = outcomes.map(per);
  return { ...bootstrapStatistic(values, definedMean, options), n: values.filter(v => !Number.isNaN(v)).length };
}

export interface RagSummary {
  questions: number;
  faithfulness: MetricSummary;
  citation_precision: MetricSummary;
  cites_expected: MetricSummary;
  context_recall: MetricSummary;
  /** Abstentions on near-miss and off-corpus questions — higher is better. */
  abstain_unanswerable: MetricSummary;
  /** Abstentions on answerable questions — lower is better. */
  abstain_answerable: MetricSummary;
  sentences: number;
  partial: number;
  uncited: number;
}

export function summarizeRun(outcomes: readonly QuestionOutcome[], options: BootstrapOptions = {}): RagSummary {
  const abstainIf = (answerable: boolean) => (o: QuestionOutcome) =>
    ANSWERABLE.has(o.type) === answerable ? (o.abstained ? 1 : 0) : Number.NaN;
  const all = outcomes.flatMap(o => o.sentences);
  return {
    questions: outcomes.length,
    faithfulness: summarize(outcomes, faithfulness, options),
    citation_precision: summarize(outcomes, citationPrecision, options),
    cites_expected: summarize(outcomes, citesExpected, options),
    context_recall: summarize(outcomes, contextRecall, options),
    abstain_unanswerable: summarize(outcomes, abstainIf(false), options),
    abstain_answerable: summarize(outcomes, abstainIf(true), options),
    sentences: all.length,
    partial: all.filter(s => s.support === "partial").length,
    uncited: all.filter(s => s.uncited).length,
  };
}

export interface PairedDiff extends Interval {
  /** Questions where both runs define the metric. */
  n: number;
}

/**
 * after − before for one per-question metric, over the questions where both runs define it,
 * with a paired bootstrap interval. Questions are matched by id.
 */
export function pairedDiff(
  before: readonly QuestionOutcome[],
  after: readonly QuestionOutcome[],
  per: (o: QuestionOutcome) => number,
  options: BootstrapOptions = {},
): PairedDiff {
  const afterById = new Map(after.map(o => [o.id, o]));
  const deltas: number[] = [];
  for (const b of before) {
    const a = afterById.get(b.id);
    if (!a) throw new Error(`question ${b.id} is missing from the after run`);
    const vb = per(b);
    const va = per(a);
    if (!Number.isNaN(vb) && !Number.isNaN(va)) deltas.push(va - vb);
  }
  if (deltas.length === 0) return { mean: Number.NaN, lo: Number.NaN, hi: Number.NaN, n: 0 };
  return { ...pairedBootstrap(deltas, options), n: deltas.length };
}
