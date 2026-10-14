/**
 * search-quote-validation.test.ts — plain `qmd search` must reject an unclosed
 * double quote with a clean error instead of silently reinterpreting it as a
 * trailing phrase (buildFTS5Query runs to end-of-input on a lone `"`).
 *
 * The structured path already enforces this via validateLexQuery
 * (structuredSearch throws `Location (lex): <message>`); the plain-search path
 * skipped validation entirely, so `search 'BM25"search'` exited 0 with the
 * same hits as the plain query — a typo disguised as success.
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
const runnerCommand = isBunRuntime ? process.execPath : process.execPath;
const runnerArgs = isBunRuntime ? [qmdScript] : [tsxCli, qmdScript];

let testDir: string;
let testDbPath: string;
let testConfigDir: string;
let fixturesDir: string;

async function runQmd(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn(runnerCommand, [...runnerArgs, ...args], {
    cwd: fixturesDir,
    env: {
      ...process.env,
      INDEX_PATH: testDbPath,
      QMD_CONFIG_DIR: testConfigDir,
      PWD: fixturesDir,
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

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-quote-"));
  testDbPath = join(testDir, "test.sqlite");
  testConfigDir = join(testDir, "config");
  fixturesDir = join(testDir, "fixtures");
  await mkdir(testConfigDir, { recursive: true });
  await mkdir(fixturesDir, { recursive: true });
  await writeFile(join(testConfigDir, "index.yml"), "collections: {}\n");
  await writeFile(
    join(fixturesDir, "notes.md"),
    "# Notes\n\nBM25 search engine notes here\n"
  );
  const added = await runQmd(["collection", "add", "."]);
  expect(added.exitCode).toBe(0);
}, 120000);

afterAll(async () => {
  if (testDir) await rm(testDir, { recursive: true, force: true });
});

describe("plain search quote validation", () => {
  test("unclosed quote exits 1 with the validator message", async () => {
    const { stderr, exitCode } = await runQmd(["search", 'BM25"search']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unmatched double quote");
  });

  test("balanced quotes still search unchanged", async () => {
    const { stdout, exitCode } = await runQmd(["search", '"BM25 search"']);
    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).toContain("notes");
  });

  test("plain query without quotes is unaffected", async () => {
    const { stdout, exitCode } = await runQmd(["search", "BM25 search"]);
    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).toContain("notes");
  });
});
