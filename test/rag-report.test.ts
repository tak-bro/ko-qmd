import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { agreement, agreementLines, pairSentences } from "../scripts/rag/agreement.js";
import type { Answers, PromptVariant } from "../scripts/rag/answer.js";
import type { Grades } from "../scripts/rag/grade.js";
import { sha256Text } from "../scripts/rag/provenance.js";
import { buildReport, main, reportLines, type Run } from "../scripts/rag/report.js";
import type { Contexts } from "../scripts/rag/retrieve.js";

const chunk = (file: string) => ({ file, title: file, text: file });

const contexts: Contexts = {
  description: "",
  k: 2,
  questions: [
    { id: "s1", query: "q1", type: "single", expected_files: ["wiki/a.md"], answer_facts: [], chunks: [chunk("wiki/a.md"), chunk("wiki/b.md")] },
    { id: "s2", query: "q2", type: "single", expected_files: ["wiki/c.md"], answer_facts: [], chunks: [chunk("wiki/b.md"), chunk("wiki/a.md")] },
    { id: "n1", query: "q3", type: "near-miss", expected_files: [], answer_facts: [], chunks: [chunk("wiki/a.md")] },
  ],
};

function run(
  prompt: PromptVariant,
  answers: Answers["answers"],
  grades: Grades["grades"],
  errors: Record<string, string> = {},
  sha = "r",
  hashes = { contexts: "c", answers: "a" },
): Run {
  return {
    answers: { description: "", conditions: { model: "gen", prompt, contexts_sha256: hashes.contexts, ollama: "0", commit: "c", date: "", os: "", cpu: "", seconds: 0 }, answers, errors: {} },
    grades: {
      description: "",
      conditions: { model: "judge", think: false, answers: "", answers_sha256: hashes.answers, prompt, ollama: "0", commit: "c", date: "", os: "", cpu: "", rubric_sha256: sha, seconds: 0 },
      grades,
      errors,
    },
  };
}

const yes = { support: "full" as const, citations: { "1": true }, uncited: false };
const no = { support: "none" as const, citations: { "1": false }, uncited: false };

const before = run(
  "baseline",
  {
    s1: { unknown: false, sentences: [{ text: "a", citations: [1] }, { text: "b", citations: [1] }] },
    s2: { unknown: false, sentences: [{ text: "c", citations: [1] }] },
    n1: { unknown: false, sentences: [{ text: "d", citations: [1] }] },
  },
  { s1: [yes, no], s2: [no], n1: [no] },
);
const after = run(
  "grounded",
  {
    s1: { unknown: false, sentences: [{ text: "a", citations: [1] }] },
    s2: { unknown: false, sentences: [{ text: "c", citations: [2] }] },
    n1: { unknown: true, sentences: [] },
  },
  { s1: [yes], s2: [yes], n1: [] },
);

describe("buildReport", () => {
  test("summarizes each run and the paired difference", () => {
    const r = buildReport(contexts, [before, after]);
    expect(r.runs.map(x => x.prompt)).toEqual(["baseline", "grounded"]);
    expect(r.runs[0]!.summary.faithfulness.value).toBeCloseTo((0.5 + 0 + 0) / 3);
    expect(r.runs[1]!.summary.abstain_unanswerable.value).toBe(1);
    expect(r.runs[0]!.summary.cites_expected.value).toBe(0.5);
    expect(r.runs[1]!.summary.context_recall.value).toBe(0.5);
    expect(r.diff!.faithfulness.n).toBe(2);
    expect(r.diff!.faithfulness.mean).toBeCloseTo((0.5 + 1) / 2);
    expect(r.diff!.abstain_unanswerable.mean).toBe(1);
  });

  test("a question that failed in either run is left out of both and listed", () => {
    const failed = run("grounded", { ...after.answers.answers }, { s1: [yes], n1: [] }, { s2: "judge reply invalid twice" });
    const r = buildReport(contexts, [before, failed]);
    expect(r.errors).toEqual(["s2"]);
    expect(r.runs[0]!.summary.questions).toBe(2);
    expect(reportLines(r).at(-1)).toBe("ERRORS s2");
  });

  test("grades that do not match the sentences, or a silent gap, throw", () => {
    const short = run("baseline", before.answers.answers, { ...before.grades.grades, s1: [yes] });
    expect(() => buildReport(contexts, [short])).toThrow(/s1: 1 grades for 2 sentences/);
    const gap = run("baseline", before.answers.answers, { s1: [yes, no], n1: [no] });
    expect(() => buildReport(contexts, [gap])).toThrow(/s2 has no grades and no recorded error/);
  });

  test("lines carry intervals and the DIFF label is after-before", () => {
    const lines = reportLines(buildReport(contexts, [before, after]));
    expect(lines[0]).toBe("RUN prompt=baseline model=gen judge=judge questions=3 sentences=4 partial=0 uncited=0 errors=0");
    expect(lines.find(l => l.startsWith("DIFF grounded-baseline faith="))).toMatch(
      /^DIFF grounded-baseline faith=\+0\.750 \[[-\d.]+, [-\d.]+\] n=2 \(0\.250 -> 1\.000 on those\)$/,
    );
  });

  test("when every question failed somewhere, it throws naming them instead of an empty report", () => {
    const allFailed = run("grounded", after.answers.answers, {}, { s1: "x", s2: "x", n1: "x" });
    expect(() => buildReport(contexts, [before, allFailed])).toThrow(/every question failed in some run: ERRORS n1 s1 s2/);
  });
});

