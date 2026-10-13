/**
 * Regression tests: `qmd query` structured-search validation errors must
 * surface as clean one-line messages with exit code 1 (same shape as
 * --filter errors), not unhandled-rejection stack dumps.
 *
 * Validation throws before any DB/index access, so these tests run against
 * an empty sandbox index and never need embedding/rerank models.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const qmdScript = join(projectRoot, "src", "cli", "qmd.ts");
const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const qmdCommand = isBunRuntime
  ? { command: process.execPath, args: [qmdScript] }
  : { command: process.execPath, args: [tsxCli, qmdScript] };

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-query-err-"));
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function runQueryValidation(
  query: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const dbPath = join(testDir, `t-${Math.random().toString(36).slice(2)}.sqlite`);
  const configDir = join(testDir, `config-${Math.random().toString(36).slice(2)}`);
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "index.yml"), "collections: {}\n");
  const runner = { command: qmdCommand.command, args: [...qmdCommand.args, "query", query] };
  const proc = spawn(runner.command, runner.args, {
    cwd: testDir,
    env: {
      ...process.env,
      INDEX_PATH: dbPath,
      QMD_CONFIG_DIR: configDir,
      PWD: testDir,
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
  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.on("close", (code) => resolve(code ?? 1));
  });
  return { stdout: await stdoutPromise, stderr: await stderrPromise, exitCode };
}

function expectCleanError(stderr: string, message: string): void {
  expect(stderr).toContain(message);
  // No unhandled-rejection stack dump: no runtime stack frames, source
  // context lines, or runtime version footer.
  expect(stderr).not.toMatch(/^\s*at\s/m);
  expect(stderr).not.toMatch(/Bun v\d/);
  expect(stderr).not.toMatch(/unhandled/i);
}

describe("qmd query validation error shape", () => {
  test("vec negation error is one line with exit 1", async () => {
    const { stderr, exitCode } = await runQueryValidation("vec: -excluded term");
    expect(exitCode).toBe(1);
    expectCleanError(
      stderr,
      "Line 1 (vec): Negation (-term) is not supported in vec/hyde queries. Use lex for exclusions."
    );
  });

  test("lex unmatched-quote error is one line with exit 1", async () => {
    const { stderr, exitCode } = await runQueryValidation('lex: foo "bar');
    expect(exitCode).toBe(1);
    expectCleanError(
      stderr,
      'Line 1 (lex): Lex query has an unmatched double quote ("). Add the closing quote or remove it.'
    );
  });
});
