/**
 * Honest `qmd update` summary when trust-gated collections are skipped.
 *
 * A skipped collection is not an updated collection: the final line must not
 * claim "All collections updated", and the exit code must be nonzero so
 * unattended runs can detect the partial update.
 *
 * Spawns real `qmd update` processes against temp fixtures (never the real
 * user config — QMD_CONFIG_DIR points at a temp dir).
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

let projectDir: string;
let configDir: string;
let outsideDir: string;

function runQmd(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [...runnerArgs, ...args], {
      cwd: projectDir,
      env: {
        ...process.env,
        QMD_CONFIG_DIR: configDir,
        PWD: projectDir,
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

function writeLocalConfig(body: string): void {
  writeFileSync(join(projectDir, ".qmd", "index.yml"), body, "utf-8");
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "qmd-skip-sum-proj-"));
  configDir = mkdtempSync(join(tmpdir(), "qmd-skip-sum-cfg-"));
  outsideDir = mkdtempSync(join(tmpdir(), "qmd-skip-sum-out-"));
  mkdirSync(join(projectDir, ".qmd"), { recursive: true });
  mkdirSync(join(projectDir, "docs"), { recursive: true });
  writeFileSync(join(projectDir, "docs", "readme.md"), "# Readme\n\nSome indexable content.\n", "utf-8");
  writeFileSync(join(outsideDir, "secret.md"), "# Secret\n\nShould not be indexed unattended.\n", "utf-8");
});

afterEach(() => {
  for (const dir of [projectDir, configDir, outsideDir]) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("qmd update with a skipped collection", () => {
  test("partial skip reports an honest summary and exits nonzero", async () => {
    writeLocalConfig([
      "collections:",
      "  docs:",
      "    path: ./docs",
      '    pattern: "**/*.md"',
      "  secrets:",
      `    path: ${JSON.stringify(outsideDir)}`,
      '    pattern: "**/*.md"',
      "",
    ].join("\n"));

    const result = await runQmd(["update"]);

    expect(result.stdout).toContain("Indexed: 1 new");
    expect(result.stdout).toContain("Skipping collection 'secrets'");
    expect(result.stdout).toContain("Updated 1 of 2 collection(s), skipped 1");
    expect(result.stdout).not.toContain("All collections updated");
    expect(result.exitCode).toBe(1);
  }, 120_000);

  test("no skips keeps the success line and exits zero", async () => {
    writeLocalConfig([
      "collections:",
      "  docs:",
      "    path: ./docs",
      '    pattern: "**/*.md"',
      "",
    ].join("\n"));

    const result = await runQmd(["update"]);

    expect(result.stdout).toContain("Indexed: 1 new");
    expect(result.stdout).toContain("✓ All collections updated.");
    expect(result.exitCode).toBe(0);
  }, 120_000);
});
