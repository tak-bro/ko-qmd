/**
 * search-filter.test.ts — `--path` / `--since` / `--until` against a real index.
 *
 * The property under test is not "the filter works" but "the filter narrows the corpus
 * rather than the answer". MIN_RETRIEVAL_BREADTH guarantees 20 candidates before filtering;
 * applying a filter after that is the starvation #791/#803 already cost us, and it looks
 * exactly like a correct empty result.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type LexSearchOptions, type QMDStore } from "../src/index.js";
import { countFilteredDocuments, searchFTS, searchVec, DEFAULT_EMBED_MODEL, getEmbeddingFingerprint } from "../src/store.js";
import { buildDocumentFilter } from "../src/filters.js";

let root: string;
let store: QMDStore;

const collectionFor = () => collectionNames;
const collectionNames = ["docs"];
const DECOY_COUNT = 250;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "qmd-filter-"));
  const docs = join(root, "docs");
  mkdirSync(join(docs, "journals", "2024"), { recursive: true });
  mkdirSync(join(docs, "journals", "2026"), { recursive: true });
  mkdirSync(join(docs, "archive"), { recursive: true });

  // Enough decoys to overflow the retrieval pool: a collection-scoped FTS query over-fetches
  // MIN_RETRIEVAL_BREADTH * 10 = 200 candidates, and every one of these outranks the two
  // journal notes. A filter applied to that pool instead of to the corpus finds nothing left.
  for (let i = 0; i < DECOY_COUNT; i++) {
    // decoy-0 carries the same metadata as the 2026 note, so a metadata filter alone keeps a
    // decoy and only the path scope removes it.
    const frontmatter = i === 0 ? "---\nqmd:\n  metadata:\n    status: keep\n---\n" : "";
    writeFileSync(join(docs, "archive", `decoy-${i}.md`), `${frontmatter}# Decoy ${i}\n\nzanzibar zanzibar zanzibar\n`);
  }
  writeFileSync(join(docs, "journals", "2026", "note.md"), "---\nqmd:\n  metadata:\n    status: keep\n---\n# Note\n\nzanzibar once\n");
  writeFileSync(join(docs, "journals", "2024", "old.md"), "---\nqmd:\n  metadata:\n    status: drop\n---\n# Old\n\nzanzibar once\n");

  store = await createStore({
    dbPath: join(root, "index.sqlite"),
    config: { collections: { docs: { path: docs, pattern: "**/*.md" } } },
  });
  await store.update();
});

