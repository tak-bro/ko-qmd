/**
 * store-title-fts.test.ts - updateDocumentTitle skips body re-tokenization.
 *
 * Regression tests for the title-only FTS fast path: a title change must
 * update the title in FTS without re-normalizing the (unchanged) body, while
 * a real body change still takes the full rebuild path.
 *
 * Run with: npx vitest run test/store-title-fts.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStore,
  insertContent,
  insertDocument,
  updateDocument,
  updateDocumentTitle,
  normalizeCjkForFTS,
  searchFTS,
  hashContent,
  type Store,
} from "../src/store.js";

const COLLECTION = "col";
const DOC_PATH = "docs/big.md";
const OLD_TITLE = "Original Alpha Title";
const NEW_TITLE = "Revised Beta Title";

// ~105KB body with CJK runs, mirroring the measured slow path.
function makeBody(firstLine: string): string {
  const para =
    "서울특별시 강남구 테헤란로에서 한국어 전문 검색을 테스트합니다. " +
    "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(8) +
    "\n";
  let body = `${firstLine}\n\n`;
  while (body.length < 105 * 1024) body += para;
  return body;
}

describe("updateDocumentTitle FTS fast path", () => {
  let root: string;
  let store: Store;
  let db: any;
  let docId: number;
  let body: string;
  let hash: string;
  const now = new Date().toISOString();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qmd-title-fts-"));
    store = createStore(join(root, "index.sqlite"));
    db = store.db;
    // NOTE: the heading inside the body is generic on purpose — OLD_TITLE
    // lives only in the title column/FTS title field, so title-term searches
    // below prove the FTS title (not the body) changed.
    body = makeBody("# Generic Heading");
    hash = await hashContent(body);
    insertContent(db, hash, body, now);
    docId = insertDocument(db, COLLECTION, DOC_PATH, OLD_TITLE, hash, now, now);
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  test("title-only update preserves the normalized FTS body and filepath", () => {
    const before = db
      .prepare(`SELECT filepath, title, body FROM documents_fts WHERE rowid = ?`)
      .get(docId) as { filepath: string; title: string; body: string };

    updateDocumentTitle(db, docId, NEW_TITLE, now);

    const after = db
      .prepare(`SELECT filepath, title, body FROM documents_fts WHERE rowid = ?`)
      .get(docId) as { filepath: string; title: string; body: string };
    // Body re-tokenization skipped: byte-identical normalized body.
    expect(after.body).toBe(before.body);
    expect(after.body).toBe(normalizeCjkForFTS(body));
    expect(after.filepath).toBe(before.filepath);
    // Title IS part of the FTS row: must reflect the change, normalized.
    expect(after.title).toBe(normalizeCjkForFTS(NEW_TITLE));
    const doc = db.prepare(`SELECT title FROM documents WHERE id = ?`).get(docId) as { title: string };
    expect(doc.title).toBe(NEW_TITLE);
  });

  test("new title is searchable and body terms still hit after title-only update", () => {
    updateDocumentTitle(db, docId, NEW_TITLE, now);

    const hitsNew = searchFTS(db, "Revised", 10, COLLECTION);
    expect(hitsNew.some((r) => r.displayPath === `${COLLECTION}/${DOC_PATH}`)).toBe(true);
    const hitsOld = searchFTS(db, "Original", 10, COLLECTION);
    expect(hitsOld.some((r) => r.displayPath === `${COLLECTION}/${DOC_PATH}`)).toBe(false);
    // Body terms survive the fast path (CJK body was never denormalized).
    const hitsBody = searchFTS(db, "테헤란로", 10, COLLECTION);
    expect(hitsBody.some((r) => r.displayPath === `${COLLECTION}/${DOC_PATH}`)).toBe(true);
  });

  test("body change still takes the full rebuild path", async () => {
    const newBody = makeBody(`# ${NEW_TITLE}`).replaceAll("lorem ipsum", "changed body marker");
    const newHash = await hashContent(newBody);
    insertContent(db, newHash, newBody, now);

    updateDocument(db, docId, NEW_TITLE, newHash, now);

    const fts = db
      .prepare(`SELECT title, body FROM documents_fts WHERE rowid = ?`)
      .get(docId) as { title: string; body: string };
    expect(fts.title).toBe(normalizeCjkForFTS(NEW_TITLE));
    expect(fts.body).toBe(normalizeCjkForFTS(newBody));
    const hits = searchFTS(db, "changed", 10, COLLECTION);
    expect(hits.some((r) => r.displayPath === `${COLLECTION}/${DOC_PATH}`)).toBe(true);
  });

  test("missing FTS row falls back to a full rebuild", () => {
    db.prepare(`DELETE FROM documents_fts WHERE rowid = ?`).run(docId);

    updateDocumentTitle(db, docId, NEW_TITLE, now);

    const fts = db
      .prepare(`SELECT title, body FROM documents_fts WHERE rowid = ?`)
      .get(docId) as { title: string; body: string } | undefined;
    expect(fts).toBeDefined();
    expect(fts!.title).toBe(normalizeCjkForFTS(NEW_TITLE));
    expect(fts!.body).toBe(normalizeCjkForFTS(body));
  });
});
