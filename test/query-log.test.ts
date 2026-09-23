/**
 * Daemon query log (src/query-log.ts): opt-in JSONL rows for HTTP searches.
 *
 * Every test points XDG_CACHE_HOME at a fresh temp dir — the module reads the
 * env at call time, so the real ~/.cache/qmd/queries-*.jsonl is never touched.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  logQuery,
  flushQueryLog,
  queryLogPath,
  queryLogStatus,
  latestQueryLogFile,
  entryFromRest,
  _resetQueryLogForTesting,
  type QueryLogEntry,
} from "../src/query-log.js";

const fakeStore = {
  getStatus: async () => ({
    totalDocuments: 3,
    needsEmbedding: 0,
    hasVectorIndex: false,
    collections: [
      { name: "docs", path: "/d", pattern: "**/*.md", documents: 2, lastUpdated: "2026-09-01T00:00:00.000Z" },
      { name: "notes", path: "/n", pattern: "**/*.md", documents: 1, lastUpdated: "2026-09-10T00:00:00.000Z" },
    ],
  }),
};

const baseEntry = (overrides: Partial<QueryLogEntry> = {}): QueryLogEntry => ({
  via: "rest",
  tool: "/query",
  headers: {},
  searches: [{ type: "lex", query: "synthetic query" }],
  collections: ["docs"],
  limit: 10,
  rerank: false,
  results: [
    { file: "qmd://docs/a%20b.md", score: 0.91 },
    { file: "qmd://docs/sub/c.md", score: 0.5 },
  ],
  ms: 42,
  ...overrides,
});

let cacheHome: string;
const origCache = process.env.XDG_CACHE_HOME;
const origFlag = process.env.QMD_QUERY_LOG;

const logDir = () => join(cacheHome, "qmd");
const logFiles = () => {
  try {
    return readdirSync(logDir()).filter((f) => f.startsWith("queries-"));
  } catch {
    return [];
  }
};
const readRows = (file = queryLogPath()) =>
  readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

beforeEach(() => {
  cacheHome = mkdtempSync(join(tmpdir(), "qmd-query-log-"));
  process.env.XDG_CACHE_HOME = cacheHome;
  delete process.env.QMD_QUERY_LOG;
  _resetQueryLogForTesting();
});

