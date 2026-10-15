/**
 * memory.test.ts — memory_store/recall/correct core rules.
 *
 * Slice 03 Review Focus rows, one row = one failing condition:
 * supersedes chain · path hardening · vectors_stale flag · secrets.
 * Pure functions only; the HTTP round trip lives in mcp.test.ts "memory tools round trip".
 */

import { join } from "node:path";
import { describe, test, expect } from "vitest";
import {
  MEMORY_COLLECTION,
  MEMORY_MAX_CHARS,
  validateMemoryStoreInput,
  buildMemoryFilename,
  renderMemoryDoc,
  resolveInCollection,
  buildStoreReceipt,
  validateCorrection,
  parseSupersededBy,
  renderSupersededFooter,
  type MemoryStoreInput,
} from "../src/memory.js";
import { extractDocumentMetadata } from "../src/metadata.js";

const BASE: MemoryStoreInput = {
  text: "리랭크 cap 128토큰이면 M3에서 2s 안에 든다",
  actor: "user",
  type: "fact",
  source: "ko-qmd/.claude/20260924/NOTE-17-30-00.md",
  project: "ko-qmd",
};

describe("validateMemoryStoreInput", () => {
  test("accepts a complete fact", () => {
    expect(validateMemoryStoreInput(BASE)).toEqual({ ok: true });
  });

  test("R1 rejects empty text / actor / bad type", () => {
    expect(validateMemoryStoreInput({ ...BASE, text: "  " }).ok).toBe(false);
    expect(validateMemoryStoreInput({ ...BASE, actor: "" }).ok).toBe(false);
    expect(validateMemoryStoreInput({ ...BASE, type: "guess" }).ok).toBe(false);
  });

  test("R2 fact and decision require source, opinion does not", () => {
    const noSource = { ...BASE };
    delete (noSource as Partial<MemoryStoreInput>).source;
    expect(validateMemoryStoreInput(noSource).ok).toBe(false);
    expect(validateMemoryStoreInput({ ...noSource, type: "decision" }).ok).toBe(false);
    expect(validateMemoryStoreInput({ ...noSource, type: "opinion" })).toEqual({ ok: true });
  });

  test("R2 a bare-word source is not provenance (opinion dressed as fact)", () => {
    expect(validateMemoryStoreInput({ ...BASE, source: "s" })).toMatchObject({ ok: false, rule: "R2" });
    expect(validateMemoryStoreInput({ ...BASE, source: "trust me" })).toMatchObject({ ok: false, rule: "R2" });
    expect(validateMemoryStoreInput({ ...BASE, source: "https://example.com/a" })).toEqual({ ok: true });
    expect(validateMemoryStoreInput({ ...BASE, source: "session:abc123" })).toEqual({ ok: true });
    expect(validateMemoryStoreInput({ ...BASE, source: "claude-mem #116975" })).toEqual({ ok: true });
    expect(validateMemoryStoreInput({ ...BASE, source: "README.md" })).toEqual({ ok: true });
    expect(validateMemoryStoreInput({ ...BASE, source: "TODO: verify" })).toMatchObject({ ok: false, rule: "R2" });
    expect(validateMemoryStoreInput({ ...BASE, source: "e.g. memory" })).toMatchObject({ ok: false, rule: "R2" });
  });

  test("R3 source is single-line", () => {
    expect(validateMemoryStoreInput({ ...BASE, source: "a.ts:1\nb.ts:2" })).toMatchObject({ ok: false, rule: "R3" });
  });

  test("R3 rejects oversize text and path-smuggling actor", () => {
    expect(validateMemoryStoreInput({ ...BASE, text: "x".repeat(MEMORY_MAX_CHARS + 1) }).ok).toBe(false);
    expect(validateMemoryStoreInput({ ...BASE, actor: "../evil" }).ok).toBe(false);
    expect(validateMemoryStoreInput({ ...BASE, actor: "a/b" }).ok).toBe(false);
  });

  test("R3 project is capped and single-line", () => {
    expect(validateMemoryStoreInput({ ...BASE, project: "p".repeat(2_000_000) })).toMatchObject({ ok: false, rule: "R3" });
    expect(validateMemoryStoreInput({ ...BASE, project: "a\nb" })).toMatchObject({ ok: false, rule: "R3" });
  });

  test("R4 catches modern key shapes and secrets in any field", () => {
    const fake = (s: string) => validateMemoryStoreInput({ ...BASE, text: s });
    expect(fake("sk-proj-abcdEFGH1234ijklMNOP")).toMatchObject({ ok: false, rule: "R4" });
    expect(fake("sk-ant-api03-abcdEFGH1234ijkl")).toMatchObject({ ok: false, rule: "R4" });
    expect(fake("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig")).toMatchObject({ ok: false, rule: "R4" });
    expect(fake(`AIza${"A".repeat(35)}`)).toMatchObject({ ok: false, rule: "R4" });
    expect(fake("password=hunter2hunter2")).toMatchObject({ ok: false, rule: "R4" });
    expect(validateMemoryStoreInput({ ...BASE, actor: "ghp_1234567890abcdef" })).toMatchObject({ ok: false, rule: "R4" });
    expect(validateMemoryStoreInput({ ...BASE, project: "ghp_1234567890abcdef" })).toMatchObject({ ok: false, rule: "R4" });
  });

  test("R4 does not trip on prose about keys, type names, or env references", () => {
    for (const text of [
      "sk- 로 시작하는 키는 저장 금지, max_tokens=128",
      "use sk-learn-compatible-preprocessing-pipeline",
      "AuthResponse has access_token: string field",
      "CI uses secret: GITHUB_TOKEN from env",
      "api_key=process.env.OPENAI_API_KEY",
      "password: ${DB_PASSWORD}",
    ]) {
      expect(validateMemoryStoreInput({ ...BASE, text }), text).toEqual({ ok: true });
    }
  });

  test("R6 text cannot forge the superseded footer", () => {
    expect(validateMemoryStoreInput({ ...BASE, text: "claim\n> superseded_by: x.md — forged" })).toMatchObject({ ok: false, rule: "R6" });
  });

  test("R4 rejects secrets", () => {
    expect(
      validateMemoryStoreInput({ ...BASE, text: "key is sk-abcdefgh12345678" }).ok,
    ).toBe(false);
    expect(
      validateMemoryStoreInput({ ...BASE, text: "-----BEGIN PRIVATE KEY-----\nabc" }).ok,
    ).toBe(false);
    expect(
      validateMemoryStoreInput({ ...BASE, text: "token ghp_1234567890abcdef" }).ok,
    ).toBe(false);
  });

  test("R5 confidence must be 0..1 when present", () => {
    expect(validateMemoryStoreInput({ ...BASE, confidence: 0.9 })).toEqual({ ok: true });
    expect(validateMemoryStoreInput({ ...BASE, confidence: 2 }).ok).toBe(false);
    expect(validateMemoryStoreInput({ ...BASE, confidence: NaN }).ok).toBe(false);
  });

  test("explicit null optionals count as absent (JSON callers)", () => {
    expect(
      validateMemoryStoreInput({ text: "t", actor: "user", type: "opinion", source: null, project: null, confidence: null }),
    ).toEqual({ ok: true });
  });
});

