// Fixture invariants for the ko-vault bench goldset (ko-bench-hard work).
// These run against the checked-in fixture files — no index, no embeddings.
import { describe, test, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { hangulLoanwordForms, hangulStems } from "../src/hangul.js";
import type { BenchmarkQuery } from "../src/bench/types.js";

const FIXTURE = join(import.meta.dirname, "fixtures/ko-vault");
const bench = JSON.parse(readFileSync(join(FIXTURE, "ko-bench.json"), "utf8")) as {
  queries: BenchmarkQuery[];
};

// Function words / generic predicates that hangulStems leaves on content stems.
// Deliberately tiny: real stopword lists belong to the search engine, not the fixture test.
const STOPWORDS = new Set(["것", "수", "등", "또", "및", "위한", "때문", "대한", "있는", "하는", "되는"]);

const tokens = (text: string): string[] =>
  text
    .split(/[\s,.·:;()"'`\-—]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

/** Content stems for a term, expanded with loanword forms (임베딩 → embedding). */
const terms = (text: string): Set<string> => {
  const out = new Set<string>();
  for (const token of tokens(text)) {
    if (STOPWORDS.has(token)) continue;
    const stems = hangulStems(token);
    for (const stem of stems.length > 0 ? stems : [token.toLowerCase()]) {
      out.add(stem);
      for (const form of hangulLoanwordForms(stem)) out.add(form.toLowerCase());
    }
  }
  return out;
};

/** Title-ish terms of a fixture doc: basename + frontmatter aliases + first `# ` heading. */
const titleTerms = (relPath: string): Set<string> => {
  const raw = readFileSync(join(FIXTURE, relPath), "utf8");
  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  const aliases = fm ? [...fm[1].matchAll(/- "([^"]+)"/g)].map((m) => m[1]) : [];
  const heading = raw.match(/^# (.+)$/m)?.[1] ?? "";
  const stem = basename(relPath, extname(relPath)).replace(/-/g, " ");
  return terms([stem, heading, ...aliases].join(" "));
};

const wikiDocs = readdirSync(join(FIXTURE, "wiki"), { recursive: true }).filter((f) => f.endsWith(".md"));
const distractorDocs = readdirSync(join(FIXTURE, "distractors")).filter((f) => f.endsWith(".md"));
const byType = new Map<string, number>();
for (const q of bench.queries) byType.set(q.type, (byType.get(q.type) ?? 0) + 1);

describe("ko-bench fixture", () => {
  test("hard query buckets are present with locked counts", () => {
    expect(byType.get("exact")).toBe(19);
    expect(byType.get("alias")).toBe(24);
    expect(byType.get("semantic")).toBe(11);
    expect(byType.get("topical")).toBe(6);
    expect(byType.get("cross-domain")).toBe(3);
    expect(byType.get("sem-hard")).toBe(12);
    expect(byType.get("multi")).toBe(8);
    expect(byType.get("neg")).toBe(10);
    const hard = (byType.get("sem-hard") ?? 0) + (byType.get("multi") ?? 0) + (byType.get("neg") ?? 0);
    expect(hard).toBe(30);
  });

  test("every expected_files path exists in the fixture", () => {
    for (const q of bench.queries) {
      for (const f of q.expected_files) {
        expect(existsSync(join(FIXTURE, f)), `${q.id}: ${f}`).toBe(true);
      }
    }
  });

  test("no distractor basename equals a wiki basename (bench matches by path suffix)", () => {
    const wikiStems = new Set(wikiDocs.map((f) => basename(f, extname(f))));
    for (const d of distractorDocs) {
      expect(wikiStems.has(basename(d, extname(d))), d).toBe(false);
    }
  });

  test("sem-hard queries share no title term with their target (loanword forms included)", () => {
    const semHard = bench.queries.filter((q) => q.type === "sem-hard");
    expect(semHard.length).toBeGreaterThan(0);
    for (const q of semHard) {
      const qTerms = terms(q.query);
      for (const f of q.expected_files) {
        const leaked = [...titleTerms(f)].filter((t) => qTerms.has(t));
        expect(leaked, `${q.id} leaks ${JSON.stringify(leaked)} into ${f}`).toEqual([]);
      }
    }
  });

  test("multi queries span 2–3 notes with expected_in_top_k equal to their count", () => {
    const multi = bench.queries.filter((q) => q.type === "multi");
    expect(multi.length).toBeGreaterThan(0);
    for (const q of multi) {
      expect(q.expected_files.length, q.id).toBeGreaterThanOrEqual(2);
      expect(q.expected_files.length, q.id).toBeLessThanOrEqual(3);
      expect(q.expected_in_top_k, q.id).toBe(q.expected_files.length);
    }
  });

  test("neg queries exclude a named concept that is not among the expected files", () => {
    const neg = bench.queries.filter((q) => q.type === "neg");
    expect(neg.length).toBeGreaterThan(0);
    for (const q of neg) {
      expect(q.excluded, `${q.id}: neg query must name its excluded concept`).toBeDefined();
      expect(existsSync(join(FIXTURE, q.excluded!)), `${q.id}: ${q.excluded}`).toBe(true);
      expect(q.expected_files, q.id).not.toContain(q.excluded);
      expect(q.expected_files.length, q.id).toBe(1);
    }
  });
});
