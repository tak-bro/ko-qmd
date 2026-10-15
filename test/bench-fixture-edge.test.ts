/**
 * runBenchmark fixture validation + backends filter edges.
 *
 * Pins CURRENT behavior at src/bench/bench.ts runBenchmark:
 * invalid fixture, unknown backend name, empty backends array,
 * and the fixture.collection fallback. Characterization only —
 * no src changes.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { runBenchmark } from "../src/bench/bench.js";
import { createStore } from "../src/index.js";

describe("runBenchmark fixture validation", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "qmd-bench-fixture-edge-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("throws Invalid fixture when queries is missing", async () => {
    const fixturePath = join(dir, "fixture.json");
    writeFileSync(fixturePath, JSON.stringify({ description: "no queries" }));
    await expect(runBenchmark(fixturePath, {
      json: true,
      dbPath: join(dir, "index.sqlite"),
    })).rejects.toThrow(/Invalid fixture: missing 'queries' array/);
  });

  test("throws Invalid fixture when queries is not an array", async () => {
    const fixturePath = join(dir, "fixture.json");
    writeFileSync(fixturePath, JSON.stringify({ queries: "nope" }));
    await expect(runBenchmark(fixturePath, {
      json: true,
      dbPath: join(dir, "index.sqlite"),
    })).rejects.toThrow(/Invalid fixture: missing 'queries' array/);
  });
});

describe("runBenchmark backends filter edges", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "qmd-bench-backends-edge-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function indexedSetup() {
    const docs = join(dir, "docs");
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, "api.md"), "# API versioning\n\nUse /v1 and /v2 endpoints.\n");
    const dbPath = join(dir, "index.sqlite");
    const config = { collections: { docs: { path: docs, pattern: "**/*.md" } } };
    const store = await createStore({ dbPath, config });
    await store.update();
    await store.close();
    return { dbPath, config };
  }

  function writeDocsFixture() {
    const fixturePath = join(dir, "fixture.json");
    writeFileSync(fixturePath, JSON.stringify({
      description: "backends edge fixture",
      version: 1,
      collection: "docs",
      queries: [{
        id: "exact-api",
        query: "API versioning",
        type: "exact",
        description: "keyword",
        expected_files: ["api.md"],
        expected_in_top_k: 1,
      }],
    }));
    return fixturePath;
  }

  test("unknown backend name fails loud instead of reporting an empty summary", async () => {
    const { dbPath, config } = await indexedSetup();
    const fixturePath = writeDocsFixture();
    await expect(runBenchmark(fixturePath, {
      json: true,
      dbPath,
      backends: ["no-such-backend"],
      config,
    })).rejects.toThrow(/Unknown backend\(s\): no-such-backend/);
  });

  test("empty backends array fails loud instead of reporting an empty summary", async () => {
    const { dbPath, config } = await indexedSetup();
    const fixturePath = writeDocsFixture();
    await expect(runBenchmark(fixturePath, {
      json: true,
      dbPath,
      backends: [],
      config,
    })).rejects.toThrow(/Unknown backend/);
  });

  test("backends filter keeps only the requested backend", async () => {
    const { dbPath, config } = await indexedSetup();
    const fixturePath = writeDocsFixture();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await runBenchmark(fixturePath, {
      json: true,
      dbPath,
      backends: ["bm25"],
      config,
    });
    expect(Object.keys(result.results[0]!.backends)).toEqual(["bm25"]);
    expect(Object.keys(result.summary)).toEqual(["bm25"]);
  });
});

describe("runBenchmark fixture.collection fallback", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "qmd-bench-collection-fallback-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function writeNamedFixture(collection?: string) {
    const fixturePath = join(dir, "fixture.json");
    const fixture: Record<string, unknown> = {
      description: "collection fallback fixture",
      version: 1,
      queries: [{
        id: "exact-api",
        query: "API versioning",
        type: "exact",
        description: "keyword",
        expected_files: ["api.md"],
        expected_in_top_k: 1,
      }],
    };
    if (collection !== undefined) fixture.collection = collection;
    writeFileSync(fixturePath, JSON.stringify(fixture));
    return fixturePath;
  }

  function emptyStoreArgs() {
    return {
      json: true as const,
      dbPath: join(dir, "index.sqlite"),
      backends: ["bm25"],
      config: { collections: { notes: { path: dir, pattern: "**/*.md" } } },
    };
  }

  test("uses fixture.collection when options.collection is omitted", async () => {
    const fixturePath = writeNamedFixture("fixture-col");
    await expect(runBenchmark(fixturePath, emptyStoreArgs()))
      .rejects.toThrow(/Collection not found: fixture-col/);
  });

  test("options.collection overrides fixture.collection", async () => {
    const fixturePath = writeNamedFixture("fixture-col");
    await expect(runBenchmark(fixturePath, {
      ...emptyStoreArgs(),
      collection: "override-col",
    })).rejects.toThrow(/Collection not found: override-col/);
  });

  test("no collection anywhere falls back to the unscoped guard", async () => {
    const fixturePath = writeNamedFixture();
    await expect(runBenchmark(fixturePath, emptyStoreArgs()))
      .rejects.toThrow(/No indexed documents found/);
  });
});
