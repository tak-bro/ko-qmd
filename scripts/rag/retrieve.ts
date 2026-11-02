/**
 * retrieve.ts — fetch the top chunks for every question once, so each prompt variant answers
 * from the same context.
 *
 *   tsx scripts/rag/retrieve.ts <index.sqlite> <index.yml> <questions.json> <out-contexts.json>
 *
 * Retrieval is the `full` backend in seam form: `lex:` + `vec:` sub-queries, RRF, then the
 * reranker — no LLM query expansion. Each result contributes its best chunk (the whole note for
 * fixture notes, which fit one chunk). scripts/rag-ko.sh points this at the isolated
 * tmp/bench-ko index that bench-ko.sh builds.
 *
 * Env: RAG_K (5) chunks per question.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createStore, type HybridQueryResult, type QMDStore } from "../../src/index.js";
import { corpusPath } from "../judge/pool.js";

export interface RagQuestion {
  id: string;
  query: string;
  type: "single" | "multi" | "near-miss" | "off-corpus";
  expected_files: string[];
  answer_facts: string[];
  note?: string;
}

export interface QuestionSet {
  description: string;
  collection: string;
  queries: RagQuestion[];
}

export interface RetrievedChunk {
  /** Corpus path, e.g. wiki/bm25-ranking.md */
  file: string;
  title: string;
  text: string;
}

export interface Contexts {
  description: string;
  k: number;
  questions: (RagQuestion & { chunks: RetrievedChunk[] })[];
}

export const DEFAULT_K = 5;

export function toChunks(results: readonly HybridQueryResult[], k: number): RetrievedChunk[] {
  return results.slice(0, k).map(r => ({ file: corpusPath(r.file), title: r.title, text: (r.bestChunk || r.body).trim() }));
}

/** The `full` seam-form search for one question. */
export async function retrieve(store: QMDStore, question: string, k: number, collection: string): Promise<RetrievedChunk[]> {
  const results = await store.search({
    queries: [
      { type: "lex", query: question },
      { type: "vec", query: question },
    ],
    limit: k,
    collection,
    rerank: true,
  });
  return toChunks(results, k);
}

async function main(argv: string[]): Promise<number> {
  const [dbPath, configPath, questionsPath, outPath] = argv;
  if (!dbPath || !configPath || !questionsPath || !outPath) {
    console.error("usage: tsx scripts/rag/retrieve.ts <index.sqlite> <index.yml> <questions.json> <out-contexts.json>");
    return 2;
  }
  const k = Number(process.env.RAG_K ?? DEFAULT_K);
  if (!Number.isInteger(k) || k < 1) throw new Error(`RAG_K must be a positive integer, got ${process.env.RAG_K}`);
  const set = JSON.parse(readFileSync(questionsPath, "utf8")) as QuestionSet;
  const store = await createStore({ dbPath, configPath });
  try {
    const questions: Contexts["questions"] = [];
    for (const [i, q] of set.queries.entries()) {
      const chunks = await retrieve(store, q.query, k, set.collection);
      questions.push({ ...q, chunks });
      console.error(`${i + 1}/${set.queries.length} ${q.id} ${chunks.map(c => c.file).join(" ")}`);
    }
    const out: Contexts = { description: `Top ${k} chunks per question from the full backend (seam form) over ${questionsPath}.`, k, questions };
    writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
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
