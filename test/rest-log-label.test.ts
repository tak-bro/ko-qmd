/**
 * rest-log-label.test.ts - REST stderr log labels carry the request pathname.
 * POST /search must log as "POST /search", POST /query as "POST /query".
 */

import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
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

describe("REST log labels", () => {
  let testDir: string;
  let handle: HttpServerHandle;
  let baseUrl: string;
  let dbPath: string;
  let configDir: string;
  const origIndexPath = process.env.INDEX_PATH;
  const origConfigDir = process.env.QMD_CONFIG_DIR;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "qmd-rest-log-label-"));
    dbPath = join(testDir, "log-label.sqlite");
    const internal = createInternalStore(dbPath);
    const body = "# Hello\n\nlog label keyword body";
    const now = new Date().toISOString();
    const hash = await hashContent(body);
    insertContent(internal.db, hash, body, now);
    insertDocument(internal.db, "docs", "hello.md", "hello.md", hash, now, now);
    const testConfig: CollectionConfig = {
      collections: { docs: { path: "/test/docs", pattern: "**/*.md" } },
    };
    syncConfigToDb(internal.db, testConfig);
    internal.close();

    configDir = await mkdtemp(join(tmpdir(), "qmd-rest-log-label-config-"));
    await writeFile(join(configDir, "index.yml"), YAML.stringify(testConfig));

    process.env.INDEX_PATH = dbPath;
    process.env.QMD_CONFIG_DIR = configDir;
    // quiet:false so the stderr request log is emitted
    handle = await startMcpHttpServer(0, { quiet: false, dbPath });
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
    await rm(testDir, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  });

  async function postPath(path: string): Promise<string[]> {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ searches: [{ type: "lex", query: "log label keyword" }], rerank: false }),
      });
      expect(res.status).toBe(200);
      return lines;
    } finally {
      spy.mockRestore();
    }
  }

  test("POST /search logs POST /search and POST /query logs POST /query", async () => {
    const searchLines = await postPath("/search");
    expect(searchLines.some((l) => l.includes("POST /search 1 queries"))).toBe(true);
    expect(searchLines.some((l) => l.includes("POST /query"))).toBe(false);

    const queryLines = await postPath("/query");
    expect(queryLines.some((l) => l.includes("POST /query 1 queries"))).toBe(true);
    expect(queryLines.some((l) => l.includes("POST /search"))).toBe(false);
  });
});
