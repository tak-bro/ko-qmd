/**
 * ko-fts-triggers.test.ts — ko-qmd's FTS trigger revision survives upstream's
 * PRAGMA user_version numbering.
 *
 * ko-qmd scopes documents_au to the FTS-visible columns. Upstream owns
 * user_version (1 = FTS triggers, 2 = vector partitions), so a database that
 * upstream's numbering calls current can still carry the unscoped trigger body
 * of an older build. The ko revision lives in store_config and reinstalls the
 * body once per database.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, loadSqliteVec } from "../src/db.js";
import { createStore } from "../src/store.js";
import { LEGACY_VEC_TABLE, VEC_TABLE, createPartitionedVecTable, vecLayout } from "../src/vec-layout.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "qmd-ko-fts-triggers-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const UNSCOPED_AU = `
  CREATE TRIGGER documents_au AFTER UPDATE ON documents
  BEGIN
    DELETE FROM documents_fts WHERE rowid = old.id AND new.active = 0;
    INSERT OR REPLACE INTO documents_fts(rowid, filepath, title, body)
    SELECT new.id, new.collection || '/' || new.path, new.title,
      (SELECT doc FROM content WHERE hash = new.hash)
    WHERE new.active = 1;
  END
`;

function triggerSql(dbPath: string): string {
  const db = openDatabase(dbPath);
  try {
    return (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'documents_au'`).get() as { sql: string }).sql;
  } finally {
    db.close();
  }
}

/** Put an existing store back into the state an older build left: unscoped body, no ko revision, the given user_version. */
function regress(dbPath: string, userVersion: number): void {
  const db = openDatabase(dbPath);
  try {
    db.exec(`DROP TRIGGER IF EXISTS documents_au`);
    db.exec(UNSCOPED_AU);
    db.prepare(`DELETE FROM store_config WHERE key = 'ko_fts_sync_triggers'`).run();
    db.exec(`PRAGMA user_version = ${userVersion}`);
  } finally {
    db.close();
  }
}

describe("ko-qmd FTS trigger revision", () => {
  test("a fresh store gets the scoped documents_au body and records the revision", () => {
    const dbPath = join(dir, "fresh.sqlite");
    createStore(dbPath).close();
    expect(triggerSql(dbPath)).toContain("AFTER UPDATE OF collection, path, hash, active ON documents");
    const db = openDatabase(dbPath);
    try {
      expect(db.prepare(`SELECT value FROM store_config WHERE key = 'ko_fts_sync_triggers'`).get()).toEqual({ value: "2" });
    } finally {
      db.close();
    }
  });

  test.each([1, 2])("a store at user_version %i with the unscoped body is reinstalled on open", (userVersion) => {
    const dbPath = join(dir, `regressed-${userVersion}.sqlite`);
    createStore(dbPath).close();
    regress(dbPath, userVersion);
    expect(triggerSql(dbPath)).not.toContain("AFTER UPDATE OF");

    createStore(dbPath).close();
    expect(triggerSql(dbPath)).toContain("AFTER UPDATE OF collection, path, hash, active ON documents");
  });
});

/**
 * An index an earlier ko-qmd build opened: user_version 2 (ko's trigger
 * revision), the legacy vector table, and no ko revision key yet.
 */
function koEraIndex(dbPath: string, legacyDimensions: number): void {
  createStore(dbPath).close();
  const db = openDatabase(dbPath);
  try {
    loadSqliteVec(db);
    db.exec(`DROP TABLE IF EXISTS ${VEC_TABLE}`);
    db.exec(`CREATE VIRTUAL TABLE ${LEGACY_VEC_TABLE} USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[${legacyDimensions}] distance_metric=cosine)`);
    db.prepare(`DELETE FROM store_config WHERE key = 'ko_fts_sync_triggers'`).run();
    db.exec(`PRAGMA user_version = 2`);
  } finally {
    db.close();
  }
}

function inspect(dbPath: string): { kind: string; userVersion: number } {
  const db = openDatabase(dbPath);
  try {
    loadSqliteVec(db);
    const row = db.prepare(`PRAGMA user_version`).get() as Record<string, number>;
    return { kind: vecLayout(db).kind, userVersion: Object.values(row)[0]! };
  } finally {
    db.close();
  }
}

describe("ko-qmd user_version 2 stamp from an earlier build", () => {
  test("converts the legacy vector table on first open and ends stamped as upstream's version 2", () => {
    const dbPath = join(dir, "ko-era.sqlite");
    koEraIndex(dbPath, 3);
    createStore(dbPath).close();
    expect(inspect(dbPath)).toEqual({ kind: "partitioned", userVersion: 2 });
  });

  test("a conversion failure stops the open instead of leaving vector search quietly off", () => {
    const dbPath = join(dir, "ko-era-mismatch.sqlite");
    koEraIndex(dbPath, 3);
    // A partitioned table of other dimensions makes the conversion fail.
    const db = openDatabase(dbPath);
    try {
      loadSqliteVec(db);
      createPartitionedVecTable(db, 4);
    } finally {
      db.close();
    }
    expect(() => createStore(dbPath)).toThrow(/dimensions/);
    expect(inspect(dbPath).kind).toBe("legacy");
  });
});
