/**
 * Bench structured-query backend fan-out pins (NOTE-TIER-T2 #3).
 *
 * `runBenchmark` used to pin bm25-plain only: every fixture query was a
 * single plain line, so the structured `lex:` fan-out, the `intent:` line,
 * `uniqueFiles` dedup/limit, and the parse-throw→`runQuery`-catch→silent-0
 * path in `src/bench/bench.ts` never executed. These tests pin those paths
 * end-to-end through `runBenchmark` with the model-free bm25 backend only
 * (`vec:`/`hyde:`/hybrid/full need embedding weights — excluded).
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { runBenchmark } from "../src/bench/bench.js";
import { createStore } from "../src/index.js";

describe("runBenchmark structured lex fan-out (bm25)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "qmd-bench-structured-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function indexDocs(files: Record<string, string>) {
    const docs = join(dir, "docs");
    await mkdir(docs, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      await writeFile(join(docs, name), body);
    }
    const dbPath = join(dir, "index.sqlite");
    const config = { collections: { docs: { path: docs, pattern: "**/*.md" } } };
    const store = await createStore({ dbPath, config });
    await store.update();
    await store.close();
    return { dbPath, config };
  }

  function writeFixture(queries: { id: string; query: string; expected_files: string[] }[]) {
    const fixturePath = join(dir, "fixture.json");
    writeFileSync(fixturePath, JSON.stringify({
      description: "structured-query fixture",
      version: 1,
      collection: "docs",
      queries: queries.map(q => ({
        id: q.id,
        query: q.query,
        type: "exact",
        description: "structured lex",
        expected_files: q.expected_files,
        expected_in_top_k: q.expected_files.length,
      })),
    }));
    return fixturePath;
  }

  async function runBm25(fixturePath: string, db: Awaited<ReturnType<typeof indexDocs>>) {
    return runBenchmark(fixturePath, {
      json: true,
      dbPath: db.dbPath,
      backends: ["bm25"],
      config: db.config,
    });
  }

  test("slice 01: multi-line lex: query fans out across lex lines", async () => {
    const db = await indexDocs({
      "apple.md": "# Apple harvest\n\nOrchard apple harvest season guide.\n",
      "banana.md": "# Banana bread\n\nBanana bread recipe with ripe bananas.\n",
    });
    const fixturePath = writeFixture([{
      id: "structured-lex",
      query: "lex: apple harvest\nlex: banana bread",
      expected_files: ["apple.md", "banana.md"],
    }]);

    const result = await runBm25(fixturePath, db);
    const bm25 = result.results[0]!.backends["bm25"]!;
    expect(bm25.recall).toBe(1);
    expect(bm25.matched_files).toEqual(expect.arrayContaining(["apple.md", "banana.md"]));
    expect(result.summary.bm25?.avg_recall).toBeGreaterThan(0);
  });

  test("slice 02: intent: line alongside lex: lines still fans out lex (bm25 ignores intent)", async () => {
    const db = await indexDocs({
      "apple.md": "# Apple harvest\n\nOrchard apple harvest season guide.\n",
      "banana.md": "# Banana bread\n\nBanana bread recipe with ripe bananas.\n",
    });
    const fixturePath = writeFixture([{
      id: "structured-intent",
      query: "intent: Find the fruit growing and baking guides\nlex: apple harvest\nlex: banana bread",
      expected_files: ["apple.md", "banana.md"],
    }]);

    // Must resolve (not reject): bm25 pins current behavior where intent
    // shapes reranking only and the lex fan-out runs regardless.
    const result = await runBm25(fixturePath, db);
    const bm25 = result.results[0]!.backends["bm25"]!;
    expect(bm25.recall).toBe(1);
    expect(bm25.matched_files).toEqual(expect.arrayContaining(["apple.md", "banana.md"]));
  });

  test("slice 03: overlapping lex: lines dedup to unique files within the limit", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) {
      const name = `common-${String(i).padStart(2, "0")}.md`;
      files[name] = `# Common doc ${i}\n\nEvery doc shares the common token vocabulary.\n`;
    }
    const db = await indexDocs(files);
    const expected = Object.keys(files);
    // Two identical lex: lines each match all 12 docs: without dedup the
    // fan-out would hold 24 entries; uniqueFiles caps at the limit (12 here).
    const fixturePath = writeFixture([{
      id: "structured-dedup-limit",
      query: "lex: common token\nlex: common token",
      expected_files: expected,
    }]);

    const result = await runBm25(fixturePath, db);
    const bm25 = result.results[0]!.backends["bm25"]!;
    expect(bm25.recall).toBeGreaterThan(0);
    expect(bm25.top_files.length).toBeGreaterThan(0);
    expect(bm25.top_files.length).toBeLessThanOrEqual(10);
    expect(new Set(bm25.top_files).size).toBe(bm25.top_files.length);
  });

  test("slice 04: malformed structured query is silent-0 (parse throw caught in runQuery)", async () => {
    const db = await indexDocs({
      "apple.md": "# Apple harvest\n\nOrchard apple harvest season guide.\n",
    });
    // Multi-line with a prefix-less line: parseStructuredQuery throws, and
    // runQuery converts it to a zero BackendResult instead of rejecting.
    // (Pinning CURRENT behavior — the silence is questionable, see PR body.)
    const fixturePath = writeFixture([{
      id: "structured-malformed",
      query: "lex: apple harvest\nthis line has no prefix",
      expected_files: ["apple.md"],
    }]);

    const stderr: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return origWrite(chunk as string, ...(rest as []));
    }) as typeof process.stderr.write;
    try {
      const result = await runBm25(fixturePath, db);
      const bm25 = result.results[0]!.backends["bm25"]!;
      expect(bm25.precision_at_k).toBe(0);
      expect(bm25.recall).toBe(0);
      expect(bm25.mrr).toBe(0);
      expect(bm25.hits_at_k).toBe(0);
      expect(bm25.top_files).toEqual([]);
      expect(bm25.matched_files).toEqual([]);
      expect(bm25.unmatched_expected_files).toEqual(["apple.md"]);
      expect(stderr.join("")).toContain("All benchmark scores were 0.00");
    } finally {
      process.stderr.write = origWrite;
    }
  });
});