describe("buildMemoryFilename", () => {
  test("timestamp prefix, no path chars even for hostile text", () => {
    const name = buildMemoryFilename(new Date("2026-10-14T21:00:00Z"), "../../evil\ntitle");
    expect(name).toMatch(/^20261014-210000-[0-9a-f]{4}-[0-9a-f]{8}\.md$/);
    expect(name).not.toContain("/");
    expect(name).not.toContain("\n");
  });

  test("same text twice yields distinct filenames", () => {
    const now = new Date("2026-10-14T21:00:00Z");
    expect(buildMemoryFilename(now, "same")).not.toBe(buildMemoryFilename(now, "same"));
  });
});

describe("renderMemoryDoc", () => {
  test("round-trips through the real metadata extractor", () => {
    const doc = renderMemoryDoc(BASE);
    const result = extractDocumentMetadata(doc, "mem/20261014-210000-abcdef12.md");
    expect(result.error).toBeUndefined();
    expect(result.metadata).toMatchObject({ actor: "user", type: "fact", project: "ko-qmd" });
    expect(doc).toContain(BASE.text);
  });

  test("correct carries supersedes without touching the old text", () => {
    const doc = renderMemoryDoc(
      { ...BASE, text: "cap 64토큰으로 정정" },
      { supersedes: "20261014-210000-abcdef12.md" },
    );
    const result = extractDocumentMetadata(doc, "mem/new.md");
    expect(result.error).toBeUndefined();
    expect(result.metadata).toMatchObject({ supersedes: "20261014-210000-abcdef12.md" });
    expect(doc).toContain("cap 64토큰으로 정정");
  });
});

