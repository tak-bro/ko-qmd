import { describe, expect, test } from "vitest";
import {
  citationPrecision,
  citesExpected,
  contextRecall,
  faithfulness,
  pairedDiff,
  summarizeRun,
  type QuestionOutcome,
  type SentenceGrade,
} from "../src/bench/rag-metrics.js";

const full = (cites: Record<string, boolean> = { "1": true }): SentenceGrade => ({ support: "full", citations: cites, uncited: false });
const partial = (cites: Record<string, boolean> = { "1": false }): SentenceGrade => ({ support: "partial", citations: cites, uncited: false });
const uncited: SentenceGrade = { support: "none", citations: {}, uncited: true };

function outcome(over: Partial<QuestionOutcome>): QuestionOutcome {
  return { id: "q", type: "single", abstained: false, sentences: [], citedFiles: [], contextFiles: [], expectedFiles: ["wiki/a.md"], ...over };
}

describe("per-question metrics", () => {
  test("faithfulness counts only full support, and an uncited sentence as unsupported", () => {
    expect(faithfulness(outcome({ sentences: [full(), partial(), uncited, full()] }))).toBe(0.5);
  });

  test("faithfulness is undefined for an abstention", () => {
    expect(faithfulness(outcome({ abstained: true }))).toBeNaN();
  });

  test("citation precision pools every citation verdict, skipping uncited sentences", () => {
    const o = outcome({ sentences: [full({ "1": true, "2": false }), partial({ "3": false }), uncited] });
    expect(citationPrecision(o)).toBeCloseTo(1 / 3);
    expect(citationPrecision(outcome({ sentences: [uncited] }))).toBeNaN();
  });

  test("citesExpected and contextRecall check files without a judge, only on answerable questions", () => {
    const hit = outcome({ citedFiles: ["wiki/b.md", "wiki/a.md"], contextFiles: ["wiki/a.md"] });
    expect(citesExpected(hit)).toBe(1);
    expect(contextRecall(hit)).toBe(1);
    const miss = outcome({ citedFiles: ["wiki/b.md"], contextFiles: ["wiki/b.md"] });
    expect(citesExpected(miss)).toBe(0);
    expect(contextRecall(miss)).toBe(0);
    expect(citesExpected(outcome({ abstained: true }))).toBeNaN();
    expect(citesExpected(outcome({ type: "near-miss", expectedFiles: [] }))).toBeNaN();
    expect(contextRecall(outcome({ type: "off-corpus", expectedFiles: [] }))).toBeNaN();
  });
});

describe("summarizeRun", () => {
  test("splits abstention by answerability and counts sentences", () => {
    const s = summarizeRun(
      [
        outcome({ id: "a1", sentences: [full(), partial()] }),
        outcome({ id: "a2", abstained: true }),
        outcome({ id: "u1", type: "near-miss", expectedFiles: [], abstained: true }),
        outcome({ id: "u2", type: "off-corpus", expectedFiles: [], sentences: [uncited] }),
      ],
      { iters: 200 },
    );
    expect(s.questions).toBe(4);
    expect(s.abstain_answerable.value).toBe(0.5);
    expect(s.abstain_answerable.n).toBe(2);
    expect(s.abstain_unanswerable.value).toBe(0.5);
    expect(s.faithfulness.value).toBe(0.25);
    expect(s.faithfulness.n).toBe(2);
    expect([s.sentences, s.partial, s.uncited]).toEqual([3, 1, 1]);
    expect(s.faithfulness.lo).toBeLessThanOrEqual(s.faithfulness.value);
    expect(s.faithfulness.hi).toBeGreaterThanOrEqual(s.faithfulness.value);
  });
});

describe("pairedDiff", () => {
  const before = [
    outcome({ id: "q1", sentences: [partial()] }),
    outcome({ id: "q2", sentences: [full(), partial()] }),
    outcome({ id: "q3", abstained: true }),
  ];
  const after = [
    outcome({ id: "q2", sentences: [full()] }),
    outcome({ id: "q1", sentences: [full()] }),
    outcome({ id: "q3", sentences: [full()] }),
  ];

  test("matches by id and uses only questions both runs define", () => {
    const d = pairedDiff(before, after, faithfulness, { iters: 500 });
    expect(d.n).toBe(2);
    expect(d.mean).toBeCloseTo((1 + 0.5) / 2);
    expect(d.lo).toBeGreaterThan(0);
  });

  test("a question missing from the after run throws", () => {
    expect(() => pairedDiff(before, after.slice(1), faithfulness)).toThrow(/q2 is missing/);
  });

  test("no overlap gives NaN with n=0 instead of throwing", () => {
    const d = pairedDiff([outcome({ id: "q1", abstained: true })], [outcome({ id: "q1", sentences: [full()] })], faithfulness);
    expect(d.n).toBe(0);
    expect(d.mean).toBeNaN();
  });
});
