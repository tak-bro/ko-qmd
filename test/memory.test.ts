/**
 * memory.test.ts — memory_store/recall/correct core rules.
 *
 * Slice 03 Review Focus rows, one row = one failing condition:
 * supersedes chain · path hardening · vectors_stale flag · secrets.
 * Pure functions only; MCP wiring is covered by registration + tsc.
 */

import { describe, test, expect } from "vitest";
import {
  MEMORY_COLLECTION,
  MEMORY_MAX_CHARS,
  validateMemoryStoreInput,
  buildMemoryFilename,
  renderMemoryDoc,
  resolveInCollection,
  isMemDoc,
  buildStoreReceipt,
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

  test("R3 rejects oversize text and path-smuggling actor", () => {
    expect(validateMemoryStoreInput({ ...BASE, text: "x".repeat(MEMORY_MAX_CHARS + 1) }).ok).toBe(false);
    expect(validateMemoryStoreInput({ ...BASE, actor: "../evil" }).ok).toBe(false);
    expect(validateMemoryStoreInput({ ...BASE, actor: "a/b" }).ok).toBe(false);
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
    expect(name).toMatch(/^20261014-210000-[0-9a-f]{8}\.md$/);
    expect(name).not.toContain("/");
    expect(name).not.toContain("\n");
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

  test("accepts a flat filename inside the dir", () => {
    expect(resolveInCollection(memDir, "20261014-210000-abcdef12.md")).toBe(
      `${memDir}/20261014-210000-abcdef12.md`,
    );
  });

  test("isMemDoc only matches the mem collection", () => {
    expect(isMemDoc(`${MEMORY_COLLECTION}/a.md`)).toBe(true);
    expect(isMemDoc("kb/a.md")).toBe(false);
  });

  test("store receipt always flags vectors_stale", () => {
    expect(buildStoreReceipt("20261014-210000-abcdef12.md")).toMatchObject({
      ok: true,
      file: "mem/20261014-210000-abcdef12.md",
      vectors_stale: true,
    });
    expect(
      buildStoreReceipt("new.md", "20261014-210000-abcdef12.md").supersedes,
    ).toBe("mem/20261014-210000-abcdef12.md");
  });
});
