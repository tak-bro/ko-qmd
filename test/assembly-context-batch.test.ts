/**
 * assembly-context-batch.test.ts — final-assembly context lookups are batched.
 *
 * Regression tests for the per-row getContextForFile N+1 in hybridQuery,
 * structuredSearch and vectorSearchQuery assembly: one getContextsForFiles
 * call per assembly, output identical to the per-row version.
 *
 * Run with: bun test assembly-context-batch.test.ts
 * (also runs under vitest: npx vitest run test/assembly-context-batch.test.ts)
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStore,
  syncConfigToDb,
  insertContent,
  insertDocument,
  hashContent,
  getContextsForFiles,
  hybridQuery,
  structuredSearch,
  type Store,
} from "../src/store.js";
import { disposeDefaultLlamaCpp } from "../src/llm.js";

let testDir: string;
let testConfigDir: string;

async function createBatchTestStore(): Promise<Store> {
  const dbPath = join(testDir, `batch-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.QMD_CONFIG_DIR = testConfigDir;
  await writeFile(join(testConfigDir, "index.yml"), "collections: {}\n");
  const store = createStore(dbPath);
  syncConfigToDb(store.db, {
    collections: {
      vault: {
        path: "/test/vault",
        pattern: "**/*.md",
        context: { "/": "General vault context", "/docs": "Docs context" },
      },
    },
    global_context: "Global context",
  } as never);
  const now = new Date().toISOString();
  for (let i = 0; i < 10; i++) {
    const path = `docs/쿼카노트${i}.md`;
    const body = `# 쿼카 노트 ${i}\n\n쿼카는 행복한 동물이다. 고유키워드 quokka${i} 와 공통키워드 quokka.`;
    const hash = await hashContent(body);
    insertContent(store.db, hash, body, now);
    insertDocument(store.db, "vault", path, `쿼카 노트 ${i}`, hash, now, now);
  }
  return store;
}

async function cleanupBatchStore(store: Store): Promise<void> {
  const dbPath = store.dbPath;
  store.close();
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(dbPath);
  } catch {
    // Ignore if file doesn't exist
  }
}

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-batch-test-"));
  testConfigDir = await mkdtemp(join(testDir, "config-"));
});

afterAll(async () => {
  await disposeDefaultLlamaCpp();
  delete process.env.QMD_CONFIG_DIR;
  if (testDir) await rm(testDir, { recursive: true, force: true });
});

describe("assembly context batching", () => {
  test("getContextsForFiles matches per-row getContextForFile (incl. prefix order, global, missing)", async () => {
    const store = await createBatchTestStore();
    try {
      const files = Array.from({ length: 10 }, (_, i) => `qmd://vault/docs/쿼카노트${i}.md`);
      files.push("qmd://vault/없는파일.md", "/unindexed/elsewhere.md");
      const perRow = files.map((f) => store.getContextForFile(f));
      const batch = getContextsForFiles(store.db, files);
      expect(files.map((f) => batch.get(f) ?? null)).toEqual(perRow);
      // prefix ordering: general before specific, global first
      expect(perRow[0]).toBe("Global context\n\nGeneral vault context\n\nDocs context");
      // missing docs resolve to null in both
      expect(perRow[10]).toBeNull();
      expect(perRow[11]).toBeNull();
    } finally {
      await cleanupBatchStore(store);
    }
  });

  test("structuredSearch assembly makes no per-row context calls, same contexts", async () => {
    const store = await createBatchTestStore();
    try {
      let calls = 0;
      const orig = store.getContextForFile;
      (store as { getContextForFile: Store["getContextForFile"] }).getContextForFile = (fp: string) => {
        calls++;
        return orig(fp);
      };
      const results = await structuredSearch(store, [{ type: "lex", query: "쿼카" }], {
        skipRerank: true,
        limit: 10,
      });
      expect(results.length).toBeGreaterThan(0);
      expect(calls).toBe(0);
      for (const r of results) {
        expect(r.context).toBe(orig(r.file));
      }
    } finally {
      await cleanupBatchStore(store);
    }
  });

  test("hybridQuery assembly makes no per-row context calls, same contexts", async () => {
    const store = await createBatchTestStore();
    try {
      let calls = 0;
      const orig = store.getContextForFile;
      (store as { getContextForFile: Store["getContextForFile"] }).getContextForFile = (fp: string) => {
        calls++;
        return orig(fp);
      };
      // Hangul query skips LLM expansion; skipRerank skips the reranker — temp-DB only.
      const results = await hybridQuery(store, "쿼카 행복한 동물", { skipRerank: true, limit: 10 });
      expect(results.length).toBeGreaterThan(0);
      expect(calls).toBe(0);
      for (const r of results) {
        expect(r.context).toBe(orig(r.file));
      }
    } finally {
      await cleanupBatchStore(store);
    }
  });
});
