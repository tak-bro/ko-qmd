/**
 * score-precision.test.ts - Display precision vs min-score filter consistency
 *
 * The min-score filter compares RAW scores (outputResults filter), while each
 * output format rounds for display. Rounding to 2 decimals made epsilon rows
 * render as "0.00"/0/"0%" yet vanish at --min-score 0.001, which is
 * inexplicable from the displayed output. Display formats must therefore
 * render enough digits (4 decimals / 2-decimal percent) that a displayed row
 * never contradicts the filter outcome. Filter behavior itself is UNCHANGED.
 *
 * Run with: npx vitest run test/score-precision.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { formatScore } from "../src/cli/qmd.ts";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const qmdScript = join(projectRoot, "src", "cli", "qmd.ts");
const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const qmdCommand = isBunRuntime
  ? { command: process.execPath, args: [qmdScript] }
  : { command: process.execPath, args: [tsxCli, qmdScript] };

async function runQmd(
  args: string[],
  options: { cwd?: string; dbPath?: string; configDir?: string } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn(qmdCommand.command, [...qmdCommand.args, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      INDEX_PATH: options.dbPath ?? "",
      QMD_CONFIG_DIR: options.configDir ?? "",
      QMD_DOCTOR_DEVICE_PROBE: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
  proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.on("close", (code) => resolve(code ?? 1));
  });
  return { stdout, stderr, exitCode };
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07]*\x07/g, "");

// =============================================================================
// Unit: cli percent rendering keeps epsilon scores distinguishable
// =============================================================================
describe("formatScore display precision", () => {
  test("epsilon scores do not render as 0%", () => {
    // Old rendering: (0.0004*100).toFixed(0) === "  0" -> "0.00 rows dropped
    // at 0.001" was inexplicable. New rendering keeps 2 percent decimals.
    expect(stripAnsi(formatScore(0.0004))).toBe("  0.04%");
    expect(stripAnsi(formatScore(0.0009))).toBe("  0.09%");
  });

  test("displayed percent stays on the same side of the threshold as the raw score", () => {
    // Threshold 0.001 == 0.10%: raw 0.0004 displays 0.04% (below, dropped).
    const shown = parseFloat(stripAnsi(formatScore(0.0004)).replace("%", "").trim());
    expect(shown).toBeLessThan(0.1);
    // Raw 0.5 displays 50.00% (above, kept).
    const kept = parseFloat(stripAnsi(formatScore(0.5)).replace("%", "").trim());
    expect(kept).toBeGreaterThanOrEqual(0.1);
  });

  test("ordinary scores render with 2 percent decimals", () => {
    expect(stripAnsi(formatScore(0.845))).toBe(" 84.50%");
    expect(stripAnsi(formatScore(0))).toBe("  0.00%");
    expect(stripAnsi(formatScore(1))).toBe("100.00%");
  });
});

// =============================================================================
// Integration: files/json/cli render new precision; filter behavior unchanged
// =============================================================================
describe("search score display precision (integration)", () => {
  let testDir: string;
  let dbPath: string;
  let configDir: string;
  let fixturesDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "qmd-score-prec-"));
    dbPath = join(testDir, "test.sqlite");
    configDir = join(testDir, "config");
    fixturesDir = join(testDir, "fixtures");
    await mkdir(configDir, { recursive: true });
    await mkdir(fixturesDir, { recursive: true });
    await writeFile(join(configDir, "index.yml"), "collections: {}\n");
    await writeFile(join(fixturesDir, "alpha.md"), "# alpha\n\nquantum tunneling qubit superposition test\n");
    await writeFile(join(fixturesDir, "beta.md"), "# beta\n\nclassical thermodynamics engine test\n");
    const add = await runQmd(["collection", "add", fixturesDir, "--name", "prec"], {
      dbPath, configDir, cwd: fixturesDir,
    });
    expect(add.exitCode).toBe(0);
  }, 120000);

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("--files scores render with 4 decimals", async () => {
    const { stdout, exitCode } = await runQmd(["search", "quantum", "--files", "-n", "5"], {
      dbPath, configDir, cwd: fixturesDir,
    });
    expect(exitCode).toBe(0);
    const rows = stdout.trim().split("\n").filter((l) => l.startsWith("#"));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toMatch(/^#[a-f0-9]{6},\d+\.\d{4},qmd:\/\//);
    }
  });

  test("--json scores are rounded to 4 decimals, not 2", async () => {
    const { stdout, exitCode } = await runQmd(["search", "quantum", "--json", "-n", "5"], {
      dbPath, configDir, cwd: fixturesDir,
    });
    expect(exitCode).toBe(0);
    const results = JSON.parse(stdout);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(typeof r.score).toBe("number");
      expect(Math.abs(r.score * 10000 - Math.round(r.score * 10000))).toBeLessThan(1e-6);
    }
  });

  test("default cli Score line shows 2-decimal percent", async () => {
    const { stdout, exitCode } = await runQmd(["search", "quantum", "-n", "1"], {
      dbPath, configDir, cwd: fixturesDir,
    });
    expect(exitCode).toBe(0);
    expect(stripAnsi(stdout)).toMatch(/Score: *\d+\.\d{2}%/);
  });

  test("min-score filter behavior unchanged: raw compare keeps and drops", async () => {
    // min-score 0 keeps everything (raw >= 0); min-score 2 drops everything.
    const kept = await runQmd(["search", "quantum", "--files", "--min-score", "0"], {
      dbPath, configDir, cwd: fixturesDir,
    });
    expect(kept.exitCode).toBe(0);
    expect(kept.stdout.trim().split("\n").filter((l) => l.startsWith("#")).length).toBeGreaterThan(0);

    const dropped = await runQmd(["search", "quantum", "--files", "--min-score", "2"], {
      dbPath, configDir, cwd: fixturesDir,
    });
    expect(dropped.exitCode).toBe(0);
    expect(dropped.stdout.trim()).toBe("");

    const droppedJson = await runQmd(["search", "quantum", "--json", "--min-score", "2"], {
      dbPath, configDir, cwd: fixturesDir,
    });
    expect(droppedJson.exitCode).toBe(0);
    expect(JSON.parse(droppedJson.stdout)).toEqual([]);
  });
});
