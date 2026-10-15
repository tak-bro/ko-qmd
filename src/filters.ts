/**
 * filters.ts — narrowing a search to part of the corpus.
 *
 * A query can already be scoped to collections. These are the two other questions people
 * actually ask of their own notes: "only under this path" and "only what I touched lately".
 * Parsing lives here, away from SQL, because the failure that matters is a typo in a flag:
 * `--since 7dd` has to say so rather than quietly search everything.
 */

import picomatch from "picomatch";

export type DocumentFilter = {
  /** Globs against `collection/path`, the same string results print. `!` prefix excludes. */
  readonly paths?: readonly string[];
  /** ISO timestamps compared against `documents.modified_at`. */
  readonly sinceIso?: string;
  readonly untilIso?: string;
};

/** True when the filter would actually narrow anything. */
export const isNarrowing = (filter?: DocumentFilter): filter is DocumentFilter =>
  filter !== undefined &&
  ((filter.paths?.length ?? 0) > 0 || filter.sinceIso !== undefined || filter.untilIso !== undefined);

const SPAN_PATTERN = /^(\d+)\s*(m|h|d|w|mo|y)$/i;
const SPAN_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  mo: 2_592_000_000, // 30 days
  y: 31_536_000_000, // 365 days
};

/**
 * A point in time, from either a span back from now (`7d`, `3h`, `2w`, `6mo`) or a date
 * (`2026-09-01`, `2026-09-01T10:00:00Z`). Throws on anything else — a filter that silently
 * means "no filter" is worse than an error, because the result still looks like an answer.
 */
export const parseTimeSpec = (spec: string, now: Date = new Date()): string => {
  const trimmed = spec.trim();
  if (trimmed === "") throw new Error(`empty time filter`);

  const span = SPAN_PATTERN.exec(trimmed);
  if (span) {
    const amount = Number(span[1]);
    const unit = span[2]!.toLowerCase();
    return new Date(now.getTime() - amount * SPAN_MS[unit]!).toISOString();
  }

  // A bare date is the start of that day in local time, so `--since 2026-09-01` includes
  // everything written on the 1st rather than starting at its UTC midnight.
  const bareDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (bareDate) {
    const [, y, mo, d] = bareDate;
    const date = new Date(Number(y), Number(mo) - 1, Number(d));
    if (Number.isNaN(date.getTime())) throw new Error(`not a date: '${spec}'`);
    return date.toISOString();
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`not a time: '${spec}' — use a span like '7d' or a date like '2026-09-01'`);
  }
  return parsed.toISOString();
};

type PathMatcher = (displayPath: string) => boolean;

const matcherCache = new Map<string, PathMatcher>();

/**
 * Compile path globs into one predicate.
 *
 * Positive patterns are an OR: a document has to be under one of them. Negative (`!`)
 * patterns then veto, so `--path 'journals/**' --path '!journals/2024/**'` reads the way it
 * looks. Negatives alone mean "everything except these".
 */
export const compilePathMatcher = (patterns: readonly string[]): PathMatcher => {
  const key = patterns.join("\u0000");
  const cached = matcherCache.get(key);
  if (cached) return cached;

  const includes: string[] = [];
  const excludes: string[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (pattern === "") continue;
    if (pattern.startsWith("!")) excludes.push(pattern.slice(1));
    else includes.push(pattern);
  }

  // `foo/bar` should match the directory's contents, not just a file called `bar`; people
  // type the prefix they see in results. `foo/bar/**` stays exact. A trailing slash is the
  // same directory prefix (`foo/` ≡ `foo`), so strip it before expanding to `foo/**`.
  const asPrefix = (pattern: string): string[] => {
    if (pattern.includes("*")) return [pattern];
    const base = pattern.replace(/\/+$/, "");
    if (base === "" || base === pattern) return base === pattern ? [pattern, `${pattern}/**`] : [pattern];
    return [base, `${base}/**`];
  };

  const isIncluded = includes.length === 0
    ? () => true
    : picomatch(includes.flatMap(asPrefix), { dot: true });
  const isExcluded = excludes.length === 0
    ? () => false
    : picomatch(excludes.flatMap(asPrefix), { dot: true });

  const matcher: PathMatcher = (displayPath) => isIncluded(displayPath) && !isExcluded(displayPath);
  matcherCache.set(key, matcher);
  return matcher;
};

/** Whether a document's `collection/path` survives the filter's path globs. */
export const matchesPaths = (displayPath: string, filter?: DocumentFilter): boolean => {
  if (!filter?.paths || filter.paths.length === 0) return true;
  return compilePathMatcher(filter.paths)(displayPath);
};

/**
 * Build a filter from raw CLI or MCP input. Returns undefined when nothing was asked for, so
 * callers can keep the unfiltered fast paths.
 */
export const buildDocumentFilter = (
  input: { path?: readonly string[]; since?: string; until?: string },
  now: Date = new Date(),
): DocumentFilter | undefined => {
  const paths = (input.path ?? []).filter(p => p.trim() !== "");
  const sinceIso = input.since !== undefined ? parseTimeSpec(input.since, now) : undefined;
  const untilIso = input.until !== undefined ? parseTimeSpec(input.until, now) : undefined;
  if (sinceIso !== undefined && untilIso !== undefined && sinceIso > untilIso) {
    throw new Error(`--since is after --until`);
  }
  const filter: DocumentFilter = { ...(paths.length > 0 ? { paths } : {}), ...(sinceIso ? { sinceIso } : {}), ...(untilIso ? { untilIso } : {}) };
  return isNarrowing(filter) ? filter : undefined;
};

/** How the filter reads back to a user when it removed everything. */
export const describeFilter = (filter: DocumentFilter): string => {
  const parts: string[] = [];
  if (filter.paths && filter.paths.length > 0) parts.push(`path ${filter.paths.map(p => `'${p}'`).join(", ")}`);
  if (filter.sinceIso) parts.push(`since ${filter.sinceIso}`);
  if (filter.untilIso) parts.push(`until ${filter.untilIso}`);
  return parts.join(", ");
};
