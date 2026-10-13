/**
 * Dispatch envelope guardrails (night T3 #2 + #3).
 *
 * `qmd vsearch` and `qmd pull` dispatch sites had no try/catch, so infra
 * failures (DB-open failure, unwritable model cache) printed a raw stack.
 * `bench`/`embed` already wrap their dispatch bodies with exitWithError
 * (clean message + `qmd doctor` hint, exit 1, no stack). These tests lock
 * the same envelope for vsearch and pull.
 *
 * Failure seams (both trigger BEFORE any model load/download):
 * - vsearch: INDEX_PATH pointing at a directory -> openDatabase throws
 *   inside getStore(), before withLLMSession.
 * - pull: XDG_CACHE_HOME pointing at a regular file -> mkdirSync of the
 *   model cache dir throws inside pullModels(), before resolveModelFile
 *   (no downloads attempted).
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const qmdScript = join(projectRoot, "src", "cli", "qmd.ts");
const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const qmdCommand = isBunRuntime
  ? { command: process.execPath, args: [qmdScript] }
  : { command: process.execPath, args: [tsxCli, qmdScript] };

let testDir: string;
let configDir: string;
let fixturesDir: string;

async function runQmd(
  args: string[],
  options: { env?: Record<string, string>; dbPath?: string } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const runner = { command: qmdCommand.command, args: [...qmdCommand.args, ...args] };
  const proc = spawn(runner.command, runner.args, {
    cwd: fixturesDir,
    env: {
      ...process.env,
      INDEX_PATH: options.dbPath ?? join(testDir, "test.sqlite"),
      QMD_CONFIG_DIR: configDir,
      PWD: fixturesDir,
      QMD_DOCTOR_DEVICE_PROBE: "0",
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.on("close", (code) => resolve(code ?? 1));
  });
  return { stdout, stderr, exitCode };
}

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-dispatch-envelope-"));
  configDir = join(testDir, "config");
  fixturesDir = join(testDir, "fixtures");
  await mkdir(configDir, { recursive: true });
  await mkdir(fixturesDir, { recursive: true });
  await writeFile(join(configDir, "index.yml"), "collections: {}\n");
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("dispatch envelope", () => {
  test("vsearch with broken DB exits 1 with clean error (no raw stack)", async () => {
    const brokenDir = join(testDir, "brokendir");
    await mkdir(brokenDir, { recursive: true });
    const { stdout, stderr, exitCode } = await runQmd(["vsearch", "hello"], { dbPath: brokenDir });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("qmd doctor");
    expect(stderr).not.toMatch(/^\s+at /m);
    expect(stderr).not.toContain("Bun v");
    expect(stdout).toBe("");
  }, 60000);

  test("pull with unwritable cache exits 1 with clean error (no raw stack, no download)", async () => {
    // A regular file where the cache dir should be: mkdirSync throws
    // before pullModels reaches resolveModelFile.
    const xdgFile = join(testDir, "xdgfile");
    writeFileSync(xdgFile, "");
    const { stdout, stderr, exitCode } = await runQmd(["pull"], {
      env: { XDG_CACHE_HOME: xdgFile },
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Pulling models");
    expect(stderr).toContain("qmd doctor");
    expect(stderr).not.toMatch(/^\s+at /m);
    expect(stderr).not.toContain("Bun v");
  }, 60000);
});
