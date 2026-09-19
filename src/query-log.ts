/**
 * Daemon query log — an opt-in JSONL record of searches served by the HTTP
 * daemon: the REST `/query`·`/search` endpoints and the MCP `query` tool, so a
 * user dogfooding a build can mine their real queries for misses. Only HTTP
 * traffic is logged; a stdio MCP connection has no request to annotate.
 *
 * - Off unless `QMD_QUERY_LOG` is `1`, `true` or `yes` (case-insensitive).
 *   CLI searches never call this module.
 * - One file per local month: `$XDG_CACHE_HOME/qmd/queries-YYYY-MM.jsonl`
 *   (default `~/.cache/qmd`), created 0600. Nothing is ever deleted.
 * - Rows hold queries, result paths and scores — never snippets or bodies.
 * - Fail-open: callers do not await and nothing here throws; a failure never
 *   reaches the search response. The first failure per process prints one
 *   stderr line; `queryLogStatus()` keeps the latest failure until the next
 *   successful write.
 * - Clients annotate rows with `X-QMD-Tag` / `X-QMD-Qid` / `X-QMD-Role`, and
 *   skip logging with `X-QMD-No-Log: 1`. Header values are untrusted.
 *
 * Env and paths are read at call time so tests can redirect XDG_CACHE_HOME.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { qmdHomedir } from "./paths.js";
import { resolveCommit } from "./cli/version.js";
import type { IndexStatus } from "./store.js";

export const QUERY_LOG_SCHEMA_VERSION = 1;

const ROLES = ["primary", "probe", "canary", "replay"] as const;
type QueryRole = (typeof ROLES)[number];

const TAG_MAX = 32;
const QID_MAX = 64;
const FINGERPRINT_TTL_MS = 60_000;

type HeaderSource = Headers | IncomingHttpHeaders;

type StatusSource = { getStatus(): Promise<IndexStatus> };

export type QueryLogEntry = {
  via: "rest" | "mcp";
  tool: string;
  headers: HeaderSource;
  searches: { type: string; query: string }[];
  collections: string[] | null;
  limit: number;
  /** null = the request left reranking to the daemon default */
  rerank: boolean | null;
  results: { file: string; score: number }[];
  ms: number;
  /** Injectable clock for tests; defaults to the time of the call. */
  now?: Date;
};

export type QueryLogStatus = {
  enabled: boolean;
  path: string;
  lastWrite: string | null;
  lastError: string | null;
};

const isTruthyFlag = (value: string | undefined): boolean =>
  value !== undefined && ["1", "true", "yes"].includes(value.trim().toLowerCase());

const isQueryLogEnabled = (): boolean => isTruthyFlag(process.env.QMD_QUERY_LOG);

const queryLogDir = (): string =>
  join(process.env.XDG_CACHE_HOME || join(qmdHomedir(), ".cache"), "qmd");

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Path of the log file for the local month containing `date`. */
export const queryLogPath = (date: Date = new Date()): string =>
  join(queryLogDir(), `queries-${date.getFullYear()}-${pad2(date.getMonth() + 1)}.jsonl`);

/** ISO-8601 in local time with the UTC offset, e.g. 2026-09-17T16:05:03.123+09:00. */
const isoWithOffset = (date: Date): string => {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    + `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.${ms}`
    + `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
};

const readHeader = (headers: HeaderSource, name: string): string | null => {
  if (headers instanceof Headers) return headers.get(name);
  const raw = headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ?? null;
};

const clip = (value: string | null, max: number): string | null =>
  value === null || value === "" ? null : value.slice(0, max);

const parseRole = (value: string | null): QueryRole | null =>
  ROLES.find((role) => role === value) ?? null;

/** REST emits `qmd://<collection>/<percent-encoded path>`; MCP emits the plain display path. */
const normalizeResultFile = (file: string): string => {
  const bare = file.startsWith("qmd://") ? file.slice("qmd://".length) : file;
  return bare.split("/").map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }).join("/");
};

let packageVersion: string | undefined;
const qmdVersion = (): string => {
  if (packageVersion !== undefined) return packageVersion;
  // This file sits one level below the package root both as src/ and dist/.
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..");
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as { version?: string };
    // The commit tells a dogfood build apart from the published package of the same version.
    const commit = resolveCommit(join(here, "cli"), root);
    packageVersion = commit ? `${pkg.version ?? "unknown"} (${commit})` : (pkg.version ?? "unknown");
  } catch {
    packageVersion = "unknown";
  }
  return packageVersion;
};

type Fingerprint = { docs: number | null; updated: string | null };
let fingerprintCache: { store: StatusSource; at: number; value: Fingerprint } | null = null;

const indexFingerprint = async (store: StatusSource): Promise<Fingerprint> => {
  const now = Date.now();
  if (fingerprintCache && fingerprintCache.store === store && now - fingerprintCache.at < FINGERPRINT_TTL_MS) {
    return fingerprintCache.value;
  }
  let value: Fingerprint;
  try {
    const status = await store.getStatus();
    const updated = status.collections
      .map((c) => c.lastUpdated)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;
    value = { docs: status.totalDocuments, updated };
  } catch {
    // A missing fingerprint must not cost the query row.
    value = { docs: null, updated: null };
  }
  fingerprintCache = { store, at: now, value };
  return value;
};

let writeChain: Promise<void> = Promise.resolve();
let lastWrite: string | null = null;
let lastError: string | null = null;
let reportedFailure = false;

