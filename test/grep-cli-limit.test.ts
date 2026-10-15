/**
 * grep-cli-limit.test.ts — CLI `qmd grep` default file cap.
 *
 * `qmd grep` documents `-n <num>` as "Max files (default 20)" and the MCP
 * grep tool defaults to 20, so the default-format cap must be 20 — not the
 * search default (5 for cli output) inherited through the shared output
 * options. Seven fixture files carry the marker: more than search's 5,
 * fewer than grep's 20.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const projectRoot = join(__dirname, "..");
const qmdScript = join(projectRoot, "src", "cli", "qmd.ts");
const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const qmdCommand = isBunRuntime
  ? { command: process.execPath, args: [qmdScript] }
  : { command: process.execPath, args: [tsxCli, qmdScript] };

let testDir: string;
let dbPath: string;
let configDir: string;
let fixturesDir: string;

function runQmd(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const runner = { command: qmdCommand.command, args: [...qmdCommand.args, ...args] };
  const proc = spawn(runner.command, runner.args, {
    cwd: fixturesDir,
    env: {
      ...process.env,
      INDEX_PATH: dbPath,
      QMD_CONFIG_DIR: configDir,
      PWD: fixturesDir,
      QMD_DOCTOR_DEVICE_PROBE: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutPromise = new Promise<string>((resolve, reject) => {
    let data = "";
    proc.stdout?.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    proc.once("error", reject);
    proc.stdout?.once("end", () => resolve(data));
  });
  const stderrPromise = new Promise<string>((resolve, reject) => {
    let data = "";
    proc.stderr?.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    proc.once("error", reject);
    proc.stderr?.once("end", () => resolve(data));
  });
  const exitPromise = new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.on("close", (code) => resolve(code ?? 1));
  });
  return Promise.all([stdoutPromise, stderrPromise, exitPromise]).then(
    ([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode })
  );
}

const countFiles = (stdout: string) =>
  stdout.split("\n").filter((line) => line.includes("qmd://grep-limit/")).length;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-grep-limit-"));
  dbPath = join(testDir, "test.sqlite");
  configDir = join(testDir, "config");
  fixturesDir = join(testDir, "fixtures");
  const docsDir = join(fixturesDir, "docs");
  await mkdir(configDir, { recursive: true });
  await mkdir(docsDir, { recursive: true });
  await writeFile(join(configDir, "index.yml"), "collections: {}\n");
  for (let i = 1; i <= 7; i++) {
    await writeFile(join(docsDir, `d${i}.md`), `# Doc ${i}\n\nLIMIT_MARKER alpha ${i}\n`);
  }
  const added = await runQmd(["collection", "add", docsDir, "--name", "grep-limit"]);
  expect(added.exitCode).toBe(0);
}, 120_000);

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("qmd grep default file cap", () => {
  test("default format returns all 7 matches (default 20, not search's 5)", async () => {
    const { stdout, exitCode } = await runQmd(["grep", "LIMIT_MARKER"]);
    expect(exitCode).toBe(0);
    expect(countFiles(stdout)).toBe(7);
  });

  test("default format shows no truncation footer when nothing is cut", async () => {
    const { stdout } = await runQmd(["grep", "LIMIT_MARKER"]);
    expect(stdout).not.toContain("Stopped at");
  });

  test("an explicit -n still caps and reports the footer", async () => {
    const { stdout, exitCode } = await runQmd(["grep", "LIMIT_MARKER", "-n", "3"]);
    expect(exitCode).toBe(0);
    expect(countFiles(stdout)).toBe(3);
    expect(stdout).toContain("Stopped at 3 files");
  });

  test("--format json agrees with the default format count", async () => {
    const { stdout, exitCode } = await runQmd(["grep", "LIMIT_MARKER", "--format", "json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as { files: unknown[]; truncated: boolean };
    expect(parsed.files).toHaveLength(7);
    expect(parsed.truncated).toBe(false);
  });
});
