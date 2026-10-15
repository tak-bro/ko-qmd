/**
 * memory-convention.test.ts — provenance envelope convention proof.
 *
 * No src change in this slice: human claims live in the body, machine fields
 * in frontmatter `qmd.metadata` (KB top-level kind/domain/status untouched),
 * and recall narrows via the existing metadata `filter`. These tests pin that
 * contract so slice 03+ can rely on it.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/db.js";
import type { Database } from "../src/db.js";
import {
  extractDocumentMetadata,
  METADATA_EXTRACTION_VERSION,
  type DocumentMetadata,
} from "../src/metadata.js";
import {
  parseMetadataFilter,
  compileMetadataFilter,
  type MetadataFilter,
} from "../src/metadata-filter.js";
import { initializeMetadataSchema, replaceDocumentMetadata } from "../src/metadata-store.js";

const KB_STYLE = `---
kind: doc
type: decision
domain: [knowledge-base]
status: adopted
links: ["[[plan-knowledge-base]]"]
summary: "example"
qmd:
  metadata:
    actor: agent
    project: knowledge-base
---

## Body claim here.
`;

describe("provenance envelope extraction", () => {
  test("qmd.metadata actor/project extracted, top-level KB keys ignored", () => {
    const result = extractDocumentMetadata(KB_STYLE, "docs/example.md");
    expect(result.error).toBeUndefined();
    expect(result.metadata).toMatchObject({ actor: "agent", project: "knowledge-base" });
    expect(result.metadata).not.toHaveProperty("kind");
    expect(result.metadata).not.toHaveProperty("status");
  });

  test("doc without qmd block yields empty metadata, not an error", () => {
    const result = extractDocumentMetadata("# Just a note\n\nBody.\n", "docs/plain.md");
    expect(result.error).toBeUndefined();
    expect(result.metadata).toEqual({});
  });
});

describe("actor/project recall narrowing", () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    db.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      )
    `);
    initializeMetadataSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function insertDoc(path: string, metadata: DocumentMetadata): number {
    const result = db.prepare(`INSERT INTO documents (path) VALUES (?)`).run(path);
    const documentId = Number(result.lastInsertRowid);
    replaceDocumentMetadata(db, documentId, { metadata, extractionVersion: METADATA_EXTRACTION_VERSION });
    return documentId;
  }

  function matchPaths(filter: MetadataFilter): string[] {
    const compiled = compileMetadataFilter(parseMetadataFilter(filter), "d");
    const rows = db.prepare(`
      SELECT d.path FROM documents d
      JOIN document_metadata dm ON dm.document_id = d.id
        AND dm.extraction_version = ${METADATA_EXTRACTION_VERSION}
        AND dm.extraction_error IS NULL
      WHERE d.active = 1 AND ${compiled.sql}
      ORDER BY d.path
    `).all(...compiled.params) as { path: string }[];
    return rows.map(row => row.path);
  }

  test("actor eq narrows to that actor's docs only", () => {
    insertDoc("by-user.md", { actor: "user", project: "knowledge-base" });
    insertDoc("by-agent.md", { actor: "agent", project: "knowledge-base" });
    insertDoc("no-actor.md", { project: "knowledge-base" });

    expect(matchPaths({ key: "actor", operator: "eq", value: "user" })).toEqual(["by-user.md"]);
  });

  test("actor + project combine with and", () => {
    insertDoc("a.md", { actor: "agent", project: "knowledge-base" });
    insertDoc("b.md", { actor: "agent", project: "other" });
    insertDoc("c.md", { actor: "user", project: "knowledge-base" });

    expect(
      matchPaths({
        operator: "and",
        operands: [
          { key: "actor", operator: "eq", value: "agent" },
          { key: "project", operator: "eq", value: "knowledge-base" },
        ],
      }),
    ).toEqual(["a.md"]);
  });
});
