import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";
import { startMcpHttpServer, type HttpServerHandle } from "../src/mcp/server.js";
import { _resetProductionModeForTesting } from "../src/store.js";

describe("GET /health in-memory counters", () => {
  let handle: HttpServerHandle | undefined;
  let baseUrl: string;
  let root: string;
  let dbPath: string;
  const origIndexPath = process.env.INDEX_PATH;
  const origConfigDir = process.env.QMD_CONFIG_DIR;
  const origHealthInterval = process.env.QMD_HEALTH_LOG_INTERVAL_MS;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "qmd-health-counters-"));
    dbPath = join(root, "index.sqlite");
    writeFileSync(join(root, "index.yml"), "collections:\n  docs:\n    path: /test/docs\n    pattern: '**/*.md'\n");
    process.env.INDEX_PATH = dbPath;
    process.env.QMD_CONFIG_DIR = root;
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

  test("keeps legacy {status,uptime} shape byte-identical", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
    expect(Number.isInteger(body.uptime)).toBe(true);
  });

  test("exposes in-memory counters as additional keys", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.listens).toBe("number");
    expect(typeof body.mcp_inflight).toBe("number");
    expect(body.listens).toBe(0);
    expect(body.mcp_inflight).toBe(0);
  });
});
