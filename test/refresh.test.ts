/**
 * refresh.test.ts — the daemon's text-index refresh.
 *
 * The unit half drives createIndexRefresher with fake collections so the staleness rules can
 * be pinned without a filesystem. The integration half runs it against a real store: a note
 * written after indexing has to be findable on the next query, without anyone running
 * `qmd update`, and without the collection's update hook running.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type QMDStore } from "../src/index.js";
import {
  createIndexRefresher,
  createStoreIndexRefresher,
  type RefreshCollection,
  type CollectionSnapshot,
} from "../src/refresh.js";

type FakeCollection = RefreshCollection & { lastIndexedMs: number | null };

const fakeDeps = (collections: FakeCollection[], snapshots: Record<string, CollectionSnapshot>) => {
  const reindexed: string[] = [];
  const snapshotted: string[] = [];
  const errors: string[] = [];
  let clock = 1_000_000;
  const deps = {
    listCollections: () => collections,
    snapshot: async (c: RefreshCollection) => {
      snapshotted.push(c.name);
      return snapshots[c.name]!;
    },
    reindex: async (c: RefreshCollection) => {
      reindexed.push(c.name);
    },
    now: () => clock,
    onError: (name: string) => { errors.push(name); },
  };
  return { deps, reindexed, snapshotted, errors, advance: (ms: number) => { clock += ms; } };
};

const notes: FakeCollection = { name: "notes", path: "/n", pattern: "**/*.md", lastIndexedMs: 500_000 };

describe("createIndexRefresher", () => {
  test("re-indexes a collection whose newest file is newer than its last index", async () => {
    const f = fakeDeps([notes], { notes: { fileCount: 3, newestMtimeMs: 900_000 } });
    await createIndexRefresher(f.deps).refreshIfStale(["notes"]);
    expect(f.reindexed).toEqual(["notes"]);
  });

  test("leaves a collection alone when nothing on disk is newer", async () => {
    const f = fakeDeps([notes], { notes: { fileCount: 3, newestMtimeMs: 400_000 } });
    await createIndexRefresher(f.deps).refreshIfStale(["notes"]);
    expect(f.reindexed).toEqual([]);
  });

  test("does not walk the collection again inside the cooldown", async () => {
    const f = fakeDeps([notes], { notes: { fileCount: 3, newestMtimeMs: 400_000 } });
    const refresher = createIndexRefresher({ ...f.deps, cooldownMs: 30_000 });
    await refresher.refreshIfStale(["notes"]);
    f.advance(10_000);
    await refresher.refreshIfStale(["notes"]);
    expect(f.snapshotted).toEqual(["notes"]);
    f.advance(25_000);
    await refresher.refreshIfStale(["notes"]);
    expect(f.snapshotted).toEqual(["notes", "notes"]);
  });

  test("a touched file whose content did not change does not re-index on every pass", async () => {
    // reindexCollection only bumps modified_at when content changes, so a file whose mtime
    // moved without its content moving stays "newer than the index" forever. Without the
    // refresher remembering its own last pass, every cooldown would re-read the collection.
    const f = fakeDeps([notes], { notes: { fileCount: 3, newestMtimeMs: 900_000 } });
    const refresher = createIndexRefresher({ ...f.deps, cooldownMs: 30_000 });
    await refresher.refreshIfStale(["notes"]);
    f.advance(60_000);
    await refresher.refreshIfStale(["notes"]);
    expect(f.reindexed).toEqual(["notes"]);
  });

  test("a deleted file re-indexes even though nothing got newer", async () => {
    const snapshots = { notes: { fileCount: 3, newestMtimeMs: 400_000 } };
    const f = fakeDeps([notes], snapshots);
    const refresher = createIndexRefresher({ ...f.deps, cooldownMs: 30_000 });
    await refresher.refreshIfStale(["notes"]);
    snapshots.notes = { fileCount: 2, newestMtimeMs: 400_000 };
    f.advance(60_000);
    await refresher.refreshIfStale(["notes"]);
    expect(f.reindexed).toEqual(["notes"]);
  });

  test("a collection that suddenly has no files is left alone, not emptied", async () => {
    // reindexCollection deactivates every document it does not see. An unmounted drive or a
    // network share that dropped looks exactly like "every file was deleted"; a user running
    // `qmd update` by hand chose that outcome, a refresh triggered by a query did not.
    const snapshots = { notes: { fileCount: 3, newestMtimeMs: 400_000 } };
    const f = fakeDeps([notes], snapshots);
    const refresher = createIndexRefresher({ ...f.deps, cooldownMs: 30_000 });
    await refresher.refreshIfStale(["notes"]);
    snapshots.notes = { fileCount: 0, newestMtimeMs: 0 };
    f.advance(60_000);
    await refresher.refreshIfStale(["notes"]);
    expect(f.reindexed).toEqual([]);
  });

  test("only the collections being queried are checked", async () => {
    const other: FakeCollection = { name: "other", path: "/o", pattern: "**/*.md", lastIndexedMs: 0 };
    const f = fakeDeps([notes, other], {
      notes: { fileCount: 1, newestMtimeMs: 900_000 },
      other: { fileCount: 1, newestMtimeMs: 900_000 },
    });
    await createIndexRefresher(f.deps).refreshIfStale(["notes"]);
    expect(f.snapshotted).toEqual(["notes"]);
  });

  test("concurrent queries share one refresh", async () => {
    const f = fakeDeps([notes], { notes: { fileCount: 3, newestMtimeMs: 900_000 } });
    const refresher = createIndexRefresher(f.deps);
    await Promise.all([refresher.refreshIfStale(["notes"]), refresher.refreshIfStale(["notes"])]);
    expect(f.reindexed).toEqual(["notes"]);
  });

  test("a failed collection lookup is reported and does not reject", async () => {
    // The lookup reads the index, and the writer this refresher has to coexist with — the
    // launchd job running `qmd update` — is what makes that read fail with SQLITE_BUSY. The
    // one failure the refresh exists to survive must not be the one that escapes.
    const f = fakeDeps([notes], { notes: { fileCount: 3, newestMtimeMs: 900_000 } });
    const refresher = createIndexRefresher({
      ...f.deps,
      listCollections: () => { throw new Error("database is locked"); },
    });
    await expect(refresher.refreshIfStale(["notes"])).resolves.toBeUndefined();
    expect(f.errors).toEqual(["notes"]);
  });

  test("a failed re-index is reported and does not reject", async () => {
    // Another writer — the launchd job that runs `qmd update` on the same index — can hold
    // the write lock. A refresh that throws would fail the query it was meant to help.
    const f = fakeDeps([notes], { notes: { fileCount: 3, newestMtimeMs: 900_000 } });
    const refresher = createIndexRefresher({
      ...f.deps,
      reindex: async () => { throw new Error("database is locked"); },
    });
    await expect(refresher.refreshIfStale(["notes"])).resolves.toBeUndefined();
    expect(f.errors).toEqual(["notes"]);
  });
});

