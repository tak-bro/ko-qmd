/**
 * `qmd trust list` shows what was approved (digest short), not just where/when.
 *
 * The trust store records the approved digest per config path, but `trust list`
 * printed only path + timestamp, so an approval could not be audited.
 * Temp fixtures only.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const qmdScript = join(projectRoot, "src", "cli", "qmd.ts");
const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const runnerArgs = isBunRuntime ? [qmdScript] : [tsxCli, qmdScript];

let projectDir: string;
let configDir: string;

function runQmd(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [...runnerArgs, ...args], {
      cwd: projectDir,
      env: {
        ...process.env,
        QMD_CONFIG_DIR: configDir,
        PWD: projectDir,
        QMD_DOCTOR_DEVICE_PROBE: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "qmd-trust-list-proj-"));
  configDir = mkdtempSync(join(tmpdir(), "qmd-trust-list-cfg-"));
  mkdirSync(join(projectDir, ".qmd"), { recursive: true });
  mkdirSync(join(projectDir, "docs"), { recursive: true });
  writeFileSync(join(projectDir, "docs", "readme.md"), "# Readme\n\nSome indexable content.\n", "utf-8");
  writeFileSync(
    join(projectDir, ".qmd", "index.yml"),
    [
      "collections:",
      "  docs:",
      "    path: ./docs",
      '    pattern: "**/*.md"',
      '    update: "echo hi"',
      "",
    ].join("\n"),
    "utf-8",
  );
});

afterEach(() => {
  for (const dir of [projectDir, configDir]) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("qmd trust list", () => {
  test("shows the approved digest short alongside path and timestamp", async () => {
    const trust = await runQmd(["trust"]);
    expect(trust.stdout).toContain("Trusted");

    const store = JSON.parse(readFileSync(join(configDir, "trusted.json"), "utf-8")) as Record<
      string,
      { hooks: string; trustedAt: string }
    >;
    const keys = Object.keys(store);
    expect(keys).toHaveLength(1);
    const digest = store[keys[0]!]!.hooks;
    expect(typeof digest).toBe("string");
    expect(digest).toHaveLength(64);

    const list = await runQmd(["trust", "list"]);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain(join(projectDir, ".qmd", "index.yml"));
    expect(list.stdout).toContain(digest.slice(0, 12));
  }, 120_000);
});
