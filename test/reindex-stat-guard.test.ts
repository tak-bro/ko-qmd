/**
 * reindex-stat-guard.test.ts — a file vanishing between read and stat must not
 * abort the whole reindex (T3 #3: unguarded statSync at store.ts:1739/:1747).
 *
 * The read path already skips unreadable files (#460); the stat pair must do
 * the same: skip + report via skippedFiles, same deactivation semantics
 * (seenPaths is marked before the read, so a skipped file keeps its row).
 *
 * Race simulation without timing hacks: the wrapper delegates to the real
 * readFileSync and then performs a REAL unlink, so the ENOENT under test
 * comes from the real statSync on a really-deleted file — exactly the
 * glob→read→stat race (a hook just mutated the tree). The read→stat window
 * contains no macrotask yield (hashContent is sync inside), so no timer can
 * land inside it; interposing on node:fs is the only deterministic seam.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
// vi.mock module factories (importOriginal) are a vitest-only seam — bun's
// runner cannot provide the original module, so this suite is vitest-only.
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import type { CollectionConfig } from "../src/collections.js";

// Absolute real path of the current victim file. Set per-test before calling
// reindexCollection; the mocked readFileSync unlinks it right after a
// successful read — i.e. the file is gone by the time reindexCollection calls
// statSync.
if (!isBun) {
  // oxlint-disable-next-line anti-slop/no-module-mocking
  vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const origReadFileSync = actual.readFileSync;
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>): string => {
      const result = (origReadFileSync as (...a: unknown[]) => string)(...args);
      const p = String(args[0]);
      if (victimRealPath && p === victimRealPath) {
        try {
          actual.unlinkSync(p);
        } catch {
          // Already gone — the race already happened.
        }
      }
      return result;
    },
  };
  });
}

let victimRealPath = "";

import { realpathSync } from "node:fs";
import { createStore, reindexCollection, type Store } from "../src/store.js";

let testDir: string;
let testConfigDir: string;

async function createTestStore(): Promise<Store> {
  const dbPath = join(testDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.QMD_CONFIG_DIR = testConfigDir;
  const emptyConfig: CollectionConfig = { collections: {} };
  await writeFile(join(testConfigDir, "index.yml"), YAML.stringify(emptyConfig));
  return createStore(dbPath);
}

async function cleanupTestDb(store: Store): Promise<void> {
  store.close();
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(store.dbPath);
  } catch {
    // Ignore if file doesn't exist
  }
  delete process.env.QMD_CONFIG_DIR;
}

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-stat-guard-"));
  testConfigDir = await mkdtemp(join(testDir, "config-"));
});

afterAll(async () => {
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe.skipIf(isBun)("reindexCollection stat race guard", () => {
  test("new file deleted between read and stat is skipped+reported, rest completes", async () => {
    const store = await createTestStore();
    const collectionName = "stat-guard-new";
    const collectionPath = join(testDir, `col-new-${Date.now()}`);
    await mkdir(collectionPath, { recursive: true });
    await writeFile(join(collectionPath, "good.md"), "# Good\n\nreadable body\n");
    await writeFile(join(collectionPath, "victim.md"), "# Victim\n\nvanishing body\n");
    victimRealPath = realpathSync(join(collectionPath, "victim.md"));

    try {
      const result = await reindexCollection(store, collectionPath, "**/*.md", collectionName);

      expect(result.indexed).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.skippedFiles).toHaveLength(1);
      expect(result.skippedFiles[0]!.file).toBe("victim.md");
      expect(result.skippedFiles[0]!.code).toBe("ENOENT");

      // The rest of the pass completed and the DB is still usable.
      const paths = store.db.prepare(`
        SELECT path FROM documents WHERE collection = ? AND active = 1 ORDER BY path
      `).all(collectionName) as { path: string }[];
      expect(paths.map(r => r.path)).toEqual(["good.md"]);
    } finally {
      victimRealPath = "";
      await cleanupTestDb(store);
    }
  });

  test("changed file deleted between read and stat keeps its row, rest completes", async () => {
    const store = await createTestStore();
    const collectionName = "stat-guard-changed";
    const collectionPath = join(testDir, `col-changed-${Date.now()}`);
    await mkdir(collectionPath, { recursive: true });
    await writeFile(join(collectionPath, "good.md"), "# Good\n\nreadable body\n");
    await writeFile(join(collectionPath, "victim.md"), "# Victim\n\nversion one\n");

    // Seed the index so victim takes the update branch (changed content → statSync).
    const first = await reindexCollection(store, collectionPath, "**/*.md", collectionName);
    expect(first.indexed).toBe(2);

    await writeFile(join(collectionPath, "victim.md"), "# Victim\n\nversion two\n");
    victimRealPath = realpathSync(join(collectionPath, "victim.md"));

    try {
      const result = await reindexCollection(store, collectionPath, "**/*.md", collectionName);

      expect(result.skipped).toBe(1);
      expect(result.skippedFiles).toHaveLength(1);
      expect(result.skippedFiles[0]!.file).toBe("victim.md");
      expect(result.skippedFiles[0]!.code).toBe("ENOENT");

      const rows = store.db.prepare(`
        SELECT path, active FROM documents WHERE collection = ? ORDER BY path
      `).all(collectionName) as { path: string; active: number }[];
      // Same deactivation semantics as the #460 read guard: seenPaths is
      // marked before the read, so the skipped file's row is NOT deactivated.
      expect(rows).toEqual([
        { path: "good.md", active: 1 },
        { path: "victim.md", active: 1 },
      ]);
    } finally {
      victimRealPath = "";
      await cleanupTestDb(store);
    }
  });
});
