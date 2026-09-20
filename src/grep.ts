/**
 * grep.ts — exact and regex matching over indexed document bodies.
 *
 * This is the escape hatch for the failure this fork keeps hitting: a query finds nothing
 * because tokenization never produced the term the document contains. BM25 and vector search
 * both answer "what is this about"; sometimes the question is "where does this string
 * appear", and no amount of ranking answers that.
 *
 * It is not a replacement for ripgrep. At a terminal with a shell, ripgrep is usually the
 * right tool and faster. This earns its place for the caller with no shell — an MCP client
 * whose only tools are `query`, `get` and `multi_get` — and for the caller who wants one
 * corpus definition: it searches exactly what the index holds, honours collection scoping,
 * and returns `qmd://` paths, docids and line numbers that `qmd get file.md:120:40` accepts.
 */

import type { Database } from "./db.js";
import { isNarrowing, matchesPaths, type DocumentFilter } from "./filters.js";

export type GrepLine = {
  /** 1-indexed line number within the document body, as `qmd get path:N:count` takes it. */
  readonly line: number;
  readonly text: string;
};

export type GrepFileMatch = {
  readonly filepath: string;
  readonly displayPath: string;
  readonly title: string;
  readonly hash: string;
  readonly docid: string;
  readonly collectionName: string;
  readonly lines: readonly GrepLine[];
  /** Matches found in this file, which can exceed `lines.length` once the per-file cap bites. */
  readonly matchCount: number;
};

export type GrepOptions = {
  /** Max files to return. The scan stops once this many have matched. */
  readonly limit?: number;
  /** Max lines reported per file. */
  readonly maxLinesPerFile?: number;
  /** Force case sensitivity. Left unset, smart case decides. */
  readonly caseSensitive?: boolean;
  /** Treat the pattern as a literal string rather than a regular expression. */
  readonly fixedString?: boolean;
  readonly filter?: DocumentFilter;
  readonly collections?: readonly string[];
};

export type GrepResult = {
  readonly files: readonly GrepFileMatch[];
  /** Documents read, whether or not they matched — what "no results" was measured against. */
  readonly scanned: number;
  /** True when `limit` stopped the scan, so the corpus was not read to the end. */
  readonly truncated: boolean;
};

/**
 * Cap on pattern length.
 *
 * A user-supplied pattern compiled as a JS `RegExp` is a ReDoS surface, and in the daemon a
 * catastrophic backtrack is not a slow query — it blocks the only thread, so no timer fires
 * and every session on the machine stops getting answers. The containment here is structural
 * rather than a timeout: the scan runs line by line, so the worst case is bounded by the
 * longest line rather than by the whole document, and the exponents that make a backtrack
 * catastrophic need a long input to bite. A 1KB line and a bounded pattern keep that product
 * small. Patterns longer than this are rejected outright.
 */
export const MAX_PATTERN_LENGTH = 1000;

/** Lines longer than this are scanned in slices — see `scanLine`. */
const MAX_SCANNED_LINE_LENGTH = 4000;

const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_LINES_PER_FILE = 20;
const SCAN_BATCH_SIZE = 200;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Compile a user pattern.
 *
 * Smart case: a pattern containing an uppercase letter matches case-sensitively, anything
 * else matches either case. Hangul has no case, so Korean patterns land on the
 * case-insensitive side either way, which is what a Korean user wants.
 */