afterAll(async () => {
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("path filters narrow the corpus, not the answer", () => {
  test("without a filter the decoys own the results", () => {
    const hits = searchFTS(store.internal.db, "zanzibar", 10, collectionFor());
    expect(hits).toHaveLength(10);
    expect(hits.every(h => h.displayPath.startsWith("docs/archive/"))).toBe(true);
  });

  test("a narrow path filter still returns its matches, buried as they are", () => {
    // The two journal notes never enter an unfiltered top-20. A post-filter returns nothing.
    const filter = buildDocumentFilter({ path: ["docs/journals/**"] })!;
    const hits = searchFTS(store.internal.db, "zanzibar", 10, collectionFor(), undefined, filter);
    expect(hits.map(h => h.displayPath).sort()).toEqual([
      "docs/journals/2024/old.md",
      "docs/journals/2026/note.md",
    ]);
  });

  test("an exclude beats an include", () => {
    const filter = buildDocumentFilter({ path: ["docs/journals/**", "!docs/journals/2024/**"] })!;
    const hits = searchFTS(store.internal.db, "zanzibar", 10, collectionFor(), undefined, filter);
    expect(hits.map(h => h.displayPath)).toEqual(["docs/journals/2026/note.md"]);
  });

  test("a bare directory prefix means everything under it", () => {
    const filter = buildDocumentFilter({ path: ["docs/journals"] })!;
    const hits = searchFTS(store.internal.db, "zanzibar", 10, collectionFor(), undefined, filter);
    expect(hits).toHaveLength(2);
  });

  test("a filter that matches no document returns nothing rather than everything", () => {
    const filter = buildDocumentFilter({ path: ["docs/nowhere/**"] })!;
    expect(searchFTS(store.internal.db, "zanzibar", 10, collectionFor(), undefined, filter)).toEqual([]);
  });

  test("the filter never widens a result — words still have to match", () => {
    const filter = buildDocumentFilter({ path: ["docs/**"] })!;
    expect(searchFTS(store.internal.db, "kilimanjaro", 10, collectionFor(), undefined, filter)).toEqual([]);
  });
});

describe("time filters", () => {
  test("`since` in the future removes everything", () => {
    const filter = buildDocumentFilter({ since: "2099-01-01" })!;
    expect(searchFTS(store.internal.db, "zanzibar", 10, collectionFor(), undefined, filter)).toEqual([]);
  });

  test("`since` in the past keeps everything", () => {
    const filter = buildDocumentFilter({ since: "2000-01-01" })!;
    expect(searchFTS(store.internal.db, "zanzibar", 10, collectionFor(), undefined, filter)).toHaveLength(10);
  });

  test("`until` in the past removes everything", () => {
    const filter = buildDocumentFilter({ until: "2000-01-01" })!;
    expect(searchFTS(store.internal.db, "zanzibar", 10, collectionFor(), undefined, filter)).toEqual([]);
  });

  test("path and time compose", () => {
    const filter = buildDocumentFilter({ path: ["docs/journals/**"], since: "2000-01-01" })!;
    expect(searchFTS(store.internal.db, "zanzibar", 10, collectionFor(), undefined, filter)).toHaveLength(2);
  });
});

describe("countFilteredDocuments", () => {
  test("tells an empty result apart from an empty corpus", () => {
    const filter = buildDocumentFilter({ path: ["docs/journals/**"] })!;
    expect(countFilteredDocuments(store.internal.db, filter, collectionFor())).toEqual({ kept: 2, total: DECOY_COUNT + 2 });
  });

  test("reports zero kept when the filter removed the corpus", () => {
    const filter = buildDocumentFilter({ path: ["docs/nowhere/**"] })!;
    const counted = countFilteredDocuments(store.internal.db, filter, collectionFor());
    expect(counted.kept).toBe(0);
    expect(counted.total).toBe(DECOY_COUNT + 2);
  });
});

describe("searchLex through the SDK", () => {
  test("passes the filter down", async () => {
    const filter = buildDocumentFilter({ path: ["docs/journals/2026/**"] })!;
    const hits = await store.searchLex("zanzibar", { collection: collectionNames, limit: 10, scope: filter });
    expect(hits.map(h => h.displayPath)).toEqual(["docs/journals/2026/note.md"]);
  });

  test("a metadata filter and a path scope together keep only their intersection", async () => {
    const scope = buildDocumentFilter({ path: ["docs/journals/**"] })!;
    const filter = { key: "status", operator: "eq", value: "keep" } as const;
    const paths = async (opts: Pick<LexSearchOptions, "filter" | "scope">) =>
      (await store.searchLex("zanzibar", { collection: collectionNames, limit: 10, ...opts })).map(h => h.displayPath).sort();
    expect(await paths({ scope })).toEqual(["docs/journals/2024/old.md", "docs/journals/2026/note.md"]);
    expect(await paths({ filter })).toEqual(["docs/archive/decoy-0.md", "docs/journals/2026/note.md"]);
    expect(await paths({ scope, filter })).toEqual(["docs/journals/2026/note.md"]);
  });

  test("reports modified_at, which `--since` is compared against", async () => {
    const hits = await store.searchLex("zanzibar", { collection: collectionNames, limit: 1 });
    expect(hits[0]!.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// =============================================================================
// Vector path
// =============================================================================

/**
 * The vector path has its own way to starve a filter: `annVecScan` (or an exact scan capped
 * at the retrieval breadth) picks its neighbours from the whole table, and anything the
 * filter wanted that did not place is gone before the filter is ever consulted. These use
 * synthetic embeddings — the property is about which rows are considered, not about what an
 * embedding model thinks — with the decoys planted right next to the query.
 */
const DIM = 1024;
const nearQuery = () => { const v = new Float32Array(DIM); v[0] = 1; return v; };
const farFromQuery = () => { const v = new Float32Array(DIM); v[1] = 1; return v; };

describe("vector search takes the same filter", () => {
  beforeAll(() => {
    const db = store.internal.db;
    store.internal.ensureVecTable(DIM);
    const now = new Date().toISOString();
    const rows = db.prepare(
      `SELECT DISTINCT hash, collection || '/' || path AS display_path FROM documents WHERE active = 1`,
    ).all() as { hash: string; display_path: string }[];
    for (const row of rows) {
      const embedding = row.display_path.startsWith("docs/journals/") ? farFromQuery() : nearQuery();
      db.prepare(
        `INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embed_fingerprint, embedded_at) VALUES (?, 0, 0, ?, ?, ?)`,
      ).run(row.hash, DEFAULT_EMBED_MODEL, getEmbeddingFingerprint(DEFAULT_EMBED_MODEL), now);
      db.prepare(`INSERT OR REPLACE INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`)
        .run(`${row.hash}_0`, embedding);
    }
  });

  const query = Array.from(nearQuery());

  test("without a filter the nearest neighbours are all decoys", async () => {
    const hits = await searchVec(store.internal.db, "ignored", DEFAULT_EMBED_MODEL, 10, collectionFor(), undefined, query);
    expect(hits).toHaveLength(10);
    expect(hits.every(h => h.displayPath.startsWith("docs/archive/"))).toBe(true);
  });

  test("a narrow path filter returns the far-away documents it asked for", async () => {
    const filter = buildDocumentFilter({ path: ["docs/journals/**"] })!;
    const hits = await searchVec(store.internal.db, "ignored", DEFAULT_EMBED_MODEL, 10, collectionFor(), undefined, query, undefined, undefined, filter);
    expect(hits.map(h => h.displayPath).sort()).toEqual([
      "docs/journals/2024/old.md",
      "docs/journals/2026/note.md",
    ]);
  });

  test("an exclude beats an include here too", async () => {
    const filter = buildDocumentFilter({ path: ["docs/journals/**", "!docs/journals/2024/**"] })!;
    const hits = await searchVec(store.internal.db, "ignored", DEFAULT_EMBED_MODEL, 10, collectionFor(), undefined, query, undefined, undefined, filter);
    expect(hits.map(h => h.displayPath)).toEqual(["docs/journals/2026/note.md"]);
  });

  test("a time filter that excludes everything returns nothing", async () => {
    const filter = buildDocumentFilter({ since: "2099-01-01" })!;
    const hits = await searchVec(store.internal.db, "ignored", DEFAULT_EMBED_MODEL, 10, collectionFor(), undefined, query, undefined, undefined, filter);
    expect(hits).toEqual([]);
  });

  const keep = { key: "status", operator: "eq", value: "keep" } as const;
  // No collection: a collection alone already forces the exact scan, which would hide a
  // metadata filter that failed to.
  const vecPaths = async (scope?: ReturnType<typeof buildDocumentFilter>) =>
    (await searchVec(store.internal.db, "ignored", DEFAULT_EMBED_MODEL, 10, undefined, undefined, query, undefined, keep, scope))
      .map(h => h.displayPath).sort();

  test("a metadata filter alone is exact-scanned too — the far-away note is not starved", async () => {
    expect(await vecPaths()).toEqual(["docs/archive/decoy-0.md", "docs/journals/2026/note.md"]);
  });

  test("a metadata filter and a path or time scope keep only their intersection", async () => {
    expect(await vecPaths(buildDocumentFilter({ path: ["docs/journals/**"] }))).toEqual(["docs/journals/2026/note.md"]);
    expect(await vecPaths(buildDocumentFilter({ since: "2099-01-01" }))).toEqual([]);
  });

  test("a filter matching nothing returns nothing, not the unfiltered neighbours", async () => {
    const filter = buildDocumentFilter({ path: ["docs/nowhere/**"] })!;
    const hits = await searchVec(store.internal.db, "ignored", DEFAULT_EMBED_MODEL, 10, collectionFor(), undefined, query, undefined, undefined, filter);
    expect(hits).toEqual([]);
  });
});
