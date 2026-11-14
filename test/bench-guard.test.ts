/**
 * Bench collection guardrails (#716).
 *
 * `qmd bench` used to run every fixture query against a missing/empty
 * collection and print a wall of 0.00. These tests lock the fail-fast
 * checks and the all-zero stderr warning.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  assertBenchCollectionReady,
  benchSummaryAllZero,
  allZeroBenchWarning,
  runBenchmark,
} from "../src/bench/bench.js";
import { createStore } from "../src/index.js";

describe("assertBenchCollectionReady", () => {
  test("throws when the named collection is missing", () => {
    expect(() => assertBenchCollectionReady([], "eval-docs")).toThrow(/Collection not found: eval-docs/);
    expect(() => assertBenchCollectionReady(
      [{ name: "notes", active_count: 3 }],
      "eval-docs",
    )).toThrow(/Available: notes/);
  });

  test("throws when the named collection has no indexed documents", () => {
    expect(() => assertBenchCollectionReady(
      [{ name: "eval-docs", active_count: 0 }],
      "eval-docs",
    )).toThrow(/has no indexed documents/);
  });

  test("throws when no collection is named and nothing is indexed", () => {
    expect(() => assertBenchCollectionReady([])).toThrow(/No indexed documents found/);
    expect(() => assertBenchCollectionReady(
      [{ name: "notes", active_count: 0 }],
    )).toThrow(/No indexed documents found/);
  });

  test("allows a named collection that has documents", () => {
    expect(() => assertBenchCollectionReady(
      [{ name: "eval-docs", active_count: 6 }],
      "eval-docs",
    )).not.toThrow();
  });

  test("allows an unnamed bench when any collection has documents", () => {
    expect(() => assertBenchCollectionReady(
      [{ name: "notes", active_count: 2 }],
    )).not.toThrow();
  });
});

describe("benchSummaryAllZero", () => {
  const zero = {
    avg_precision: 0,
    avg_recall: 0,
    avg_recall_at_1: 0,
    avg_recall_at_3: 0,
    avg_recall_at_5: 0,
    avg_mrr: 0,
    avg_f1: 0,
    avg_latency_ms: 12,
  };

  test("is true when every backend scored zero", () => {
    expect(benchSummaryAllZero({ bm25: zero, vector: { ...zero } })).toBe(true);
  });

  test("is false when any backend has a hit", () => {
    expect(benchSummaryAllZero({
      bm25: { ...zero, avg_recall: 0.5, avg_mrr: 1 },
      vector: zero,
    })).toBe(false);
  });

  test("is false for an empty summary", () => {
    expect(benchSummaryAllZero({})).toBe(false);
  });
});

describe("allZeroBenchWarning", () => {
  test("points at qmd ls for the fixture collection", () => {
    expect(allZeroBenchWarning("eval-docs")).toContain("qmd ls eval-docs");
    expect(allZeroBenchWarning()).toContain("qmd ls");
  });
});

describe("runBenchmark collection guard", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "qmd-bench-guard-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function writeFixture(collection: string, query = "API versioning", expected = "api.md") {
    const fixturePath = join(dir, "fixture.json");
    writeFileSync(fixturePath, JSON.stringify({
      description: "guardrail fixture",
      version: 1,
      collection,
      queries: [{
        id: "exact-api",
        query,
        type: "exact",
        description: "keyword",
        expected_files: [expected],
        expected_in_top_k: 1,
      }],
    }));
    return fixturePath;
  }

  test("errors before searching when the fixture collection does not exist", async () => {
    const fixturePath = writeFixture("eval-docs");
    const dbPath = join(dir, "index.sqlite");
    await expect(runBenchmark(fixturePath, {
      json: true,
      dbPath,
      backends: ["bm25"],
      config: { collections: { notes: { path: dir, pattern: "**/*.md" } } },
    })).rejects.toThrow(/Collection not found: eval-docs/);
  });

  test("errors before searching when the collection exists but has no documents", async () => {
    const docs = join(dir, "docs");
    await mkdir(docs, { recursive: true });
    const fixturePath = writeFixture("docs");
    const dbPath = join(dir, "index.sqlite");
    await expect(runBenchmark(fixturePath, {
      json: true,
      dbPath,
      backends: ["bm25"],
      config: { collections: { docs: { path: docs, pattern: "**/*.md" } } },
    })).rejects.toThrow(/has no indexed documents/);
  });

  test("runs bm25 against an indexed collection", async () => {
    const docs = join(dir, "docs");
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, "api.md"), "# API versioning\n\nUse /v1 and /v2 endpoints.\n");
    const dbPath = join(dir, "index.sqlite");
    const config = { collections: { docs: { path: docs, pattern: "**/*.md" } } };
    const store = await createStore({ dbPath, config });
    await store.update();
    await store.close();

    const fixturePath = writeFixture("docs", "API versioning", "api.md");
    const stderr: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return origWrite(chunk as string, ...(rest as []));
    }) as typeof process.stderr.write;
    try {
      const result = await runBenchmark(fixturePath, {
        json: true,
        dbPath,
        backends: ["bm25"],
        config,
      });
      expect(result.summary.bm25?.avg_recall).toBeGreaterThan(0);
      expect(stderr.join("")).not.toContain("All benchmark scores were 0.00");
    } finally {
      process.stderr.write = origWrite;
    }
  });

  test("a backend that throws records the error next to its zero scores", async () => {
    const docs = join(dir, "docs");
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, "api.md"), "# API versioning\n\nUse /v1 and /v2 endpoints.\n");
    const dbPath = join(dir, "index.sqlite");
    const config = { collections: { docs: { path: docs, pattern: "**/*.md" } } };
    const store = await createStore({ dbPath, config });
    await store.update();
    await store.close();

    // A typed query with an unprefixed second line makes bm25's parseStructuredQuery throw.
    const fixturePath = writeFixture("docs", "lex: API versioning\nno prefix here", "api.md");
    const result = await runBenchmark(fixturePath, { json: true, dbPath, backends: ["bm25"], config });
    const bm25 = result.results[0]!.backends.bm25!;
    expect(bm25.recall_at_5).toBe(0);
    expect(bm25.error).toMatch(/missing a lex:\/vec:\/hyde:\/intent: prefix/);
  });

  test("warns on stderr when every backend scores zero", async () => {
    const docs = join(dir, "docs");
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, "api.md"), "# API versioning\n\nUse /v1 and /v2 endpoints.\n");
    const dbPath = join(dir, "index.sqlite");
    const config = { collections: { docs: { path: docs, pattern: "**/*.md" } } };
    const store = await createStore({ dbPath, config });
    await store.update();
    await store.close();

    const fixturePath = writeFixture("docs", "zzzz-no-such-token-in-corpus", "missing.md");
    const stderr: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return origWrite(chunk as string, ...(rest as []));
    }) as typeof process.stderr.write;
    try {
      const result = await runBenchmark(fixturePath, {
        json: true,
        dbPath,
        backends: ["bm25"],
        config,
      });
      expect(result.summary.bm25?.avg_recall).toBe(0);
      expect(stderr.join("")).toContain("All benchmark scores were 0.00");
      expect(stderr.join("")).toContain("qmd ls docs");
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

describe("bench multi -c CLI guard", () => {
  // `qmd bench -c a -c b` used to benchmark only `a` and silently drop `b`,
  // burying a typo'd second collection. The CLI now rejects that outright.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const qmdScript = join(repoRoot, "src", "cli", "qmd.ts");
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

  function runBenchCli(args: string[], env: Record<string, string>, cwd: string) {
    const cmdArgs = isBun ? [qmdScript, ...args] : [tsxCli, qmdScript, ...args];
    return spawnSync(process.execPath, cmdArgs, {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, ...env },
      timeout: 120_000,
    });
  }

  test("rejects multiple -c flags instead of silently using the first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qmd-bench-multic-"));
    try {
      const fixturePath = join(dir, "fixture.json");
      writeFileSync(fixturePath, JSON.stringify({
        description: "multi-c guard",
        version: 1,
        queries: [{
          id: "q1",
          query: "api versioning",
          type: "exact",
          description: "kw",
          expected_files: ["api.md"],
          expected_in_top_k: 1,
        }],
      }));
      const res = runBenchCli(
        ["bench", fixturePath, "-c", "collA", "-c", "collB"],
        {
          INDEX_PATH: join(dir, "index.sqlite"),
          QMD_CONFIG_DIR: dir,
          QMD_DOCTOR_DEVICE_PROBE: "0",
        },
        dir,
      );
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain("accepts only one -c");
      expect(res.stderr).toContain("collA, collB");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a single -c still flows through to the bench collection guard", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qmd-bench-singlec-"));
    try {
      const fixturePath = join(dir, "fixture.json");
      writeFileSync(fixturePath, JSON.stringify({
        description: "single-c passthrough",
        version: 1,
        queries: [{
          id: "q1",
          query: "api versioning",
          type: "exact",
          description: "kw",
          expected_files: ["api.md"],
          expected_in_top_k: 1,
        }],
      }));
      const res = runBenchCli(
        ["bench", fixturePath, "--json", "-c", "onlyone"],
        {
          INDEX_PATH: join(dir, "index.sqlite"),
          QMD_CONFIG_DIR: dir,
          QMD_DOCTOR_DEVICE_PROBE: "0",
        },
        dir,
      );
      // Not the multi-c rejection: the single collection reaches runBenchmark,
      // whose fail-fast guard reports it (no backends run, no model needed).
      expect(res.status).not.toBe(0);
      expect(res.stderr).not.toContain("accepts only one -c");
      expect(res.stderr).toContain("Collection not found: onlyone");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runBenchmark empty-run guard", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "qmd-bench-empty-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function writeQueries(queries: unknown[]) {
    const fixturePath = join(dir, "fixture.json");
    writeFileSync(fixturePath, JSON.stringify({
      description: "empty-run fixture",
      version: 1,
      collection: "docs",
      queries,
    }));
    return fixturePath;
  }

  function oneQuery() {
    return [{
      id: "exact-api",
      query: "API versioning",
      type: "exact",
      description: "keyword",
      expected_files: ["api.md"],
      expected_in_top_k: 1,
    }];
  }

  test("rejects a fixture with zero queries instead of reporting success", async () => {
    const fixturePath = writeQueries([]);
    // No store setup: the empty fixture must fail before any DB is touched.
    await expect(runBenchmark(fixturePath, {
      json: true,
      dbPath: join(dir, "index.sqlite"),
      backends: ["bm25"],
    })).rejects.toThrow(/has no queries/);
  });

  test("rejects an unknown-backend filter and names the bad backend", async () => {
    const fixturePath = writeQueries(oneQuery());
    await expect(runBenchmark(fixturePath, {
      json: true,
      dbPath: join(dir, "index.sqlite"),
      backends: ["nope"],
    })).rejects.toThrow(/Unknown backend\(s\): nope/);
  });

  test("a partially valid backend filter still runs the known backends", async () => {
    const docs = join(dir, "docs");
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, "api.md"), "# API versioning\n\nUse /v1 and /v2 endpoints.\n");
    const dbPath = join(dir, "index.sqlite");
    const config = { collections: { docs: { path: docs, pattern: "**/*.md" } } };
    const store = await createStore({ dbPath, config });
    await store.update();
    await store.close();

    const fixturePath = writeQueries(oneQuery());
    const result = await runBenchmark(fixturePath, {
      json: true,
      dbPath,
      backends: ["bm25", "nope"],
      config,
    });
    expect(Object.keys(result.summary)).toEqual(["bm25"]);
  });
});
