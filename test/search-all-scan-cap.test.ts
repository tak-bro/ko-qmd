/**
 * search-all-scan-cap.test.ts — `--all` + a filter/scope must not silently drop documents.
 *
 * A filtered FTS scan keeps only the top FILTERED_FTS_SCAN_MAX (50k) matches before
 * narrowing, while `--all` asks for 100k. Past the cap, documents vanish with no signal.
 * searchFTS therefore takes an optional `onScanCapped` callback, and `qmd search`
 * turns it into a stderr warning (the 50k cap itself is a perf guard and stays put).
 *
 * Fixture: just over the cap (51k docs) via direct documents/content inserts — the FTS
 * sync triggers index them, so this costs seconds, not a 51k-file update().
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type QMDStore } from "../src/index.js";
import { FILTERED_FTS_SCAN_MAX, searchFTS } from "../src/store.js";
import { buildDocumentFilter } from "../src/filters.js";

let root: string;
let store: QMDStore;

const DOC_COUNT = FILTERED_FTS_SCAN_MAX + 1_000;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "qmd-allcap-"));
  const docs = join(root, "docs");
  mkdirSync(join(docs, "bulk"), { recursive: true });

  store = await createStore({
    dbPath: join(root, "index.sqlite"),
    config: { collections: { docs: { path: docs, pattern: "**/*.md" } } },
  });
  const db = store.internal.db;
  const now = new Date().toISOString();
  const insContent = db.prepare(`INSERT INTO content (hash, doc, created_at) VALUES (?, ?, ?)`);
  const insDoc = db.prepare(
    `INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active) VALUES ('docs', ?, ?, ?, ?, ?, 1)`,
  );
  db.exec(`BEGIN`);
  for (let i = 0; i < DOC_COUNT; i++) {
    const hash = `allcaphash${i}`;
    insContent.run(hash, `allcaprepro wombat document number ${i}`, now);
    insDoc.run(`bulk/doc-${i}.md`, `Doc ${i}`, hash, now, now);
  }
  db.exec(`COMMIT`);
}, 120_000);

afterAll(async () => {
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("filtered --all-scale scan reports the 50k cap instead of silently truncating", () => {
  test("path-scoped limit-100k scan fires onScanCapped and stops at the cap", () => {
    const scope = buildDocumentFilter({ path: ["docs/bulk/**"] });
    let capped = 0;
    const hits = searchFTS(store.internal.db, "allcaprepro", 100_000, ["docs"], undefined, scope, () => { capped++; });
    expect(hits).toHaveLength(FILTERED_FTS_SCAN_MAX);
    expect(capped).toBe(1);
  });

  test("same corpus unscoped returns everything with no cap signal (control)", () => {
    let capped = 0;
    const hits = searchFTS(store.internal.db, "allcaprepro", 100_000, ["docs"], undefined, undefined, () => { capped++; });
    expect(hits).toHaveLength(DOC_COUNT);
    expect(capped).toBe(0);
  });

  test("small-limit filtered scan does not probe (no false positive, hot path untouched)", () => {
    const scope = buildDocumentFilter({ path: ["docs/bulk/**"] });
    let capped = 0;
    const hits = searchFTS(store.internal.db, "allcaprepro", 20, ["docs"], undefined, scope, () => { capped++; });
    expect(hits).toHaveLength(20);
    expect(capped).toBe(0);
  });

  test("callers without the callback are unaffected (backward compatible)", () => {
    const scope = buildDocumentFilter({ path: ["docs/bulk/**"] });
    const hits = searchFTS(store.internal.db, "allcaprepro", 20, ["docs"], undefined, scope);
    expect(hits).toHaveLength(20);
  });
});
