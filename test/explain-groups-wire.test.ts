/**
 * explain-groups-wire.test.ts — dim wrapper + call site for --explain group ranks.
 *
 * `explainGroupLines` (src/cli/qmd.ts) is pinned by rrf-trace.test.ts, but the
 * private `printExplainGroups` dim wrapper and its call site in the CLI output
 * path never execute in tests. These tests drive them through the real CLI:
 * a lex-only structured `query --explain --no-rerank` needs no embedding or
 * rerank models, so the whole wiring runs on a temp FTS fixture.
 *
 * Color gating lives at src/cli/qmd.ts (`useColor = !process.env.NO_COLOR &&
 * process.stdout.isTTY`, evaluated at module load; the wrapper prints
 * `${c.dim}${line}${c.reset}`). A spawned CLI has a piped stdout, so isTTY is
 * false and both NO_COLOR set/unset must print plain lines. The pty cases
 * below (darwin-only, skipped elsewhere) force isTTY true to pin the dim
 * branch itself.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
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
let testDbPath: string;
let testConfigDir: string;
let fixturesDir: string;

async function runQmd(
  args: string[],
  envExtra: Record<string, string | undefined> = {},
  stripNoColor = false,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const runnerCommand = qmdCommand.command;
  const runnerArgs = [...qmdCommand.args, ...args];
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    INDEX_PATH: testDbPath,
    QMD_CONFIG_DIR: testConfigDir,
    PWD: fixturesDir,
    QMD_DOCTOR_DEVICE_PROBE: "0",
    ...envExtra,
  };
  if (stripNoColor) delete childEnv.NO_COLOR;
  const proc = spawn(runnerCommand, runnerArgs, {
    cwd: fixturesDir,
    env: childEnv,
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
  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;
  return { stdout, stderr, exitCode };
}

const canPty = process.platform === "darwin" && existsSync("/usr/bin/script");

async function runQmdPty(
  args: string[],
  envExtra: Record<string, string | undefined> = {},
): Promise<{ stdout: string; exitCode: number }> {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    INDEX_PATH: testDbPath,
    QMD_CONFIG_DIR: testConfigDir,
    PWD: fixturesDir,
    QMD_DOCTOR_DEVICE_PROBE: "0",
    ...envExtra,
  };
  for (const key of Object.keys(childEnv)) {
    if (childEnv[key] === undefined) delete childEnv[key];
  }
  const proc = spawn(
    "/usr/bin/script",
    ["-q", "/dev/null", qmdCommand.command, ...qmdCommand.args, ...args],
    { cwd: fixturesDir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stdoutPromise = new Promise<string>((resolve, reject) => {
    let data = "";
    proc.stdout?.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    proc.once("error", reject);
    proc.stdout?.once("end", () => resolve(data));
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.on("close", (code) => resolve(code ?? 1));
  });
  const raw = await stdoutPromise;
  return { stdout: raw.replace(/\r\n/g, "\n"), exitCode };
}

function groupLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.includes("Sub-query ranks") || /fts\/lex\s+#1/.test(line));
}

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-explain-groups-"));
  testDbPath = join(testDir, "test.sqlite");
  testConfigDir = join(testDir, "config");
  fixturesDir = join(testDir, "fixtures");
  await mkdir(testConfigDir, { recursive: true });
  await mkdir(fixturesDir, { recursive: true });
  await writeFile(join(testConfigDir, "index.yml"), "collections: {}\n");
  await writeFile(
    join(fixturesDir, "alpha.md"),
    "# Alpha notes\n\nThe tokenizer splits Hangul syllables for lexical search testing.\n",
  );
  await writeFile(
    join(fixturesDir, "beta.md"),
    "# Beta notes\n\nCompletely unrelated content about gardening and soil.\n",
  );

  const added = await runQmd(["collection", "add", "."], { NO_COLOR: "1" });
  expect(added.exitCode).toBe(0);
}, 60000);

afterAll(async () => {
  if (testDir) await rm(testDir, { recursive: true, force: true });
});

describe("printExplainGroups call site (query --explain, lex-only, no rerank)", () => {
  test("group ranks reach stdout through the CLI output path", async () => {
    const { stdout, exitCode } = await runQmd(
      ["query", "lex: tokenizer", "--explain", "--no-rerank"],
      { NO_COLOR: "1" },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Explain: fts=");
    expect(stdout).toContain("Sub-query ranks (1 of the expansion's lists placed this document):");
    expect(stdout).toMatch(/fts\/lex\s+#1\s+rrf=\d+\.\d{4}\s+backend=\d+\.\d{4}\s+tokenizer/);
  }, 60000);

  test("NO_COLOR=1: dim wrapper emits the group lines with no escape codes", async () => {
    const { stdout, exitCode } = await runQmd(
      ["query", "lex: tokenizer", "--explain", "--no-rerank"],
      { NO_COLOR: "1" },
    );
    expect(exitCode).toBe(0);
    const groups = groupLines(stdout);
    expect(groups.length).toBeGreaterThan(0);
    for (const line of groups) {
      expect(line).not.toContain("\u001b");
    }
  }, 60000);

  test("NO_COLOR unset but piped (non-TTY): wrapper still emits plain lines", async () => {
    // Piped stdout means process.stdout.isTTY is false, so useColor is false
    // even without NO_COLOR (src/cli/qmd.ts color gate). This pins the TTY
    // half of the contract in the only deterministic way a pipe allows.
    const { stdout, exitCode } = await runQmd(
      ["query", "lex: tokenizer", "--explain", "--no-rerank"],
      {},
      true,
    );
    expect(exitCode).toBe(0);
    const groups = groupLines(stdout);
    expect(groups.length).toBeGreaterThan(0);
    for (const line of groups) {
      expect(line).not.toContain("\u001b");
    }
  }, 60000);

  test("explain payload is wired to outputResults (--format json)", async () => {
    const { stdout, exitCode } = await runQmd(
      ["query", "lex: tokenizer", "--explain", "--no-rerank", "--format", "json"],
      { NO_COLOR: "1" },
    );
    expect(exitCode).toBe(0);
    const parsed: Array<{ explain?: { rrf?: { contributions?: Array<{ source: string; queryType: string; query: string }> } } }> =
      JSON.parse(stdout);
    expect(parsed.length).toBeGreaterThan(0);
    const contributions = parsed[0]?.explain?.rrf?.contributions ?? [];
    expect(contributions.some((c) => c.source === "fts" && c.queryType === "lex" && c.query === "tokenizer")).toBe(true);
  }, 60000);

  test.skipIf(!canPty)("pty without NO_COLOR: dim wrapper colors the group lines", async () => {
    const { stdout, exitCode } = await runQmdPty(
      ["query", "lex: tokenizer", "--explain", "--no-rerank"],
      { NO_COLOR: undefined },
    );
    // runQmdPty drops undefined-valued keys above, so NO_COLOR is absent here.
    expect(exitCode).toBe(0);
    const groups = groupLines(stdout);
    expect(groups.length).toBeGreaterThan(0);
    for (const line of groups) {
      expect(line).toContain("\u001b[2m");
    }
  }, 60000);

  test.skipIf(!canPty)("pty with NO_COLOR=1: dim wrapper stays plain on a TTY", async () => {
    const { stdout, exitCode } = await runQmdPty(
      ["query", "lex: tokenizer", "--explain", "--no-rerank"],
      { NO_COLOR: "1" },
    );
    expect(exitCode).toBe(0);
    const groups = groupLines(stdout);
    expect(groups.length).toBeGreaterThan(0);
    for (const line of groups) {
      expect(line).not.toContain("\u001b");
    }
  }, 60000);
});