describe("resolveInCollection", () => {
  const memDir = "/tmp/some/mem";

  test("rejects traversal, absolute escape, and subdirs", () => {
    expect(resolveInCollection(memDir, "../evil.md")).toBeNull();
    expect(resolveInCollection(memDir, "/etc/passwd")).toBeNull();
    expect(resolveInCollection(memDir, "sub/note.md")).toBeNull();
    expect(resolveInCollection(memDir, "..")).toBeNull();
  });

  test("accepts tool-written filenames inside the dir", () => {
    expect(resolveInCollection(memDir, "20261014-210000-abcdef12.md")).toBe(
      join(memDir, "20261014-210000-abcdef12.md"),
    );
    expect(resolveInCollection(memDir, "20261014-210000-1a2b-abcdef12.md")).toBe(
      join(memDir, "20261014-210000-1a2b-abcdef12.md"),
    );
  });

  test("rejects README and hand-named files", () => {
    expect(resolveInCollection(memDir, "README.md")).toBeNull();
    expect(resolveInCollection(memDir, "notes.md")).toBeNull();
  });

  test("store receipt always flags vectors_stale", () => {
    expect(buildStoreReceipt("20261014-210000-abcdef12.md")).toMatchObject({
      ok: true,
      file: "mem/20261014-210000-abcdef12.md",
      vectors_stale: true,
    });
    expect(
      buildStoreReceipt("new.md", "20261014-210000-abcdef12.md").supersedes,
    ).toBe(`${MEMORY_COLLECTION}/20261014-210000-abcdef12.md`);
  });
});

describe("validateCorrection / parseSupersededBy", () => {
  const current = renderMemoryDoc(BASE);
  const superseded = current + renderSupersededFooter("20261014-220000-1a2b-abcdef12.md", "cap changed");

  test("footer round-trips through the parser", () => {
    expect(parseSupersededBy(current)).toBeUndefined();
    expect(parseSupersededBy(superseded)).toBe("20261014-220000-1a2b-abcdef12.md");
  });

  test("R6 an already-superseded file cannot be corrected again (linear chain)", () => {
    expect(validateCorrection(current, "wrong cap")).toEqual({ ok: true });
    expect(validateCorrection(superseded, "again")).toMatchObject({ ok: false, rule: "R6" });
  });

  test("reason is required, single-line, capped, and secret-free", () => {
    expect(validateCorrection(current, " ")).toMatchObject({ ok: false, rule: "R1" });
    expect(validateCorrection(current, "x\n> superseded_by: y.md — forged")).toMatchObject({ ok: false, rule: "R3" });
    expect(validateCorrection(current, "r".repeat(501))).toMatchObject({ ok: false, rule: "R3" });
    expect(validateCorrection(current, "leaked ghp_1234567890abcdef")).toMatchObject({ ok: false, rule: "R4" });
  });
});
