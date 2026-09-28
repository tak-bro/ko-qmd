/**
 * store-rerank-cache.test.ts - QMD_RERANK_CACHE keeps rerank scores in their own sqlite file,
 * so a store over a fresh index (bench-ko rebuilds its index every run) reuses them.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.js";
import { createStore } from "../src/store.js";

const docs = [{ file: "wiki/a.md", text: "순위 공식 청크" }];

describe("QMD_RERANK_CACHE", () => {
  let root: string;
  let prevEnv: string | undefined;
  let indexCount = 0;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qmd-rerank-cache-"));
    prevEnv = process.env.QMD_RERANK_CACHE;
  });

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.QMD_RERANK_CACHE;
    else process.env.QMD_RERANK_CACHE = prevEnv;
    await rm(root, { recursive: true, force: true });
  });

  // A store over a brand-new index db, with a stub reranker that counts its calls.
  const freshStore = (model = "stub-reranker") => {
    const store = createStore(join(root, `index-${indexCount++}.sqlite`));
    const llmRerank = vi.fn(async (_query: string, documents: { file: string }[]) => ({
      results: documents.map((d) => ({ file: d.file, score: model === "fallback" ? 0.5 : 0.7 })),
      model,
    }));
    store.llm = { rerank: llmRerank, rerankModelName: "stub-reranker" } as any; // any: mock implements only what rerank() reads
    return { store, llmRerank };
  };

  test("a second store over a fresh index reuses the scores", async () => {
    process.env.QMD_RERANK_CACHE = join(root, "rerank-cache.sqlite");
    const first = freshStore();
    await first.store.rerank("순위 공식", docs);
    first.store.close();

    const second = freshStore();
    expect(await second.store.rerank("순위 공식", docs)).toEqual([{ file: "wiki/a.md", score: 0.7 }]);
    expect(first.llmRerank).toHaveBeenCalledTimes(1);
    expect(second.llmRerank).toHaveBeenCalledTimes(0);
    second.store.close();
  });

  test("a different doc-token cap is scored again", async () => {
    process.env.QMD_RERANK_CACHE = join(root, "rerank-cache.sqlite");
    const { store, llmRerank } = freshStore();
    await store.rerank("순위 공식", docs);
    await store.rerank("순위 공식", docs, undefined, undefined, { maxDocTokens: 64 });
    expect(llmRerank).toHaveBeenCalledTimes(2);
    store.close();
  });

  test("without the variable, scores stay with the index", async () => {
    delete process.env.QMD_RERANK_CACHE;
    const first = freshStore();
    await first.store.rerank("순위 공식", docs);
    await first.store.rerank("순위 공식", docs);
    first.store.close();

    const second = freshStore();
    await second.store.rerank("순위 공식", docs);
    expect(first.llmRerank).toHaveBeenCalledTimes(1);
    expect(second.llmRerank).toHaveBeenCalledTimes(1);
    second.store.close();
  });

  const rowCount = (path: string) => {
    const db = openDatabase(path);
    const { c } = db.prepare(`SELECT COUNT(*) AS c FROM llm_cache`).get() as { c: number };
    db.close();
    return c;
  };

  test("rerank scores go to the cache file, not the index", async () => {
    const cachePath = join(root, "rerank-cache.sqlite");
    process.env.QMD_RERANK_CACHE = cachePath;
    const { store } = freshStore();
    const indexPath = store.dbPath;
    await store.rerank("순위 공식", docs);
    store.close();
    expect(rowCount(cachePath)).toBe(1);
    expect(rowCount(indexPath)).toBe(0);
  });

  test("the cache file is never trimmed to the index cache's 1000 rows", async () => {
    const cachePath = join(root, "rerank-cache.sqlite");
    process.env.QMD_RERANK_CACHE = cachePath;
    const { store } = freshStore();
    const many = Array.from({ length: 1005 }, (_, i) => ({ file: `wiki/${i}.md`, text: `청크 ${i}` }));
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    await store.rerank("순위 공식", many);
    random.mockRestore();
    store.close();
    expect(rowCount(cachePath)).toBe(1005);
  });

  test("fallback scores (no rerank context) are not cached", async () => {
    process.env.QMD_RERANK_CACHE = join(root, "rerank-cache.sqlite");
    const fallback = freshStore("fallback");
    await fallback.store.rerank("순위 공식", docs);
    fallback.store.close();

    const real = freshStore();
    expect(await real.store.rerank("순위 공식", docs)).toEqual([{ file: "wiki/a.md", score: 0.7 }]);
    expect(real.llmRerank).toHaveBeenCalledTimes(1);
    real.store.close();
  });
});
