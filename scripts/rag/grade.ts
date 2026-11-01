/**
 * grade.ts — judge every cited answer sentence against the chunks it cites.
 *
 *   tsx scripts/rag/grade.ts <contexts.json> <answers.json> <out-grades.json>
 *
 * One judge call per cited sentence. The judge sees the question, the sentence and only the
 * chunks the sentence cites, and returns (a) whether those chunks together support the sentence
 * — full, partial or none — and (b) for each cited chunk, whether it alone supports it. A
 * sentence with no citation is not sent: it is recorded as unsupported and uncited. The rubric
 * is test/fixtures/ko-vault/rag/faithfulness.md, and its hash is recorded with the grades.
 *
 * Env: RAG_JUDGE_MODEL (qwen3:8b) · OLLAMA_HOST · RAG_CORPUS (test/fixtures/ko-vault) · RAG_COMMIT
 * Exit: 0 every sentence graded · 2 a reply failed validation twice, or bad input.
 * A question with a failed sentence is recorded under `errors` and gets no grades.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SentenceGrade, Support } from "../../src/bench/rag-metrics.js";
import { ollamaChat, type Chat } from "../judge/ollama.js";
import type { Answer, Answers } from "./answer.js";
import type { Contexts, RetrievedChunk } from "./retrieve.js";

export const SUPPORTS: readonly Support[] = ["full", "partial", "none"];

export const GRADE_SCHEMA = {
  type: "object",
  properties: {
    support: { type: "string", enum: SUPPORTS },
    citations: {
      type: "array",
      items: { type: "object", properties: { n: { type: "integer" }, supports: { type: "boolean" } }, required: ["n", "supports"] },
    },
  },
  required: ["support", "citations"],
} as const;

export function systemPrompt(rubric: string): string {
  return [
    "너는 검색 기반 답변의 근거를 확인하는 평가자다. 아래 기준표대로 판정한다.",
    "",
    rubric.trim(),
    "",
    '응답은 JSON 하나다: {"support": "full|partial|none", "citations": [{"n": 1, "supports": true}]}. ' +
      "인용 문서마다 정확히 한 번씩 판정한다.",
  ].join("\n");
}

export function userPrompt(question: string, sentence: string, cited: readonly { n: number; chunk: RetrievedChunk }[]): string {
  const docs = cited.map(c => `[${c.n}] ${c.chunk.title}\n${c.chunk.text}`).join("\n\n");
  return `질문: ${question}\n\n판정할 문장: ${sentence}\n\n인용 문서:\n${docs}`;
}

export function parseGrade(content: string, cited: readonly number[]): { grade: SentenceGrade } | { reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { reason: "reply is not JSON" };
  }
  const { support, citations } = (parsed ?? {}) as { support?: unknown; citations?: unknown };
  if (typeof support !== "string" || !SUPPORTS.includes(support as Support)) return { reason: `support ${JSON.stringify(support)} is not full, partial or none` };
  if (!Array.isArray(citations)) return { reason: "citations is not an array" };
  const verdicts: Record<string, boolean> = {};
  for (const c of citations as unknown[]) {
    const { n, supports } = (c ?? {}) as { n?: unknown; supports?: unknown };
    if (typeof n !== "number" || !cited.includes(n)) return { reason: `citation ${JSON.stringify(n)} was not cited` };
    if (typeof supports !== "boolean") return { reason: `citation ${n} has no boolean supports` };
    if (String(n) in verdicts) return { reason: `citation ${n} judged twice` };
    verdicts[String(n)] = supports;
  }
  const missing = cited.filter(n => !(String(n) in verdicts));
  if (missing.length) return { reason: `missing citations ${missing.join(",")}` };
  return { grade: { support: support as Support, citations: verdicts, uncited: false } };
}

export const UNCITED: SentenceGrade = { support: "none", citations: {}, uncited: true };

/** Grades one sentence. One retry, told what was wrong; a second bad reply throws. */
export async function gradeSentence(
  question: string,
  sentence: { text: string; citations: number[] },
  chunks: readonly RetrievedChunk[],
  rubric: string,
  chat: Chat,
): Promise<SentenceGrade> {
  if (!sentence.citations.length) return UNCITED;
  const cited = sentence.citations.map(n => ({ n, chunk: chunks[n - 1]! }));
  const base = userPrompt(question, sentence.text, cited);
  let user = base;
  let reason = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = parseGrade(await chat(systemPrompt(rubric), user), sentence.citations);
    if ("grade" in result) return result.grade;
    reason = result.reason;
    user = `${base}\n\n이전 응답이 형식에 맞지 않았다(${reason}). 인용 문서마다 한 번씩 판정한다.`;
  }
  throw new Error(`grade reply invalid twice: ${reason}`);
}

