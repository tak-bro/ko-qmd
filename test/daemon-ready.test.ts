/**
 * Unit tests for the `--daemon` listen-ready gate: the parent must not print
 * `Started` before the child is actually listening (occupied-port bind
 * failure exited 0 while the child died unseen).
 *
 * Children are real short-lived processes (no casts, no mocks): exit codes
 * and the `exit` event behave exactly as in production.
 */

import { describe, expect, test, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { waitForDaemonListening } from "../src/cli/qmd.ts";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempLog(initial = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "qmd-daemon-ready-"));
  tempDirs.push(dir);
  const logPath = join(dir, "mcp.log");
  writeFileSync(logPath, initial);
  return logPath;
}

/** A child that has already exited with `code` (waits for the exit event). */
async function exitedChild(code: number) {
  const child = spawn(process.execPath, ["-e", `process.exit(${code})`], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  return child;
}

describe("waitForDaemonListening", () => {
  test("resolves ok when the log already reports listening", async () => {
    const logPath = tempLog("QMD MCP server listening on http://localhost:9999/mcp\n");
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      await expect(waitForDaemonListening(child, logPath)).resolves.toEqual({ ok: true });
    } finally {
      child.kill("SIGTERM");
    }
  });

  test("reports the bind-failure line when the child has exited", async () => {
    const logPath = tempLog("Port 9999 already in use. Try a different port with --port.\n");
    const result = await waitForDaemonListening(await exitedChild(1), logPath);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("already in use");
  });

  test("reports a generic message when the child exits without a bind failure", async () => {
    const logPath = tempLog("some other fatal error\n");
    const result = await waitForDaemonListening(await exitedChild(1), logPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("exited before listening");
      expect(result.message).toContain(logPath);
    }
  });

  test("notices an exit that happens while waiting", async () => {
    const logPath = tempLog("booting...\n");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(1), 150)"], {
      stdio: "ignore",
    });
    const result = await waitForDaemonListening(child, logPath, 5000);
    expect(result.ok).toBe(false);
    expect(child.exitCode).toBe(1);
  });

  test("times out on a live-but-silent child, kills it, and points at the log", async () => {
    const logPath = tempLog("booting...\n");
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const result = await waitForDaemonListening(child, logPath, 300);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Timed out");
      expect(result.message).toContain(logPath);
    }
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    expect(child.signalCode).toBe("SIGTERM");
  });
});
