/**
 * qmd cleanup must drop content pinned only by inactive documents and compact
 * FTS5 so a wrong-directory update can actually shrink the index (#550).
 */
import { describe, test, expect, afterEach } from "vitest";
import { mkdtemp, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStore,
  hashContent,
  insertContent,
  insertDocument,
  deactivateDocument,
  deleteInactiveDocuments,
  cleanupOrphanedContent,
  countOrphanedContent,
  previewCleanup,
  removeCollection,
  runCleanup,
  type Store,
} from "../src/store.js";

let store: Store | null = null;

async function openStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "qmd-cleanup-"));
  store = createStore(join(dir, "index.sqlite"));
  return store;
}

afterEach(async () => {
  if (!store) return;
  const path = store.dbPath;
  store.close();
  store = null;
  try { await unlink(path); } catch { /* ignore */ }
  try { await unlink(`${path}-wal`); } catch { /* ignore */ }
  try { await unlink(`${path}-shm`); } catch { /* ignore */ }
});

async function seedDocs(s: Store, keepBody: string, dropBody: string) {
  const now = new Date().toISOString();
  const keepHash = await hashContent(keepBody);
  const dropHash = await hashContent(dropBody);
  insertContent(s.db, keepHash, keepBody, now);
  insertContent(s.db, dropHash, dropBody, now);
  insertDocument(s.db, "docs", "keep.md", "Keep", keepHash, now, now);
  insertDocument(s.db, "docs", "drop.md", "Drop", dropHash, now, now);
  return { keepHash, dropHash };
}

describe("qmd cleanup reclaim (#550)", () => {
  test("deactivating a document removes it from FTS but leaves content until cleanup", async () => {
    const s = await openStore();
    const { dropHash } = await seedDocs(s, "keepuniquealpha body", "dropuniqueomega body");

    expect(s.db.prepare(`SELECT count(*) as c FROM documents_fts`).get()).toEqual({ c: 2 });

    deactivateDocument(s.db, "docs", "drop.md");
    expect(s.db.prepare(`SELECT count(*) as c FROM documents_fts`).get()).toEqual({ c: 1 });
    expect(countOrphanedContent(s.db)).toBe(1);
    expect(previewCleanup(s.db)).toMatchObject({ inactiveDocs: 1, orphanedContent: 1 });

    // Historical bug: deleting the tombstone did not drop the content row.
    deleteInactiveDocuments(s.db);
    expect(s.db.prepare(`SELECT count(*) as c FROM documents`).get()).toEqual({ c: 1 });
    expect(s.db.prepare(`SELECT count(*) as c FROM content`).get()).toEqual({ c: 2 });
    expect(s.db.prepare(`SELECT count(*) as c FROM content WHERE hash = ?`).get(dropHash)).toEqual({ c: 1 });

    expect(cleanupOrphanedContent(s.db)).toBe(1);
    expect(s.db.prepare(`SELECT count(*) as c FROM content`).get()).toEqual({ c: 1 });
    expect(s.db.prepare(`SELECT count(*) as c FROM content WHERE hash = ?`).get(dropHash)).toEqual({ c: 0 });
  });

  test("runCleanup drops inactive docs, orphaned content, and leftover FTS rows", async () => {
    const s = await openStore();
    await seedDocs(s, "keepuniquealpha body", "dropuniqueomega body");
    deactivateDocument(s.db, "docs", "drop.md");

    const stats = runCleanup(s.db);
    expect(stats.inactiveDocs).toBe(1);
    expect(stats.orphanedContent).toBe(1);
    expect(s.db.prepare(`SELECT count(*) as c FROM documents`).get()).toEqual({ c: 1 });
    expect(s.db.prepare(`SELECT count(*) as c FROM content`).get()).toEqual({ c: 1 });
    expect(s.db.prepare(`SELECT count(*) as c FROM documents_fts`).get()).toEqual({ c: 1 });
    expect(s.db.prepare(`SELECT path FROM documents WHERE active = 1`).get()).toEqual({ path: "keep.md" });

    const ftsHit = s.db.prepare(
      `SELECT count(*) as c FROM documents_fts WHERE documents_fts MATCH 'keepuniquealpha'`
    ).get() as { c: number };
    expect(ftsHit.c).toBe(1);
  });

  test("runCleanup keeps content still referenced by an active document", async () => {
    const s = await openStore();
    const now = new Date().toISOString();
    const shared = await hashContent("shareduniquebody");
    insertContent(s.db, shared, "shareduniquebody", now);
    insertDocument(s.db, "docs", "keep.md", "Keep", shared, now, now);
    insertDocument(s.db, "docs", "drop.md", "Drop", shared, now, now);
    deactivateDocument(s.db, "docs", "drop.md");

    const stats = runCleanup(s.db);
    expect(stats.inactiveDocs).toBe(1);
    expect(stats.orphanedContent).toBe(0);
    expect(s.db.prepare(`SELECT count(*) as c FROM content`).get()).toEqual({ c: 1 });
    expect(s.db.prepare(`SELECT count(*) as c FROM documents`).get()).toEqual({ c: 1 });
  });

  test("preview and run agree on orphaned vectors when the vec table is unavailable (#768)", async () => {
    const s = await openStore();
    const now = new Date().toISOString();
    // content_vectors-only orphan: no referencing document and no vectors_vec
    // table (e.g. embedded without sqlite-vec, or a DB reopened without vec0).
    // Seeding touches the plain table only, so no vec0 module load is needed.
    s.db.prepare(`
      INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embed_fingerprint, total_chunks, embedded_at)
      VALUES ('orphanhash', 0, 0, 'test', '', 1, ?)
    `).run(now);

    // The run path cannot touch vectors_vec here, so the preview must not
    // promise removals the run cannot deliver.
    const preview = previewCleanup(s.db);
    expect(preview.orphanedVectors).toBe(0);

    const stats = runCleanup(s.db);
    expect(stats.orphanedVectors).toBe(0);
    expect(preview.orphanedVectors).toBe(stats.orphanedVectors);

    // Graceful degradation keeps the row: it is still reported by status via
    // countOrphanedVectors and becomes actionable once vec0 is available.
    expect(s.db.prepare(`SELECT count(*) as c FROM content_vectors`).get()).toEqual({ c: 1 });
  });
});

