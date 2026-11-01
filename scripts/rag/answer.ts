/**
 * answer.ts — answer each question from its retrieved chunks, with chunk citations.
 *
 *   tsx scripts/rag/answer.ts <contexts.json> <out-answers.json>
 *
 * <contexts.json> comes from retrieve.ts, so every prompt variant answers from the same chunks
 * and a before/after comparison isolates the prompt. The model replies in JSON: a list of
 * sentences, each citing chunk numbers, or `unknown: true` with no sentences ("모른다").
 *
 * Env: RAG_MODEL (gemma3:4b) · RAG_PROMPT (baseline|grounded) · OLLAMA_HOST · RAG_COMMIT
 * Exit: 0 every question answered or abstained · 2 a reply failed validation twice, or bad input.
 * A failed question is recorded under `errors`, never filled in.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { pathToFileURL } from "node:url";
import { ollamaChat, type Chat } from "../judge/ollama.js";
import type { Contexts, RetrievedChunk } from "./retrieve.js";

export interface AnswerSentence {
  text: string;
  /** 1-based chunk numbers as shown in the prompt. */
  citations: number[];
}

export interface Answer {
  unknown: boolean;
  sentences: AnswerSentence[];
}

export const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    unknown: { type: "boolean" },
    sentences: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, citations: { type: "array", items: { type: "integer" } } },
        required: ["text", "citations"],
      },
    },
  },
  required: ["unknown", "sentences"],
} as const;

const FORMAT =
  '응답은 JSON 하나다: {"unknown": false, "sentences": [{"text": "문장", "citations": [1]}]}. ' +
  'citations 는 문서 번호 목록이다. 답할 수 없으면 {"unknown": true, "sentences": []}.';

/**
 * The two prompts compared in stage 3. `grounded` is `baseline` plus four rules: documents only,
 * one claim per sentence, cite only chunks that state the sentence, and abstain on near misses.
 */
export const PROMPTS = {
  baseline: [
    "너는 검색된 문서로 질문에 답하는 도우미다. 아래 문서를 참고해 한국어로 간결하게 답한다.",
    "문장마다 근거가 된 문서 번호를 citations 에 단다. 문서로 답할 수 없으면 unknown 을 true 로 한다.",
    FORMAT,
  ].join("\n"),
  grounded: [
    "너는 검색된 문서로 질문에 답하는 도우미다. 아래 문서를 참고해 한국어로 간결하게 답한다.",
    "문장마다 근거가 된 문서 번호를 citations 에 단다. 문서로 답할 수 없으면 unknown 을 true 로 한다.",
    "규칙:",
    "- 문서에 적힌 내용만 쓴다. 상식이나 배경지식으로 내용을 보태지 않는다.",
    "- 한 문장에는 주장 하나만 쓴다.",
    "- citations 에는 그 문장의 내용이 실제로 적힌 문서 번호만 넣는다. 관련만 있는 문서는 넣지 않는다.",
    "- 질문이 묻는 바로 그 내용이 문서에 없으면, 주제가 비슷한 문서가 있어도 unknown 을 true 로 하고 sentences 를 비운다.",
    FORMAT,
  ].join("\n"),
} as const;

export type PromptVariant = keyof typeof PROMPTS;

export function isPromptVariant(v: string): v is PromptVariant {
  return Object.hasOwn(PROMPTS, v);
}

export function userPrompt(question: string, chunks: readonly RetrievedChunk[]): string {
  const docs = chunks.map((c, i) => `[${i + 1}] ${c.title}\n${c.text}`).join("\n\n");
  return `질문: ${question}\n\n문서:\n${docs || "(검색된 문서 없음)"}`;
}

