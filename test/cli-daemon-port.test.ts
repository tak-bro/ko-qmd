/**
 * Regression tests for `qmd mcp --http --port` parsing (#6, logic round-2).
 *
 * Was: `Number(...) || 8181` — `--port 0` / non-numeric silently became 8181
 * (surprise EADDRINUSE vs the default daemon), `--port -1` passed through to a
 * downstream `ERR_SOCKET_BAD_PORT` crash. Now: non-numeric or out-of-range
 * ports throw; only 1..65535 (or the default when the flag is absent) pass.
 * Parse-level asserts only — no daemons or listeners started here.
 */

import { describe, test, expect } from "vitest";
import { resolveMcpPort, DEFAULT_MCP_PORT } from "../src/cli/qmd.ts";

describe("resolveMcpPort", () => {
  test("absent flag falls back to the default port", () => {
    expect(resolveMcpPort(undefined)).toBe(8181);
    expect(DEFAULT_MCP_PORT).toBe(8181);
  });

  test("accepts valid ports across 1..65535", () => {
    expect(resolveMcpPort("8080")).toBe(8080);
    expect(resolveMcpPort("1")).toBe(1);
    expect(resolveMcpPort("65535")).toBe(65535);
    expect(resolveMcpPort(8181)).toBe(8181);
  });

  test("rejects 0 (no silent fallback to the default daemon port)", () => {
    expect(() => resolveMcpPort("0")).toThrow(/Invalid --port/);
    expect(() => resolveMcpPort(0)).toThrow(/Invalid --port/);
  });

  test("rejects non-numeric input (was silently 8181)", () => {
    expect(() => resolveMcpPort("abc")).toThrow(/Invalid --port/);
    expect(() => resolveMcpPort("")).toThrow(/Invalid --port/);
    expect(() => resolveMcpPort("80eighty")).toThrow(/Invalid --port/);
  });

  test("rejects negatives and out-of-range ports (was a downstream crash)", () => {
    expect(() => resolveMcpPort("-1")).toThrow(/Invalid --port/);
    expect(() => resolveMcpPort("65536")).toThrow(/Invalid --port/);
    expect(() => resolveMcpPort("99999")).toThrow(/Invalid --port/);
    expect(() => resolveMcpPort("8181.5")).toThrow(/Invalid --port/);
  });
});
