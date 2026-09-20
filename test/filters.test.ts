/**
 * filters.test.ts — parsing and matching for `--path` / `--since` / `--until`.
 *
 * The thing these tests protect is the failure mode of a silent filter: a typo that parses
 * as "no filter" returns a full-corpus answer that looks correct.
 */

import { describe, test, expect } from "vitest";
import {
  buildDocumentFilter,
  compilePathMatcher,
  describeFilter,
  isNarrowing,
  matchesPaths,
  parseTimeSpec,
} from "../src/filters.js";

const NOW = new Date("2026-09-20T12:00:00.000Z");

describe("parseTimeSpec", () => {
  test("reads a span back from now", () => {
    expect(parseTimeSpec("7d", NOW)).toBe("2026-09-13T12:00:00.000Z");
    expect(parseTimeSpec("3h", NOW)).toBe("2026-09-20T09:00:00.000Z");
    expect(parseTimeSpec("2w", NOW)).toBe("2026-09-06T12:00:00.000Z");
    expect(parseTimeSpec("30m", NOW)).toBe("2026-09-20T11:30:00.000Z");
  });

  test("tolerates the spacing and case people actually type", () => {
    expect(parseTimeSpec("7 d", NOW)).toBe(parseTimeSpec("7d", NOW));
    expect(parseTimeSpec(" 7D ", NOW)).toBe(parseTimeSpec("7d", NOW));
  });

  test("reads an explicit timestamp", () => {
    expect(parseTimeSpec("2026-09-01T10:00:00Z", NOW)).toBe("2026-09-01T10:00:00.000Z");
  });

  test("a bare date starts at that local day, not at UTC midnight", () => {
    // Someone asking for notes since the 1st means the whole of their 1st.
    const iso = parseTimeSpec("2026-09-01", NOW);
    const local = new Date(iso);
    expect(local.getFullYear()).toBe(2026);
    expect(local.getMonth()).toBe(8);
    expect(local.getDate()).toBe(1);
    expect(local.getHours()).toBe(0);
  });

  test("rejects garbage instead of meaning 'no filter'", () => {
    expect(() => parseTimeSpec("7dd", NOW)).toThrow(/not a time/);
    expect(() => parseTimeSpec("last tuesday", NOW)).toThrow(/not a time/);
    expect(() => parseTimeSpec("", NOW)).toThrow(/empty/);
  });
});

describe("compilePathMatcher", () => {
  test("a bare prefix matches everything under it", () => {
    const match = compilePathMatcher(["journals"]);
    expect(match("journals/2026-09-20.md")).toBe(true);
    expect(match("journals")).toBe(true);
    expect(match("notes/2026-09-20.md")).toBe(false);
  });

  test("a glob matches across directories, including none", () => {
    const match = compilePathMatcher(["vault/**/*.md"]);
    expect(match("vault/a/b/c.md")).toBe(true);
    expect(match("vault/a.md")).toBe(true);   // `**` spans zero directories, as globs do
    expect(match("vault/a/b/c.txt")).toBe(false);
    expect(match("other/a.md")).toBe(false);
  });

  test("several includes are an OR", () => {
    const match = compilePathMatcher(["journals/**", "kb/**"]);
    expect(match("journals/x.md")).toBe(true);
    expect(match("kb/y.md")).toBe(true);
    expect(match("notes/z.md")).toBe(false);
  });

  test("an exclude beats an include", () => {
    const match = compilePathMatcher(["journals/**", "!journals/2024/**"]);
    expect(match("journals/2026/a.md")).toBe(true);
    expect(match("journals/2024/a.md")).toBe(false);
  });

  test("excludes alone mean everything else", () => {
    const match = compilePathMatcher(["!archive/**"]);
    expect(match("journals/a.md")).toBe(true);
    expect(match("archive/a.md")).toBe(false);
  });

  test("matches dotted paths, which a vault is full of", () => {
    expect(compilePathMatcher(["kb/**"])("kb/.obsidian/config.md")).toBe(true);
  });
});

describe("buildDocumentFilter", () => {
  test("nothing asked for is no filter at all", () => {
    expect(buildDocumentFilter({}, NOW)).toBeUndefined();
    expect(buildDocumentFilter({ path: [] }, NOW)).toBeUndefined();
    expect(buildDocumentFilter({ path: ["  "] }, NOW)).toBeUndefined();
  });

  test("collects what was asked for", () => {
    const filter = buildDocumentFilter({ path: ["kb/**"], since: "7d", until: "2026-09-19" }, NOW);
    expect(filter?.paths).toEqual(["kb/**"]);
    expect(filter?.sinceIso).toBe("2026-09-13T12:00:00.000Z");
    expect(filter?.untilIso).toBeDefined();
    expect(isNarrowing(filter)).toBe(true);
  });

  test("an inverted range is an error, not an empty result", () => {
    expect(() => buildDocumentFilter({ since: "2026-09-19", until: "2026-09-01" }, NOW)).toThrow(/after/);
  });

  test("a bad span propagates its parse error", () => {
    expect(() => buildDocumentFilter({ since: "7dd" }, NOW)).toThrow(/not a time/);
  });
});

describe("matchesPaths", () => {
  test("no path filter passes everything", () => {
    expect(matchesPaths("anything/at/all.md", undefined)).toBe(true);
    expect(matchesPaths("anything/at/all.md", { sinceIso: "2026-01-01T00:00:00.000Z" })).toBe(true);
  });

  test("applies the compiled globs", () => {
    expect(matchesPaths("kb/a.md", { paths: ["kb/**"] })).toBe(true);
    expect(matchesPaths("notes/a.md", { paths: ["kb/**"] })).toBe(false);
  });
});

describe("describeFilter", () => {
  test("reads back what was asked for", () => {
    const filter = buildDocumentFilter({ path: ["kb/**"], since: "7d" }, NOW)!;
    expect(describeFilter(filter)).toBe("path 'kb/**', since 2026-09-13T12:00:00.000Z");
  });
});
