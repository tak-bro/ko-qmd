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

  const health = async () => (await (await fetch(`${baseUrl}/health`)).json()) as { listens: number; mcp_inflight: number };

  async function openListen() {
    const client = new AbortController();
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      signal: client.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "subscriptions/listen",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "subscriptions/listen",
        params: {
          notifications: { toolsListChanged: true },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "qmd-listen-test", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no SSE frame within 2s")), 2000)),
    ]);
    expect(new TextDecoder().decode(first.value)).toContain("notifications/subscriptions/acknowledged");
    return {
      close: async () => {
        client.abort();
        await reader.cancel().catch(() => {});
      },
    };
  }

  test("streams the subscriptions/listen acknowledgement while the stream stays open", async () => {
    const before = (await health()).listens;
    const listen = await openListen();
    expect((await health()).listens).toBe(before + 1);
    await listen.close();
  });

  // Bun 1.3's node:http server emits no event when a client hangs up on a POST whose body it
  // has read, so the bridge cannot see the disconnect there. The daemon runs on Node.
  test.skipIf(typeof process.versions.bun === "string")("releases subscriptions/listen when the client disconnects", async () => {
    const settled = async () => {
      const deadline = Date.now() + 2000;
      let h = await health();
      while ((h.listens !== 0 || h.mcp_inflight !== 0) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        h = await health();
      }
      return h;
    };
    await settled();
    const listen = await openListen();
    expect((await health()).listens).toBe(1);
    await listen.close();

    const after = await settled();
    expect(after.listens).toBe(0);
    expect(after.mcp_inflight).toBe(0);
  });
});