export const compileGrepPattern = (
  pattern: string,
  options: { caseSensitive?: boolean; fixedString?: boolean } = {},
): RegExp => {
  if (pattern === "") throw new Error(`empty pattern`);
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`pattern is ${pattern.length} characters, over the ${MAX_PATTERN_LENGTH} limit`);
  }
  const source = options.fixedString ? escapeRegExp(pattern) : pattern;
  const hasUppercase = /[A-Z]/.test(pattern);
  const caseSensitive = options.caseSensitive ?? hasUppercase;
  try {
    return new RegExp(source, caseSensitive ? "g" : "gi");
  } catch (error) {
    throw new Error(`not a regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/**
 * Does this line match, and where does the match start?
 *
 * Very long lines are tested in overlapping slices. A minified file or a base64 blob on one
 * line puts the whole document back into a single regex call, which is the case the
 * line-by-line bound exists to avoid. The overlap is the pattern cap, so a match that
 * straddles a slice boundary is still found.
 */
const lineMatches = (line: string, pattern: RegExp): boolean => {
  if (line.length <= MAX_SCANNED_LINE_LENGTH) {
    pattern.lastIndex = 0;
    return pattern.test(line);
  }
  const stride = MAX_SCANNED_LINE_LENGTH - MAX_PATTERN_LENGTH;
  for (let start = 0; start < line.length; start += stride) {
    pattern.lastIndex = 0;
    if (pattern.test(line.slice(start, start + MAX_SCANNED_LINE_LENGTH))) return true;
  }
  return false;
};

type DocRow = {
  id: number;
  collection: string;
  path: string;
  title: string;
  hash: string;
  body: string;
  modified_at: string | null;
};

/**
 * Scan indexed bodies for a pattern.
 *
 * Documents are read in keyset-paginated batches rather than into one array — a vault's
 * worth of bodies does not belong in memory at once, and the scan stops as soon as `limit`
 * files have matched, so a common pattern costs a few batches rather than the corpus.
 */
export const grepDocuments = (
  db: Database,
  pattern: RegExp,
  options: GrepOptions = {},
): GrepResult => {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const maxLinesPerFile = options.maxLinesPerFile ?? DEFAULT_MAX_LINES_PER_FILE;
  const filter = options.filter;
  const filtering = isNarrowing(filter);
  const collections = options.collections;

  const conditions: string[] = ["d.active = 1", "d.id > ?"];
  const scopeParams: string[] = [];
  if (collections && collections.length > 0) {
    conditions.push(`d.collection IN (${collections.map(() => "?").join(",")})`);
    scopeParams.push(...collections.map(String));
  }
  if (filter?.sinceIso) {
    conditions.push(`d.modified_at >= ?`);
    scopeParams.push(filter.sinceIso);
  }
  if (filter?.untilIso) {
    conditions.push(`d.modified_at <= ?`);
    scopeParams.push(filter.untilIso);
  }

  const selectBatch = db.prepare(`
    SELECT d.id, d.collection, d.path, d.title, d.hash, d.modified_at, content.doc as body
    FROM documents d
    JOIN content ON content.hash = d.hash
    WHERE ${conditions.join(" AND ")}
    ORDER BY d.id
    LIMIT ?
  `);

  const files: GrepFileMatch[] = [];
  let scanned = 0;
  let truncated = false;
  let lastId = 0;

  outer: for (;;) {
    const batch = selectBatch.all(lastId, ...scopeParams, SCAN_BATCH_SIZE) as DocRow[];
    if (batch.length === 0) break;
    lastId = batch[batch.length - 1]!.id;

    for (const row of batch) {
      const displayPath = `${row.collection}/${row.path}`;
      if (filtering && !matchesPaths(displayPath, filter)) continue;
      scanned++;

      const lines: GrepLine[] = [];
      let matchCount = 0;
      const bodyLines = (row.body ?? "").split("\n");
      for (let i = 0; i < bodyLines.length; i++) {
        const text = bodyLines[i]!;
        if (!lineMatches(text, pattern)) continue;
        matchCount++;
        if (lines.length < maxLinesPerFile) lines.push({ line: i + 1, text });
      }
      if (matchCount === 0) continue;

      files.push({
        filepath: `qmd://${displayPath}`,
        displayPath,
        title: row.title,
        hash: row.hash,
        docid: row.hash.slice(0, 6),
        collectionName: row.collection,
        lines,
        matchCount,
      });
      if (files.length >= limit) {
        truncated = true;
        break outer;
      }
    }

    if (batch.length < SCAN_BATCH_SIZE) break;
  }

  return { files, scanned, truncated };
};
