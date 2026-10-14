/**
 * rest-search-validation.test.ts - REST /query validates `searches` like the
 * MCP tool schema does (non-empty, known type, non-empty query, max 10).
 * Lex-only with rerank disabled so no models are needed.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
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
import { startMcpHttpServer, type HttpServerHandle } from "../src/mcp/server.js";
import type { CollectionConfig } from "../src/collections.js";

describe("REST /query searches validation", () => {
  let handle: HttpServerHandle;
  let baseUrl: string;
  let dbPath: string;
  let configDir: string;
  let testDir: string;
  const origIndexPath = process.env.INDEX_PATH;
  const origConfigDir = process.env.QMD_CONFIG_DIR;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "qmd-rest-search-validation-"));
    dbPath = join(testDir, "rest.sqlite");
    const internal = createInternalStore(dbPath);
    const now = new Date().toISOString();
    const body = "# Doc\n\nvalidation keyword body";
    const hash = await hashContent(body);
    insertContent(internal.db, hash, body, now);
    insertDocument(internal.db, "docs", "doc.md", "doc.md", hash, now, now);

    const testConfig: CollectionConfig = {
      collections: { docs: { path: "/test/docs", pattern: "**/*.md" } },
    };
    syncConfigToDb(internal.db, testConfig);
    internal.close();

    configDir = await mkdtemp(join(tmpdir(), "qmd-rest-search-validation-config-"));
    await writeFile(join(configDir, "index.yml"), YAML.stringify(testConfig));

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
    try { unlinkSync(dbPath); } catch {}
    await rm(configDir, { recursive: true, force: true });
    await rm(testDir, { recursive: true, force: true });
  });

  async function postQuery(body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  test("rejects an empty searches array with 400", async () => {
    const { status, json } = await postQuery({ searches: [] });
    expect(status).toBe(400);
    expect(json.error).toMatch(/searches/i);
  });

  test("rejects an unknown search type with 400", async () => {
    const { status, json } = await postQuery({
      searches: [{ type: "fuzzy", query: "validation keyword" }],
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/type/i);
  });

  test("rejects a missing search type with 400", async () => {
    const { status, json } = await postQuery({
      searches: [{ query: "validation keyword" }],
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/type/i);
  });

  test("rejects a missing query with 400", async () => {
    const { status, json } = await postQuery({
      searches: [{ type: "lex" }],
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/query/i);
  });

  test("rejects an empty query with 400", async () => {
    const { status, json } = await postQuery({
      searches: [{ type: "lex", query: "   " }],
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/query/i);
  });

  test("rejects more than 10 searches with 400", async () => {
    const { status, json } = await postQuery({
      searches: Array.from({ length: 11 }, () => ({ type: "lex", query: "validation keyword" })),
      rerank: false,
    });
    expect(status).toBe(400);
    expect(json.error).toMatch(/10|too many|max/i);
  });

  test("accepts a valid single search with 200", async () => {
    const { status, json } = await postQuery({
      searches: [{ type: "lex", query: "validation keyword" }],
      rerank: false,
    });
    expect(status).toBe(200);
    expect(json.results.length).toBe(1);
  });
});