export async function gradeAnswer(question: string, answer: Answer, chunks: readonly RetrievedChunk[], rubric: string, chat: Chat): Promise<SentenceGrade[]> {
  const grades: SentenceGrade[] = [];
  for (const s of answer.sentences) grades.push(await gradeSentence(question, s, chunks, rubric, chat));
  return grades;
}

export interface Grades {
  description: string;
  conditions: { model: string; answers: string; prompt: string; commit: string; date: string; os: string; cpu: string; rubric_sha256: string; seconds: number };
  /** question id → one grade per answer sentence (empty when the answer abstained) */
  grades: Record<string, SentenceGrade[]>;
  errors: Record<string, string>;
}

export const GRADE_SEED = 42;

async function main(argv: string[]): Promise<number> {
  const [contextsPath, answersPath, outPath] = argv;
  if (!contextsPath || !answersPath || !outPath) {
    console.error("usage: tsx scripts/rag/grade.ts <contexts.json> <answers.json> <out-grades.json>");
    return 2;
  }
  const model = process.env.RAG_JUDGE_MODEL ?? "qwen3:8b";
  const host = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  const corpus = process.env.RAG_CORPUS ?? "test/fixtures/ko-vault";
  const rubric = readFileSync(join(corpus, "rag", "faithfulness.md"), "utf8");
  const contexts = JSON.parse(readFileSync(contextsPath, "utf8")) as Contexts;
  const answers = JSON.parse(readFileSync(answersPath, "utf8")) as Answers;
  const chat = ollamaChat({ host, model, schema: GRADE_SCHEMA, seed: GRADE_SEED });
  const started = Date.now();
  const out: Grades = {
    description: `Sentence-level faithfulness and citation grades by ${model} for ${answersPath}.`,
    conditions: {
      model,
      answers: answersPath,
      prompt: answers.conditions.prompt,
      commit: process.env.RAG_COMMIT ?? "unknown",
      date: new Date().toISOString(),
      os: `${platform()}-${arch()}`,
      cpu: cpus()[0]?.model ?? "unknown",
      rubric_sha256: createHash("sha256").update(rubric).digest("hex"),
      seconds: 0,
    },
    grades: {},
    errors: {},
  };
  for (const [i, q] of contexts.questions.entries()) {
    const answer = answers.answers[q.id];
    if (!answer) {
      out.errors[q.id] = `no answer (${answers.errors[q.id] ?? "missing"})`;
    } else {
      try {
        out.grades[q.id] = await gradeAnswer(q.query, answer, q.chunks, rubric, chat);
      } catch (err) {
        out.errors[q.id] = err instanceof Error ? err.message : String(err);
      }
    }
    console.error(`${i + 1}/${contexts.questions.length} ${q.id}${out.errors[q.id] ? ` ERROR ${out.errors[q.id]}` : ` sentences=${out.grades[q.id]!.length}`}`);
  }
  out.conditions.seconds = Math.round((Date.now() - started) / 1000);
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  return Object.keys(out.errors).length ? 2 : 0;
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
