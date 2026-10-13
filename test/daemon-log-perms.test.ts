/**
 * Daemon mcp.log permissions (src/cli/qmd.ts daemon spawn path).
 *
 * The daemon log carries query text, so creation must mirror the 0600
 * convention of the opt-in query log — not the 0644 default that
 * openSync(path, "w") produced with no mode argument.
 */

import { describe, test, expect, afterEach } from "vitest";
import { chmodSync, closeSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDaemonLogFile } from "../src/cli/mcp-pid.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const freshDir = () => {
  const d = mkdtempSync(join(tmpdir(), "qmd-daemon-log-"));
  dirs.push(d);
  return d;
};

describe("openDaemonLogFile", () => {
  test("creates the log 0600", () => {
    const logPath = join(freshDir(), "mcp.log");
    const fd = openDaemonLogFile(logPath);
    closeSync(fd);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
  });

  test("truncates a pre-existing group-readable log back to 0600", () => {
    const logPath = join(freshDir(), "mcp.log");
    writeFileSync(logPath, "stale query text\n");
    chmodSync(logPath, 0o644); // the pre-fix default honoring umask 022
    const fd = openDaemonLogFile(logPath);
    closeSync(fd);
    expect(readFileSync(logPath, "utf-8")).toBe("");
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
  });
});
