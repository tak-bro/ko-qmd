/**
 * Non-interactive `qmd trust` subcommand branches of manageTrust (#900).
 *
 * Pins the four branches that only `trust list` covered before:
 * unknown subcommand usage + exit 1, global-config never gated,
 * no gated items, and revoke-when-unapproved.
 *
 * All cases run with piped stdio (never a TTY), so the interactive
 * confirm path is intentionally not exercised here.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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

let workDir: string;
let configDir: string;
const extraDirs: string[] = [];

function runQmd(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [...runnerArgs, ...args], {
      cwd,
      env: {
        ...process.env,
        QMD_CONFIG_DIR: configDir,
        PWD: cwd,
        QMD_DOCTOR_DEVICE_PROBE: "0",
        ...env,
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

function makeProject(withConfig: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "qmd-trust-branches-"));
  extraDirs.push(dir);
  if (withConfig !== null) {
    mkdirSync(join(dir, ".qmd"), { recursive: true });
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "readme.md"), "# Readme\n\nSome indexable content.\n", "utf-8");
    writeFileSync(join(dir, ".qmd", "index.yml"), withConfig, "utf-8");
  }
  return dir;
}

const benignConfig = [
  "collections:",
  "  docs:",
  "    path: ./docs",
  '    pattern: "**/*.md"',
  "",
].join("\n");

const hookConfig = [
  "collections:",
  "  docs:",
  "    path: ./docs",
  '    pattern: "**/*.md"',
  '    update: "echo ran > hook-ran.txt"',
  "",
].join("\n");

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "qmd-trust-nolocal-"));
  configDir = mkdtempSync(join(tmpdir(), "qmd-trust-branches-cfg-"));
});

afterEach(() => {
  for (const dir of [workDir, configDir, ...extraDirs]) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  extraDirs.length = 0;
});

describe("qmd trust subcommand branches", () => {
  test("unknown subcommand prints usage and exits 1", async () => {
    const result = await runQmd(["trust", "bogus"], workDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage: qmd trust [list|revoke]");
  }, 120_000);

  test("bare `qmd trust` outside a project reports the global config is never gated", async () => {
    const result = await runQmd(["trust"], workDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("never gated");
    expect(result.stdout).toContain("Nothing to trust");
  }, 120_000);

  test("`qmd trust revoke` outside a project reports no project-local config in scope", async () => {
    const result = await runQmd(["trust", "revoke"], workDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No project-local .qmd config in scope");
    expect(result.stdout).toContain("never gated");
  }, 120_000);

  test("bare `qmd trust` with no gated items reports nothing to trust", async () => {
    const project = makeProject(benignConfig);
    const result = await runQmd(["trust"], project);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("defines no update commands");
    expect(result.stdout).toContain("Nothing to trust");
  }, 120_000);

  test("`qmd trust revoke` without a prior approval reports it was not trusted", async () => {
    const project = makeProject(hookConfig);
    const result = await runQmd(["trust", "revoke"], project);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("was not trusted");
  }, 120_000);
});
