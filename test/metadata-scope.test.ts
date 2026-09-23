/**
 * metadata-scope.test.ts — ko-qmd: upstream's metadata `filter` next to ko-qmd's
 * `path` / `since` / `until` scope on the REST and MCP query surfaces.
 *
 * Both narrow the corpus; a result has to pass both. Kept out of upstream's
 * metadata-surfaces.test.ts so an upstream sync does not conflict on it.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import {
  createStore as createInternalStore,
  insertContent,
  insertDocument,
  hashContent,
  syncConfigToDb,
  _resetProductionModeForTesting,
} from "../src/store.js";
import { replaceDocumentMetadata } from "../src/metadata-store.js";
import { METADATA_EXTRACTION_VERSION, type DocumentMetadata } from "../src/metadata.js";
import { startMcpHttpServer, type HttpServerHandle } from "../src/mcp/server.js";
import type { CollectionConfig } from "../src/collections.js";
import type { Database } from "../src/db.js";

type QueryResult = { file: string; fts_score?: number; metadata?: DocumentMetadata };

describe("metadata filter and path scope together", () => {
  let handle: HttpServerHandle;
  let baseUrl: string;
  let testDir: string;
  const origIndexPath = process.env.INDEX_PATH;
  const origConfigDir = process.env.QMD_CONFIG_DIR;

  const seedDoc = async (db: Database, path: string, metadata: DocumentMetadata): Promise<void> => {
    const now = new Date().toISOString();
    const body = `# ${path}\n\nzanzibar keyword body`;
    const hash = await hashContent(body);
    insertContent(db, hash, body, now);
    const documentId = insertDocument(db, "docs", path, path, hash, now, now);
    replaceDocumentMetadata(db, documentId, { metadata, extractionVersion: METADATA_EXTRACTION_VERSION });
  };

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "qmd-metadata-scope-"));
    const dbPath = join(testDir, "index.sqlite");
    const internal = createInternalStore(dbPath);
    // Metadata alone keeps two documents, the path alone keeps two; only notes/published.md is in both.
    await seedDoc(internal.db, "published.md", { status: "published" });
    await seedDoc(internal.db, "notes/published.md", { status: "published" });
    await seedDoc(internal.db, "notes/draft.md", { status: "draft" });
    const config: CollectionConfig = { collections: { docs: { path: "/test/docs", pattern: "**/*.md" } } };
    syncConfigToDb(internal.db, config);
    internal.close();

    const configDir = join(testDir, "config");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "index.yml"), YAML.stringify(config));
    process.env.INDEX_PATH = dbPath;
    process.env.QMD_CONFIG_DIR = configDir;
    handle = await startMcpHttpServer(0, { quiet: true, dbPath });
    baseUrl = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    if (handle) await handle.stop();
    _resetProductionModeForTesting();
    if (origIndexPath !== undefined) process.env.INDEX_PATH = origIndexPath;
    else delete process.env.INDEX_PATH;
    if (origConfigDir !== undefined) process.env.QMD_CONFIG_DIR = origConfigDir;
    else delete process.env.QMD_CONFIG_DIR;
    await rm(testDir, { recursive: true, force: true });
  });

  const published = { key: "status", operator: "eq", value: "published" };
  const searches = [{ type: "lex", query: "zanzibar" }];

  const restFiles = async (extra: Record<string, unknown>) => {
    const res = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ searches, rerank: false, ...extra }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { results: QueryResult[] }).results;
  };

  const mcpFiles = async (extra: Record<string, unknown>) => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "query",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "query",
          arguments: { searches, rerank: false, ...extra },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "metadata-scope-test", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { result: { structuredContent: { results: QueryResult[] } } }).result.structuredContent.results;
  };

  const files = (results: QueryResult[]) => results.map(r => r.file.replace(/^qmd:\/\//, "")).sort();

  test("REST /query: each narrowing alone, then only the intersection", async () => {
    expect(files(await restFiles({ filter: published }))).toEqual(["docs/notes/published.md", "docs/published.md"]);
    expect(files(await restFiles({ path: ["docs/notes/**"] }))).toEqual(["docs/notes/draft.md", "docs/notes/published.md"]);
    const both = await restFiles({ filter: published, path: ["docs/notes/**"] });
    expect(files(both)).toEqual(["docs/notes/published.md"]);
    // The rerank:false raw score and the indexed metadata both survive the combined path. (Every
    // seeded body holds the term, so BM25 itself is ~0 here — presence is what is asserted.)
    expect(both[0]!.fts_score).toBeTypeOf("number");
    expect(both[0]!.metadata).toEqual({ status: "published" });
  });

  test("MCP query: the same intersection", async () => {
    const both = await mcpFiles({ filter: published, path: ["docs/notes/**"] });
    expect(files(both)).toEqual(["docs/notes/published.md"]);
    expect(both[0]!.fts_score).toBeTypeOf("number");
  });
});