describe("createStoreIndexRefresher", () => {
  let root: string;
  let docs: string;
  let store: QMDStore;
  let hookMarker: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qmd-refresh-"));
    docs = join(root, "docs");
    hookMarker = join(root, "hook-ran");
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, "old.md"), "# Old\n\nnothing to see\n");
    store = await createStore({
      dbPath: join(root, "index.sqlite"),
      config: {
        collections: {
          docs: { path: docs, pattern: "**/*.md", update: `touch ${hookMarker}` },
        },
      },
    });
    await store.update();
  });

  afterEach(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });

  test("a note written after indexing is findable after the next refresh", async () => {
    expect(await store.searchLex("zanzibar")).toHaveLength(0);
    await writeFile(join(docs, "new.md"), "# New\n\nzanzibar lives here\n");
    // mtime resolution on some filesystems is a second; make the new file unambiguously newer.
    const future = new Date(Date.now() + 5_000);
    await utimes(join(docs, "new.md"), future, future);

    await createStoreIndexRefresher(store).refreshIfStale(["docs"]);

    const hits = await store.searchLex("zanzibar");
    expect(hits.map(h => h.displayPath)).toEqual(["docs/new.md"]);
  });

  test("a collection whose root is gone keeps its documents", async () => {
    const refresher = createStoreIndexRefresher(store, { cooldownMs: 0 });
    await refresher.refreshIfStale(["docs"]);
    await rm(docs, { recursive: true, force: true });
    await refresher.refreshIfStale(["docs"]);
    expect((await store.searchLex("nothing")).map(h => h.displayPath)).toEqual(["docs/old.md"]);
  });

  test("never runs the collection's update hook", async () => {
    await writeFile(join(docs, "new.md"), "# New\n\nzanzibar\n");
    const future = new Date(Date.now() + 5_000);
    await utimes(join(docs, "new.md"), future, future);
    await createStoreIndexRefresher(store).refreshIfStale(["docs"]);
    expect(existsSync(hookMarker)).toBe(false);
  });

  test("keeps the LLM cache — a refresh is not `qmd update`", async () => {
    // store.update() clears llm_cache; a refresh on every changed collection would then make
    // every query after it run expansion and rerank cold.
    store.internal.db.prepare(`INSERT INTO llm_cache (hash, result, created_at) VALUES ('k', 'v', datetime('now'))`).run();
    await writeFile(join(docs, "new.md"), "# New\n\nzanzibar\n");
    const future = new Date(Date.now() + 5_000);
    await utimes(join(docs, "new.md"), future, future);
    await createStoreIndexRefresher(store).refreshIfStale(["docs"]);
    const row = store.internal.db.prepare(`SELECT result FROM llm_cache WHERE hash = 'k'`).get() as { result: string } | undefined;
    expect(row?.result).toBe("v");
  });
});
