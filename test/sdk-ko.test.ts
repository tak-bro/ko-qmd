/**
 * sdk-ko.test.ts - Regression guard for the ko-qmd app embedding path.
 *
 * The Electron app creates a store with inline config (vault collection +
 * Qwen3 embedding model) and calls searchLex on raw Korean keywords. This test
 * covers that path with BM25 only — no model is loaded.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/index.js";

const QWEN3_EMBED = "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";

let root: string;
let wiki: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "qmd-sdk-ko-"));
  wiki = join(root, "wiki");
  await mkdir(wiki, { recursive: true });
  await writeFile(join(wiki, "search-quality.md"), "# 검색 품질\n\n한국어 문서 검색을 개선하는 방법을 정리한다.\n");
  await writeFile(join(wiki, "embedding.md"), "# 임베딩 모델\n\n벡터 표현을 만드는 모델이다.\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ko-qmd SDK (app embedding path)", () => {
  test("inline config with Qwen3 embed model finds Korean keyword via searchLex", async () => {
    const store = await createStore({
      dbPath: join(root, "index.sqlite"),
      config: {
        collections: { ko: { path: wiki, pattern: "**/*.md" } },
        models: { embed: QWEN3_EMBED },
      },
    });
    try {
      await store.update();
      const results = await store.searchLex("검색");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.filepath).toContain("search-quality.md");
    } finally {
      await store.close();
    }
  });
});
