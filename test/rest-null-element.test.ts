/**
 * rest-null-element.test.ts — POST /query must reject null/non-object
 * elements in `searches` with a 400 JSON envelope instead of throwing
 * a TypeError (500) when mapping `s.type`.
 *
 * Regression test for fix/rest-null-element-night-20261013: without the
 * guard, `searches: [null]` crashed at `searches.map((s) => s.type)`.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startMcpHttpServer, type HttpServerHandle } from "../src/mcp/server.js";
import { _resetProductionModeForTesting } from "../src/store.js";

describe("POST /query null searches elements", () => {
  let handle: HttpServerHandle | undefined;
  let baseUrl: string;
  let root: string;
  let dbPath: string;
  const origIndexPath = process.env.INDEX_PATH;
  const origConfigDir = process.env.QMD_CONFIG_DIR;
  const origHealthInterval = process.env.QMD_HEALTH_LOG_INTERVAL_MS;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "qmd-rest-null-elem-"));
    dbPath = join(root, "index.sqlite");
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "index.yml"), "collections:\n  docs:\n    path: /test/docs\n    pattern: '**/*.md'\n");
    process.env.INDEX_PATH = dbPath;
    process.env.QMD_CONFIG_DIR = configDir;
    process.env.QMD_HEALTH_LOG_INTERVAL_MS = "0";
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
    if (origHealthInterval !== undefined) process.env.QMD_HEALTH_LOG_INTERVAL_MS = origHealthInterval;
    else delete process.env.QMD_HEALTH_LOG_INTERVAL_MS;
    try { unlinkSync(dbPath); } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  async function postSearches(body: unknown) {
    return fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("a null element is a 400 JSON error, not a 500 TypeError", async () => {
    const res = await postSearches({ searches: [null] });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "Invalid field: searches[0] (must be an object)" });
  });

  test("a string element is a 400 JSON error", async () => {
    const res = await postSearches({ searches: ["lex"] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid field: searches[0] (must be an object)" });
  });

  test("a valid searches array still passes validation", async () => {
    const res = await postSearches({ searches: [{ type: "lex", query: "hello" }], rerank: false });
    expect(res.status).toBe(200);
  });
});