describe("removeCollection tombstone GC", () => {
  test("removing a collection keeps other collections' tombstone-pinned content", async () => {
    const s = await openStore();
    const now = new Date().toISOString();
    const shared = await hashContent("removetombstone shared body");
    const unique = await hashContent("removetombstone unique body");
    insertContent(s.db, shared, "removetombstone shared body", now);
    insertContent(s.db, unique, "removetombstone unique body", now);
    insertDocument(s.db, "aa", "a.md", "A", shared, now, now);
    insertDocument(s.db, "bb", "b.md", "B", shared, now, now);
    insertDocument(s.db, "bb", "solo.md", "Solo", unique, now, now);
    // aa's row is an inactive tombstone sharing its content hash with bb.
    deactivateDocument(s.db, "aa", "a.md");

    const result = removeCollection(s.db, "bb");

    // aa's tombstone row survives (no FK CASCADE reach) and its content stays pinned.
    expect(s.db.prepare(`SELECT active FROM documents WHERE collection = 'aa' AND path = 'a.md'`).get()).toEqual({ active: 0 });
    expect(s.db.prepare(`SELECT count(*) as c FROM content WHERE hash = ?`).get(shared)).toEqual({ c: 1 });
    // bb's truly-orphaned unique hash is still collected, and the counter
    // reports actual document rows removed (Statement.changes also counts
    // FTS trigger/shadow writes, so it cannot be used here).
    expect(result).toEqual({ deletedDocs: 2, cleanedHashes: 1 });
    expect(s.db.prepare(`SELECT count(*) as c FROM content WHERE hash = ?`).get(unique)).toEqual({ c: 0 });
    expect(s.db.prepare(`SELECT count(*) as c FROM documents WHERE collection = 'bb'`).get()).toEqual({ c: 0 });
  });

  test("removing a collection with no shared hashes reports exact counts", async () => {
    const s = await openStore();
    const now = new Date().toISOString();
    const hash = await hashContent("removetombstone solo collection body");
    insertContent(s.db, hash, "removetombstone solo collection body", now);
    insertDocument(s.db, "solo", "s.md", "S", hash, now, now);

    const result = removeCollection(s.db, "solo");

    expect(result).toEqual({ deletedDocs: 1, cleanedHashes: 1 });
    expect(s.db.prepare(`SELECT count(*) as c FROM documents`).get()).toEqual({ c: 0 });
    expect(s.db.prepare(`SELECT count(*) as c FROM content`).get()).toEqual({ c: 0 });
  });
});