/** Validates a reply against the chunk count. Returns the answer or why it was rejected. */
export function parseAnswer(content: string, chunkCount: number): { answer: Answer } | { reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { reason: "reply is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) return { reason: "reply is not an object" };
  const { unknown, sentences } = parsed as { unknown?: unknown; sentences?: unknown };
  if (typeof unknown !== "boolean") return { reason: "unknown is not a boolean" };
  if (!Array.isArray(sentences)) return { reason: "sentences is not an array" };
  const out: AnswerSentence[] = [];
  for (const s of sentences as unknown[]) {
    const { text, citations } = (s ?? {}) as { text?: unknown; citations?: unknown };
    if (typeof text !== "string" || !Array.isArray(citations)) return { reason: "a sentence lacks text or citations" };
    if (!text.trim()) continue;
    const nums = citations as unknown[];
    const bad = nums.find(n => !Number.isInteger(n) || (n as number) < 1 || (n as number) > chunkCount);
    if (bad !== undefined) return { reason: `citation ${JSON.stringify(bad)} is not a document number 1-${chunkCount}` };
    out.push({ text: text.trim(), citations: [...new Set(nums as number[])] });
  }
  if (unknown) return { answer: { unknown: true, sentences: [] } };
  if (!out.length) return { reason: "unknown is false but there are no sentences" };
  return { answer: { unknown: false, sentences: out } };
}

/** One retry, told what was wrong; a second bad reply throws. */
export async function answerQuestion(question: string, chunks: readonly RetrievedChunk[], variant: PromptVariant, chat: Chat): Promise<Answer> {
  const base = userPrompt(question, chunks);
  let user = base;
  let reason = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = parseAnswer(await chat(PROMPTS[variant], user), chunks.length);
    if ("answer" in result) return result.answer;
    reason = result.reason;
    user = `${base}\n\n이전 응답이 형식에 맞지 않았다(${reason}). 형식을 지켜 다시 답한다.`;
  }
  throw new Error(`answer reply invalid twice: ${reason}`);
}

/** Plain-text rendering for people: sentences with [n] markers, then the cited sources. */
export function renderAnswer(answer: Answer, chunks: readonly RetrievedChunk[]): string {
  if (answer.unknown) return "모른다 — 검색된 문서에 이 질문의 답이 없다.";
  const body = answer.sentences.map(s => `${s.text}${s.citations.map(n => ` [${n}]`).join("")}`).join(" ");
  const cited = [...new Set(answer.sentences.flatMap(s => s.citations))].sort((a, b) => a - b);
  const sources = cited.map(n => `[${n}] ${chunks[n - 1]!.title} (${chunks[n - 1]!.file})`);
  return [body, "", ...sources].join("\n");
}

export interface Answers {
  description: string;
  conditions: { model: string; prompt: PromptVariant; commit: string; date: string; os: string; cpu: string; seconds: number };
  answers: Record<string, Answer>;
  errors: Record<string, string>;
}

/** Ollama sampling seed for generation. */
export const ANSWER_SEED = 42;
export const ANSWER_NUM_CTX = 16384;

async function main(argv: string[]): Promise<number> {
  const [contextsPath, outPath] = argv;
  if (!contextsPath || !outPath) {
    console.error("usage: tsx scripts/rag/answer.ts <contexts.json> <out-answers.json>");
    return 2;
  }
  const variant = process.env.RAG_PROMPT ?? "baseline";
  if (!isPromptVariant(variant)) throw new Error(`RAG_PROMPT must be one of ${Object.keys(PROMPTS).join(", ")}, got ${variant}`);
  const model = process.env.RAG_MODEL ?? "gemma3:4b";
  const host = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  const contexts = JSON.parse(readFileSync(contextsPath, "utf8")) as Contexts;
  const chat = ollamaChat({ host, model, schema: ANSWER_SCHEMA, seed: ANSWER_SEED, numCtx: ANSWER_NUM_CTX });
  const started = Date.now();
  const out: Answers = {
    description: `Answers by ${model} with the ${variant} prompt (scripts/rag/answer.ts PROMPTS), from ${contextsPath}.`,
    conditions: {
      model,
      prompt: variant,
      commit: process.env.RAG_COMMIT ?? "unknown",
      date: new Date().toISOString(),
      os: `${platform()}-${arch()}`,
      cpu: cpus()[0]?.model ?? "unknown",
      seconds: 0,
    },
    answers: {},
    errors: {},
  };
  for (const [i, q] of contexts.questions.entries()) {
    try {
      out.answers[q.id] = await answerQuestion(q.query, q.chunks, variant, chat);
    } catch (err) {
      out.errors[q.id] = err instanceof Error ? err.message : String(err);
    }
    const a = out.answers[q.id];
    console.error(`${i + 1}/${contexts.questions.length} ${q.id} ${out.errors[q.id] ? `ERROR ${out.errors[q.id]}` : a!.unknown ? "unknown" : `sentences=${a!.sentences.length}`}`);
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