describe("agreement", () => {
  const partial = { support: "partial" as const, citations: { "1": true }, uncited: false };
  const uncited = { support: "none" as const, citations: {}, uncited: true };
  const judge = run("baseline", {}, { s1: [yes, partial, uncited], s2: [no], n1: [yes] }).grades;
  const ref = run("baseline", {}, { s1: [yes, no, uncited], s2: [no], n1: [no] }).grades;

  test("pairs sentences by question and position, skipping questions the judge did not grade", () => {
    const pairs = pairSentences(judge, run("baseline", {}, { ...ref.grades, x9: [yes] }).grades);
    expect(pairs).toHaveLength(5);
    expect(() => pairSentences(judge, run("baseline", {}, { s1: [yes] }).grades)).toThrow(/s1: 3 judge grades vs 1 reference/);
  });

  test("leaves uncited sentences out and fills the confusion matrix reference × judge", () => {
    const a = agreement(pairSentences(judge, ref));
    expect(a.sentences).toBe(4);
    expect(a.exact).toBe(0.5);
    expect(a.confusion).toEqual([
      [1, 0, 0],
      [0, 0, 0],
      [1, 1, 1],
    ]);
    expect(a.citations).toEqual({ pairs: 4, agree: 2 });
    expect(agreementLines(a)[0]).toMatch(/^AGREE n=4 exact=0\.500 kappa_support=/);
  });

  test("pools several judge/reference pairs, and kappa_full counts full vs not full", () => {
    const judge2 = run("grounded", {}, { s1: [no], s2: [yes] }, {}, "r", { contexts: "c", answers: "b" }).grades;
    const ref2 = run("grounded", {}, { s1: [no], s2: [yes] }, {}, "r", { contexts: "c", answers: "b" }).grades;
    const a = agreement([...pairSentences(judge, ref), ...pairSentences(judge2, ref2)]);
    expect(a.sentences).toBe(6);
    // full vs not: ref [1,0,0,0,0,1] judge [1,0,0,1,0,1] → po 5/6, pe (2/6·3/6 + 4/6·3/6) = 1/2, kappa 2/3
    expect(a.kappa_full.value).toBeCloseTo(2 / 3);
  });

  test("grades of different answers files or rubrics are refused", () => {
    const otherAnswers = run("baseline", {}, ref.grades, {}, "r", { contexts: "c", answers: "zzz" }).grades;
    expect(() => pairSentences(judge, otherAnswers)).toThrow(/different answers files/);
    const otherRubric = run("baseline", {}, ref.grades, {}, "other").grades;
    expect(() => pairSentences(judge, otherRubric)).toThrow(/different rubrics/);
  });
});

describe("main", () => {
  const dir = mkdtempSync(join(tmpdir(), "rag-report-"));
  const write = (name: string, v: unknown) => {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(v));
    return p;
  };
  const ctxSha = sha256Text(JSON.stringify(contexts));
  const ctx = write("contexts.json", contexts);
  /** Writes an answers file and its grades with matching hashes, like answer.ts and grade.ts do. */
  const pair = (name: string, r: Run, rubric = "r") => {
    const answers = { ...r.answers, conditions: { ...r.answers.conditions, contexts_sha256: ctxSha } };
    const a = write(`a${name}.json`, answers);
    const g = write(`g${name}.json`, { ...r.grades, conditions: { ...r.grades.conditions, answers_sha256: sha256Text(JSON.stringify(answers)), rubric_sha256: rubric } });
    return [a, g] as const;
  };
  const [aA, gA] = pair("A", before);
  const [aB, gB] = pair("B", after);

  test("writes the report JSON and exits 0", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const out = join(dir, "report.json");
    expect(main([ctx, aA, gA, aB, gB, "--out", out])).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).diff.faithfulness.n).toBe(2);
  });

  test("runs graded on different rubrics, or a wrong argument count, exit 2", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const [aC, gC] = pair("C", after, "other");
    expect(main([ctx, aA, gA, aC, gC])).toBe(2);
    expect(main([ctx, aA])).toBe(2);
  });

  test("grades of another answers file, or answers from other contexts, exit 2", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main([ctx, aA, gB])).toBe(2);
    expect(err).toHaveBeenLastCalledWith(expect.stringMatching(/grades another answers file/));
    const stale = write("aStale.json", before.answers);
    expect(main([ctx, stale, gA])).toBe(2);
    expect(err).toHaveBeenLastCalledWith(expect.stringMatching(/answered from other contexts/));
  });
});
