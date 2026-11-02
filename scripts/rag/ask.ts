/**
 * ask.ts — answer a question from a qmd index, with citations to the retrieved chunks.
 *
 *   tsx scripts/rag/ask.ts --index <index.sqlite> --config <index.yml> [--collection <name>] "질문"
 *
 * Retrieves the top RAG_K chunks the way retrieve.ts does (`full` backend, seam form), answers with
 * the `grounded` prompt (RAG_PROMPT overrides) on RAG_MODEL through Ollama, and prints the answer
 * with [n] markers and the cited sources — or "모른다" when the chunks do not answer it.
 * `--json` prints the chunks and the structured answer instead.
 *
 * Env: RAG_MODEL (gemma3:4b) · RAG_PROMPT (grounded) · RAG_K (5) · OLLAMA_HOST
 */

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createStore } from "../../src/index.js";
import { ollamaChat } from "../judge/ollama.js";
import { ANSWER_NUM_CTX, ANSWER_SCHEMA, ANSWER_SEED, answerQuestion, isPromptVariant, renderAnswer } from "./answer.js";
import { DEFAULT_K, retrieve } from "./retrieve.js";

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { index: { type: "string" }, config: { type: "string" }, collection: { type: "string" }, json: { type: "boolean" } },
  });
  const question = positionals.join(" ").trim();
  if (!values.index || !values.config || !question) {
    console.error('usage: tsx scripts/rag/ask.ts --index <index.sqlite> --config <index.yml> [--collection <name>] [--json] "질문"');
    return 2;
  }
  const variant = process.env.RAG_PROMPT ?? "grounded";
  if (!isPromptVariant(variant)) throw new Error(`unknown RAG_PROMPT ${variant}`);
  const k = Number(process.env.RAG_K ?? DEFAULT_K);
  if (!Number.isInteger(k) || k < 1) throw new Error(`RAG_K must be a positive integer, got ${process.env.RAG_K}`);
  const chat = ollamaChat({
    host: process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
    model: process.env.RAG_MODEL ?? "gemma3:4b",
    schema: ANSWER_SCHEMA,
    seed: ANSWER_SEED,
    numCtx: ANSWER_NUM_CTX,
  });
  const store = await createStore({ dbPath: values.index, configPath: values.config });
  try {
    const collection = values.collection ?? (await store.getDefaultCollectionNames())[0];
    if (!collection) throw new Error("the index has no collection; pass --collection");
    const chunks = await retrieve(store, question, k, collection);
    const answer = await answerQuestion(question, chunks, variant, chat);
    console.log(values.json ? JSON.stringify({ question, chunks, answer }, null, 2) : renderAnswer(answer, chunks));
  } finally {
    await store.close();
  }
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
