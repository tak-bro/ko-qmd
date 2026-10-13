/**
 * grep --fixed-string alias regression test.
 *
 * The MCP grep tool names the flag `fixedString` (singular) while the CLI
 * documents `--fixed-strings`/`-F` (plural). With `strict: false` passthrough,
 * `--fixed-string` used to be silently ignored and the pattern ran as a regex.
 * `--fixed-string` is now an alias of `--fixed-strings`.
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
let dbPath: string;
let configDir: string;
let docsDir: string;

async function runQmd(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn(qmdCommand.command, [...qmdCommand.args, ...args], {
    cwd: docsDir,
    env: {
      ...process.env,
      INDEX_PATH: dbPath,
      QMD_CONFIG_DIR: configDir,
      PWD: docsDir,
      QMD_DOCTOR_DEVICE_PROBE: "0",
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
  testDir = await mkdtemp(join(tmpdir(), "qmd-grep-alias-"));
  dbPath = join(testDir, "test.sqlite");
  configDir = join(testDir, "config");
  docsDir = join(testDir, "docs");
  await mkdir(configDir, { recursive: true });
  await mkdir(docsDir, { recursive: true });
  await writeFile(join(configDir, "index.yml"), "collections: {}\n");
  // 'a.b' matches line 3 literally AND line 4 as a regex; only line 3 as a fixed string.
  await writeFile(join(docsDir, "a.md"), "# t\n\na.b literal here\n\naXb regex here\n");

  const add = await runQmd(["collection", "add", docsDir, "--name", "repro"]);
  expect(add.exitCode).toBe(0);
  const update = await runQmd(["update"]);
  expect(update.exitCode).toBe(0);
}, 120000);

afterAll(async () => {
  if (testDir) await rm(testDir, { recursive: true, force: true });
});

describe("grep --fixed-string alias", () => {
  test("-F treats the pattern literally", async () => {
    const { stdout, exitCode } = await runQmd(["grep", "-F", "a.b"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("a.b literal here");
    expect(stdout).not.toContain("aXb regex here");
  });

  test("--fixed-strings (plural) treats the pattern literally", async () => {
    const { stdout, exitCode } = await runQmd(["grep", "--fixed-strings", "a.b"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("a.b literal here");
    expect(stdout).not.toContain("aXb regex here");
  });

  test("--fixed-string (singular) is an alias, not a silent regex", async () => {
    const { stdout, exitCode } = await runQmd(["grep", "--fixed-string", "a.b"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("a.b literal here");
    expect(stdout).not.toContain("aXb regex here");
  });

  test("bare pattern still runs as regex (no behavior change)", async () => {
    const { stdout, exitCode } = await runQmd(["grep", "a.b"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("a.b literal here");
    expect(stdout).toContain("aXb regex here");
  });
});
