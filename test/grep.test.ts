/**
 * grep.test.ts — exact and regex matching over indexed bodies.
 *
 * Two properties carry the weight. The line numbers have to be the ones `qmd get
 * file.md:N:count` takes, or the results are unusable; and a pathological pattern has to
 * terminate, because in the daemon a catastrophic backtrack blocks the only thread and every
 * session on the machine stops getting answers.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type QMDStore } from "../src/index.js";
import { compileGrepPattern, grepDocuments, MAX_PATTERN_LENGTH } from "../src/grep.js";
import { buildDocumentFilter } from "../src/filters.js";

let root: string;
let store: QMDStore;
const COLLECTIONS = ["docs"];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "qmd-grep-"));
  const docs = join(root, "docs");
  mkdirSync(join(docs, "journals"), { recursive: true });
  mkdirSync(join(docs, "archive"), { recursive: true });

  writeFileSync(join(docs, "journals", "note.md"), [
    "# Note",            // 1
    "",                  // 2
    "TODO: call the bank",   // 3
    "",                  // 4
    "todo: lowercase too",   // 5
    "",                  // 6
    "한글 토큰화가 놓친 문자열",  // 7
  ].join("\n") + "\n");

  writeFileSync(join(docs, "archive", "old.md"), [
    "# Old",             // 1
    "",                  // 2
    "TODO: archived",    // 3
  ].join("\n") + "\n");

  writeFileSync(join(docs, "archive", "quiet.md"), "# Quiet\n\nnothing of interest\n");

  // One very long line — the case the per-line bound exists for.
  writeFileSync(join(docs, "archive", "long.md"), `# Long\n\n${"a".repeat(50_000)} needle\n`);

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

const grep = (pattern: string, options = {}, compileOptions = {}) =>
  grepDocuments(store.internal.db, compileGrepPattern(pattern, compileOptions), { collections: COLLECTIONS, ...options });

describe("compileGrepPattern", () => {
  test("smart case: a lowercase pattern matches either case", () => {
    expect(compileGrepPattern("todo").flags).toContain("i");
  });

  test("smart case: an uppercase letter makes it case-sensitive", () => {
    expect(compileGrepPattern("TODO").flags).not.toContain("i");
  });

  test("Hangul has no case, so a Korean pattern stays case-insensitive", () => {
    expect(compileGrepPattern("한글").flags).toContain("i");
  });

  test("an explicit choice beats smart case", () => {
    expect(compileGrepPattern("todo", { caseSensitive: true }).flags).not.toContain("i");
    expect(compileGrepPattern("TODO", { caseSensitive: false }).flags).toContain("i");
  });

  test("a fixed string is matched literally", () => {
    const pattern = compileGrepPattern("a.b", { fixedString: true });
    expect(pattern.test("a.b")).toBe(true);
    pattern.lastIndex = 0;
    expect(pattern.test("axb")).toBe(false);
  });

  test("an invalid regex is an error, not a crash mid-scan", () => {
    expect(() => compileGrepPattern("(unclosed")).toThrow(/not a regular expression/);
  });

  test("an over-long pattern is refused", () => {
    expect(() => compileGrepPattern("a".repeat(MAX_PATTERN_LENGTH + 1))).toThrow(/over the 1000 limit/);
    expect(() => compileGrepPattern("a".repeat(MAX_PATTERN_LENGTH))).not.toThrow();
  });

  test("an empty pattern is refused rather than matching every line", () => {
    expect(() => compileGrepPattern("")).toThrow(/empty pattern/);
  });
});

describe("grepDocuments", () => {
  test("reports the line numbers `qmd get path:N:count` takes", () => {
    const result = grep("call the bank");
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.displayPath).toBe("docs/journals/note.md");
    expect(result.files[0]!.lines).toEqual([{ line: 3, text: "TODO: call the bank" }]);
  });

  test("groups several matches under one file", () => {
    const result = grep("todo");
    const note = result.files.find(f => f.displayPath === "docs/journals/note.md")!;
    expect(note.lines.map(l => l.line)).toEqual([3, 5]);
    expect(note.matchCount).toBe(2);
  });

  test("case-sensitive by smart case finds only the uppercase one", () => {
    const result = grep("TODO");
    const note = result.files.find(f => f.displayPath === "docs/journals/note.md")!;
    expect(note.lines.map(l => l.line)).toEqual([3]);
  });

  test("finds Hangul that tokenization would have missed", () => {
    const result = grep("놓친 문자열");
    expect(result.files.map(f => f.displayPath)).toEqual(["docs/journals/note.md"]);
    expect(result.files[0]!.lines[0]!.line).toBe(7);
  });

  test("returns qmd:// paths and docids that address the same document", () => {
    const file = grep("call the bank").files[0]!;
    expect(file.filepath).toBe("qmd://docs/journals/note.md");
    expect(file.docid).toHaveLength(6);
    expect(file.hash.startsWith(file.docid)).toBe(true);
  });

  test("a pattern nothing contains returns no files but reports what it read", () => {
    const result = grep("kilimanjaro");
    expect(result.files).toEqual([]);
    expect(result.scanned).toBe(4);
    expect(result.truncated).toBe(false);
  });

  test("takes the same path filter as a search", () => {
    const result = grep("TODO", { filter: buildDocumentFilter({ path: ["docs/journals/**"] }) });
    expect(result.files.map(f => f.displayPath)).toEqual(["docs/journals/note.md"]);
  });

  test("a time filter that excludes everything finds nothing", () => {
    const result = grep("TODO", { filter: buildDocumentFilter({ until: "2000-01-01" }) });
    expect(result.files).toEqual([]);
    expect(result.scanned).toBe(0);
  });

  test("stops at the file limit and says it stopped", () => {
    const result = grep("TODO", { limit: 1 });
    expect(result.files).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  test("caps reported lines per file but still counts the matches", () => {
    const result = grep("todo", { maxLinesPerFile: 1 });
    const note = result.files.find(f => f.displayPath === "docs/journals/note.md")!;
    expect(note.lines).toHaveLength(1);
    expect(note.matchCount).toBe(2);
  });

  test("a regular expression is a regular expression", () => {
    const result = grep("TODO: (call|archived)");
    expect(result.files.map(f => f.displayPath).sort()).toEqual([
      "docs/archive/old.md",
      "docs/journals/note.md",
    ]);
  });
});

describe("a grep line number addresses the same line through `get`", () => {
  // The whole point of reporting line numbers is that they are usable. If grep counts lines
  // one way and `qmd get file:N:count` counts them another, every result is off by however
  // much the two disagree, and nothing in either feature notices.
  test("`get <file>:<n>:1` returns the line grep reported", async () => {
    const file = grep("call the bank").files[0]!;
    const hit = file.lines[0]!;
    const body = await store.getDocumentBody(file.displayPath, { fromLine: hit.line, maxLines: 1 });
    expect(body?.trim()).toBe(hit.text);
  });

  test("it holds for a match further down the file", async () => {
    const note = grep("todo").files.find(f => f.displayPath === "docs/journals/note.md")!;
    const last = note.lines[note.lines.length - 1]!;
    const body = await store.getDocumentBody(note.displayPath, { fromLine: last.line, maxLines: 1 });
    expect(body?.trim()).toBe(last.text);
  });

  test("it holds for a Hangul line, where byte and character counts differ", async () => {
    const file = grep("놓친 문자열").files[0]!;
    const hit = file.lines[0]!;
    const body = await store.getDocumentBody(file.displayPath, { fromLine: hit.line, maxLines: 1 });
    expect(body?.trim()).toBe(hit.text);
  });
});

describe("a pathological pattern terminates", () => {
  // The scan is bounded per line rather than per document, so the worst case is the longest
  // line, not the corpus. A per-document timeout could not help here: a catastrophic
  // backtrack blocks the thread, so the timer never fires.
  test("a nested-quantifier pattern over a 50KB line finishes well inside a second", () => {
    const started = Date.now();
    const result = grep("(a+)+$");
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2_000);
    expect(result.scanned).toBe(4);
  });

  test("a match after a 50KB run of the same character is still found", () => {
    // The long line is scanned in overlapping slices; the overlap is the pattern cap, so a
    // match near a slice boundary is not lost.
    const result = grep("needle");
    expect(result.files.map(f => f.displayPath)).toEqual(["docs/archive/long.md"]);
  });
});
