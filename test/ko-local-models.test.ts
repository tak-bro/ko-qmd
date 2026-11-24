/**
 * ko-local-models.test.ts — ko-qmd's models stay local after upstream added
 * remote embeddings (OpenAI-compatible) and TypeSafe System One reranking.
 *
 * The daemon runs with the global config's hf: models and no remote options.
 * Neither predicate that switches a model to HTTP may claim them, and building
 * the LLM from them must not reach the network.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_EMBED_MODEL_URI,
  DEFAULT_GENERATE_MODEL_URI,
  DEFAULT_RERANK_MODEL_URI,
  LlamaCpp,
} from "../src/llm.js";
import { isRemoteEmbedModel } from "../src/remote-embed.js";
import { JevReranker, isJevModel } from "../src/jev.js";

/** The models block of ko-qmd's global index.yml. */
const KO_MODELS = {
  embed: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
  generate: "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf",
  rerank: "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ko-qmd models stay local", () => {
  test.each([
    ...Object.values(KO_MODELS),
    DEFAULT_EMBED_MODEL_URI,
    DEFAULT_GENERATE_MODEL_URI,
    DEFAULT_RERANK_MODEL_URI,
  ])("%s is neither a remote embedder nor a TypeSafe reranker", (uri) => {
    expect(isRemoteEmbedModel(uri)).toBe(false);
    expect(isJevModel(uri)).toBe(false);
  });

  test("an LLM built from the ko models keeps their identities and makes no HTTP request", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const llm = new LlamaCpp({ embedModel: KO_MODELS.embed, generateModel: KO_MODELS.generate, rerankModel: KO_MODELS.rerank });
    expect(llm.embedModelName).toBe(KO_MODELS.embed);
    expect(llm.rerankModelName).toBe(KO_MODELS.rerank);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a TypeSafe reranker reports ready before its request, so the rerank deadline bounds the HTTP call", async () => {
    const order: string[] = [];
    vi.spyOn(JevReranker.prototype, "rerank").mockImplementation(async (_query, documents) => {
      order.push("request");
      return { results: documents.map((d, index) => ({ file: d.file, score: 0.5, index })), model: "remote-typesafe:test" };
    });
    const llm = new LlamaCpp({ rerankModel: "typesafe:jev-test" });
    await llm.rerank("q", [{ file: "a.md", text: "a" }], { onModelReady: () => order.push("ready") });
    expect(order).toEqual(["ready", "request"]);
  });
});