const recordFailure = (path: string, message: string): void => {
  lastError = message;
  if (reportedFailure) return;
  reportedFailure = true;
  console.error(`qmd: query log write failed (${path}): ${message} — searches are unaffected`);
};

/**
 * Queue one row. Returns immediately; the write happens after the response.
 * No-op unless the flag is on and the request did not ask to be skipped.
 * Never throws — the REST handler calls this after the response has ended.
 */
export const logQuery = (entry: QueryLogEntry, store: StatusSource): void => {
  try {
    queueRow(entry, store);
  } catch (err) {
    recordFailure(queryLogPath(), err instanceof Error ? err.message : String(err));
  }
};

const queueRow = (entry: QueryLogEntry, store: StatusSource): void => {
  if (!isQueryLogEnabled()) return;
  if (isTruthyFlag(readHeader(entry.headers, "x-qmd-no-log") ?? undefined)) return;

  const now = entry.now ?? new Date();
  const path = queryLogPath(now);
  const partial = {
    v: QUERY_LOG_SCHEMA_VERSION,
    ts: isoWithOffset(now),
    qmd: qmdVersion(),
    via: entry.via,
    tool: entry.tool,
    searches: entry.searches.map(({ type, query }) => ({ type, query })),
    collections: entry.collections,
    limit: entry.limit,
    rerank: entry.rerank,
    results: entry.results.map((r, i) => ({ file: normalizeResultFile(r.file), score: r.score, rank: i + 1 })),
    ms: entry.ms,
    client: {
      tag: clip(readHeader(entry.headers, "x-qmd-tag"), TAG_MAX),
      qid: clip(readHeader(entry.headers, "x-qmd-qid"), QID_MAX),
      role: parseRole(readHeader(entry.headers, "x-qmd-role")),
    },
  };

  writeChain = writeChain.then(async () => {
    try {
      const line = JSON.stringify({ ...partial, index: await indexFingerprint(store) }) + "\n";
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, line, { mode: 0o600 });
      lastWrite = new Date().toISOString();
      lastError = null;
    } catch (err) {
      recordFailure(path, err instanceof Error ? err.message : String(err));
    }
  });
};

/** Resolves once every queued row has been written or has failed. */
export const flushQueryLog = (): Promise<void> => writeChain;

/** In-process view (the daemon's own `status` tool). */
export const queryLogStatus = (): QueryLogStatus => ({
  enabled: isQueryLogEnabled(),
  path: queryLogPath(),
  lastWrite,
  lastError,
});

export type QueryLogFileState =
  | { kind: "none" }
  | { kind: "file"; path: string; modified: Date }
  | { kind: "error"; message: string };

const errorCode = (err: NodeJS.ErrnoException): string => err.code ?? err.message;

/**
 * Newest log file on disk, for `qmd status` — which runs in a different
 * process than the daemon and so cannot see the daemon's env or state.
 * A missing cache dir is "none"; any other failure yields kind "error" with
 * the error code only (status output carries no filesystem paths).
 */
export const latestQueryLogFile = (): QueryLogFileState => {
  const dir = queryLogDir();
  try {
    const newest = readdirSync(dir)
      .filter((n) => /^queries-\d{4}-\d{2}\.jsonl$/.test(n))
      .sort()
      .at(-1);
    if (!newest) return { kind: "none" };
    const path = join(dir, newest);
    return { kind: "file", path, modified: statSync(path).mtime };
  } catch (err) {
    const code = errorCode(err as NodeJS.ErrnoException); // fs errors are ErrnoException
    return code === "ENOENT" ? { kind: "none" } : { kind: "error", message: code };
  }
};

/** Map a REST `/query` request the same way the handler does. */
export const entryFromRest = (input: {
  path: string;
  headers: IncomingHttpHeaders;
  /** The handler's already-mapped searches. */
  searches: { type: string; query: string }[];
  /** Raw JSON body fields the handler reads with typeof checks. */
  params: { limit?: unknown; rerank?: unknown };
  /** The collections actually searched (the handler's defaults applied). */
  collections: string[];
  results: { file: string; score: number }[];
  ms: number;
}): QueryLogEntry => ({
    via: "rest",
    tool: input.path,
    headers: input.headers,
    searches: input.searches,
    collections: input.collections.length > 0 ? input.collections : null,
    // Same default as the REST handler in src/mcp/server.ts.
    limit: typeof input.params.limit === "number" ? input.params.limit : 10,
    rerank: typeof input.params.rerank === "boolean" ? input.params.rerank : null,
    results: input.results,
    ms: input.ms,
  });

/** Map an MCP `query` tool call. Only the HTTP transport supplies headers. */
export const entryFromMcp = (input: {
  headers: Headers;
  /** The tool's typed sub-queries, or the plain `query` it auto-expanded. */
  searches: { type: string; query: string }[];
  /** The collections actually searched (the tool's defaults applied). */
  collections: string[];
  limit: number;
  rerank: boolean;
  results: { file: string; score: number }[];
  ms: number;
}): QueryLogEntry => ({
    via: "mcp",
    tool: "query",
    headers: input.headers,
    searches: input.searches,
    collections: input.collections.length > 0 ? input.collections : null,
    limit: input.limit,
    rerank: input.rerank,
    results: input.results,
    ms: input.ms,
  });

export const _resetQueryLogForTesting = (): void => {
  writeChain = Promise.resolve();
  lastWrite = null;
  lastError = null;
  reportedFailure = false;
  fingerprintCache = null;
};
