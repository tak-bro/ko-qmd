/**
 * Judge pools: which documents the judge grades for each query, and the text it sees.
 *
 * A pool is the union of every backend's top-k for one query in a `qmd bench --json` result,
 * deduplicated in first-seen order. Grades are per document, so one pool serves every backend's
 * nDCG and a document two backends both return is graded once.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchmarkResult } from "../../src/bench/types.js";

export interface JudgeQuery {
  id: string;
  query: string;
  /** ko-bench type for goldset queries; `open` or `off-corpus` for queries without an answer key. */
  type: string;
  /** Goldset answer files when the query came from ko-bench.json; empty for open queries. */
  expected_files: string[];
}

export interface QuerySet {
  description: string;
  queries: JudgeQuery[];
}

export interface Pool {
  id: string;
  query: string;
  /** Corpus-relative paths, e.g. `wiki/inverted-index.md`. */
  files: string[];
  /** Each backend's ranking, corpus-relative, top-k. */
  rankings: Record<string, string[]>;
}

/** `qmd://ko-vault/wiki/x.md` → `wiki/x.md`. Paths without the scheme pass through. */
export function corpusPath(file: string): string {
  const m = file.match(/^qmd:\/\/[^/]+\/(.+)$/);
  return m ? m[1]! : file;
}

export function buildPools(
  bench: BenchmarkResult,
  querySet: QuerySet,
  backends: readonly string[],
  k = 10,
): Pool[] {
  const byId = new Map(bench.results.map(r => [r.id, r]));
  return querySet.queries.map(q => {
    const result = byId.get(q.id);
    if (!result) throw new Error(`bench result has no query ${q.id} — rerun bench-ko.sh with this query set`);
    const rankings: Record<string, string[]> = {};
    const seen = new Set<string>();
    const files: string[] = [];
    for (const name of backends) {
      const br = result.backends[name];
      if (!br) throw new Error(`query ${q.id}: bench result has no backend ${name}`);
      if (br.error) throw new Error(`query ${q.id}: backend ${name} failed: ${br.error}`);
      rankings[name] = br.top_files.slice(0, k).map(corpusPath);
      for (const f of rankings[name]!) {
        if (!seen.has(f)) {
          seen.add(f);
          files.push(f);
        }
      }
    }
    return { id: q.id, query: q.query, files, rankings };
  });
}

export interface DocText {
  title: string;
  body: string;
}

/**
 * Title (first `# ` heading, else the file name) and body without frontmatter, cut to
 * `maxChars`. Frontmatter aliases stay: they are how the vault names the concept.
 */
export function loadDoc(corpusDir: string, file: string, maxChars = 900): DocText {
  const raw = readFileSync(join(corpusDir, file), "utf8");
  let body = raw;
  let aliases: string[] = [];
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    body = raw.slice(fm[0].length);
    aliases = [...fm[1]!.matchAll(/^\s+-\s+"?([^"\n]+)"?\s*$/gm)]
      .map(m => m[1]!)
      .filter(a => !a.startsWith("[["));
  }
  const heading = body.match(/^#\s+(.+)$/m);
  const title = heading ? heading[1]!.trim() : file.replace(/^.*\//, "").replace(/\.md$/, "");
  const text = body.replace(/^#\s+.+$/m, "").replace(/\n{3,}/g, "\n\n").trim();
  const withAliases = aliases.length ? `별칭: ${aliases.join(", ")}\n${text}` : text;
  return { title, body: withAliases.length > maxChars ? `${withAliases.slice(0, maxChars)}…` : withAliases };
}