afterEach(() => {
  if (origCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = origCache;
  if (origFlag === undefined) delete process.env.QMD_QUERY_LOG;
  else process.env.QMD_QUERY_LOG = origFlag;
  rmSync(cacheHome, { recursive: true, force: true });
});

describe("enable flag", () => {
  test("unset writes nothing", async () => {
    logQuery(baseEntry(), fakeStore);
    await flushQueryLog();
    expect(logFiles()).toEqual([]);
  });

  test.each(["0", "false", "no", "off", ""])("QMD_QUERY_LOG=%j writes nothing", async (value) => {
    process.env.QMD_QUERY_LOG = value;
    logQuery(baseEntry(), fakeStore);
    await flushQueryLog();
    expect(logFiles()).toEqual([]);
  });

  test.each(["1", "true", "yes", "TRUE"])("QMD_QUERY_LOG=%j writes a row", async (value) => {
    process.env.QMD_QUERY_LOG = value;
    logQuery(baseEntry(), fakeStore);
    await flushQueryLog();
    expect(readRows()).toHaveLength(1);
  });
});

describe("row", () => {
  beforeEach(() => {
    process.env.QMD_QUERY_LOG = "1";
  });

  test("carries schema, fingerprint, normalized files and ranks — no snippets", async () => {
    logQuery(baseEntry({ headers: { "x-qmd-tag": "explore", "x-qmd-qid": "q-1", "x-qmd-role": "primary" } }), fakeStore);
    await flushQueryLog();
    const [row] = readRows();
    expect(row.v).toBe(1);
    expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    expect(row.qmd).toMatch(/^\d+\.\d+\.\d+/);
    expect(row.index).toEqual({ docs: 3, updated: "2026-09-10T00:00:00.000Z" });
    expect(row.via).toBe("rest");
    expect(row.tool).toBe("/query");
    expect(row.searches).toEqual([{ type: "lex", query: "synthetic query" }]);
    expect(row.collections).toEqual(["docs"]);
    expect(row.limit).toBe(10);
    expect(row.rerank).toBe(false);
    expect(row.results).toEqual([
      { file: "docs/a b.md", score: 0.91, rank: 1 },
      { file: "docs/sub/c.md", score: 0.5, rank: 2 },
    ]);
    expect(row.ms).toBe(42);
    expect(row.client).toEqual({ tag: "explore", qid: "q-1", role: "primary" });
    expect(JSON.stringify(row)).not.toMatch(/snippet|body/);
  });

  test("raw backend scores ride along when present and stay absent otherwise", async () => {
    logQuery(baseEntry({
      results: [
        { file: "qmd://docs/a%20b.md", score: 1, vec_score: 0.62, fts_score: 0.81 },
        { file: "qmd://docs/sub/c.md", score: 0.5, fts_score: 0.4 },
        { file: "qmd://docs/d.md", score: 0.33 },
      ],
    }), fakeStore);
    await flushQueryLog();
    const [row] = readRows();
    expect(row.v).toBe(1);
    expect(row.results).toEqual([
      { file: "docs/a b.md", score: 1, vec_score: 0.62, fts_score: 0.81, rank: 1 },
      { file: "docs/sub/c.md", score: 0.5, fts_score: 0.4, rank: 2 },
      { file: "docs/d.md", score: 0.33, rank: 3 },
    ]);
    expect(row.results[2]).not.toHaveProperty("vec_score");
    expect(row.results[2]).not.toHaveProperty("fts_score");
  });

  test("file is created 0600", async () => {
    logQuery(baseEntry(), fakeStore);
    await flushQueryLog();
    expect(statSync(queryLogPath()).mode & 0o777).toBe(0o600);
  });

  test("X-QMD-No-Log skips the row", async () => {
    logQuery(baseEntry({ headers: { "x-qmd-no-log": "1" } }), fakeStore);
    logQuery(baseEntry({ headers: new Headers({ "X-QMD-No-Log": "true" }) }), fakeStore);
    await flushQueryLog();
    expect(logFiles()).toEqual([]);
  });

  test("reads web Headers and node header arrays alike", async () => {
    logQuery(baseEntry({ headers: new Headers({ "X-QMD-Tag": "kb", "X-QMD-Role": "probe" }) }), fakeStore);
    logQuery(baseEntry({ headers: { "x-qmd-tag": ["plan", "ignored"] } }), fakeStore);
    await flushQueryLog();
    const rows = readRows();
    expect(rows[0].client).toEqual({ tag: "kb", qid: null, role: "probe" });
    expect(rows[1].client).toEqual({ tag: "plan", qid: null, role: null });
  });

  test("untrusted headers: unknown role is null, long values are cut, row stays one line", async () => {
    logQuery(
      baseEntry({
        headers: {
          "x-qmd-role": "admin",
          "x-qmd-tag": "t".repeat(40),
          "x-qmd-qid": `abc\n{"v":1}` + "x".repeat(80),
        },
      }),
      fakeStore,
    );
    await flushQueryLog();
    const lines = readFileSync(queryLogPath(), "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!);
    expect(row.client.role).toBeNull();
    expect(row.client.tag).toBe("t".repeat(32));
    expect(row.client.qid).toHaveLength(64);
  });

  test("rows are appended in call order", async () => {
    for (const q of ["first", "second", "third"]) {
      logQuery(baseEntry({ searches: [{ type: "vec", query: q }] }), fakeStore);
    }
    await flushQueryLog();
    expect(readRows().map((r) => r.searches[0].query)).toEqual(["first", "second", "third"]);
  });

  test("a new local month writes a new file", async () => {
    const aug = new Date(2026, 7, 31, 23, 59, 59);
    const sep = new Date(2026, 8, 1, 0, 0, 1);
    logQuery(baseEntry({ now: aug }), fakeStore);
    logQuery(baseEntry({ now: sep }), fakeStore);
    await flushQueryLog();
    expect(logFiles().sort()).toEqual(["queries-2026-08.jsonl", "queries-2026-09.jsonl"]);
    expect(readRows(queryLogPath(aug))).toHaveLength(1);
    expect(readRows(queryLogPath(sep))).toHaveLength(1);
  });

  test("a failing index status still logs the query with a null fingerprint", async () => {
    const broken = { getStatus: async () => { throw new Error("db closed"); } };
    logQuery(baseEntry(), broken);
    await flushQueryLog();
    expect(readRows()[0].index).toEqual({ docs: null, updated: null });
  });
});

describe("fail-open", () => {
  test("an unwritable cache dir never throws and is reported by status", async () => {
    process.env.QMD_QUERY_LOG = "1";
    // A regular file where the qmd/ directory should be: mkdir fails with ENOTDIR/EEXIST.
    writeFileSync(join(cacheHome, "qmd"), "not a directory");
    expect(() => logQuery(baseEntry(), fakeStore)).not.toThrow();
    await expect(flushQueryLog()).resolves.toBeUndefined();
    const status = queryLogStatus();
    expect(status.enabled).toBe(true);
    expect(status.lastWrite).toBeNull();
    expect(status.lastError).toMatch(/E(NOTDIR|EXIST)/);
  });

  test("a throw while building the row is swallowed and recorded", async () => {
    process.env.QMD_QUERY_LOG = "1";
    const exploding = new Proxy({}, { get: () => { throw new Error("header boom"); } });
    expect(() => logQuery(baseEntry({ headers: exploding }), fakeStore)).not.toThrow();
    await flushQueryLog();
    expect(logFiles()).toEqual([]);
    expect(queryLogStatus().lastError).toBe("header boom");
  });

  test("status reports the last successful write", async () => {
    process.env.QMD_QUERY_LOG = "1";
    expect(queryLogStatus()).toMatchObject({ enabled: true, lastWrite: null, lastError: null });
    logQuery(baseEntry(), fakeStore);
    await flushQueryLog();
    const status = queryLogStatus();
    expect(status.path).toBe(queryLogPath());
    expect(status.lastWrite).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("latestQueryLogFile (CLI status, other process)", () => {
  test("none when the cache dir or the log is missing", () => {
    expect(latestQueryLogFile()).toEqual({ kind: "none" });
  });

  test("an unreadable cache dir is an error, not none", () => {
    writeFileSync(join(cacheHome, "qmd"), "not a directory");
    const state = latestQueryLogFile();
    expect(state.kind).toBe("error");
    expect(state.kind === "error" && state.message).toContain("ENOTDIR");
  });

  test("picks the newest month file", async () => {
    process.env.QMD_QUERY_LOG = "1";
    logQuery(baseEntry({ now: new Date(2026, 6, 1) }), fakeStore);
    logQuery(baseEntry({ now: new Date(2026, 8, 1) }), fakeStore);
    await flushQueryLog();
    const latest = latestQueryLogFile();
    expect(latest.kind).toBe("file");
    if (latest.kind !== "file") return;
    expect(latest.path).toBe(queryLogPath(new Date(2026, 8, 1)));
    expect(latest.modified).toBeInstanceOf(Date);
  });
});

describe("entryFromRest", () => {
  test("maps the REST request with the handler's defaults", () => {
    const entry = entryFromRest({
      path: "/search",
      headers: {},
      searches: [{ type: "vec", query: "q" }],
      params: { limit: "5", rerank: "no" },
      collections: [],
      results: [],
      ms: 1,
    });
    expect(entry).toMatchObject({
      via: "rest",
      tool: "/search",
      searches: [{ type: "vec", query: "q" }],
      collections: null,
      limit: 10,
      rerank: null,
    });
  });
});
