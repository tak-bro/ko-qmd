/**
 * Collection path canonicalization regression tests.
 *
 * `collection add .` used to store the raw `$PWD` (e.g. `/tmp/.../proj`),
 * while an absolute-path add normalized via `getRealPath()` (e.g.
 * `/private/tmp/.../proj` on macOS, where `/tmp` is a symlink). The
 * duplicate guard compares stored strings, so the same directory could be
 * added twice — indexed twice, searched twice, embedded twice.
 *
 * Both branches must now canonicalize identically before store+compare.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, symlink, readFile } from "fs/promises";
import { realpathSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const qmdScript = join(projectRoot, "src", "cli", "qmd.ts");
const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");

async function runQmd(
  args: string[],
  opts: { cwd: string; pwdEnv?: string; dbPath: string; configDir: string }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const runner = isBunRuntime
    ? { command: process.execPath, args: [qmdScript, ...args] }
    : { command: process.execPath, args: [tsxCli, qmdScript, ...args] };

  const proc = spawn(runner.command, runner.args, {
    cwd: opts.cwd,
    env: {
      ...process.env,
      INDEX_PATH: opts.dbPath,
      QMD_CONFIG_DIR: opts.configDir,
      PWD: opts.pwdEnv ?? opts.cwd,
      QMD_DOCTOR_DEVICE_PROBE: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
  proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
  const exitCode = await new Promise<number>((res, rej) => {
    proc.once("error", rej);
    proc.on("close", (code) => res(code ?? 1));
  });
  return { stdout, stderr, exitCode };
}

async function makeEnv(tag: string) {
  const dbPath = join(testDir, `${tag}.sqlite`);
  const configDir = join(testDir, `${tag}-config`);
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "index.yml"), "collections: {}\n");
  return { dbPath, configDir };
}

let testDir: string;
let realDir: string;
let linkDir: string;
let realPath: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-path-canon-"));
  realDir = join(testDir, "real", "proj");
  await mkdir(realDir, { recursive: true });
  await writeFile(
    join(realDir, "hello.md"),
    "# hello\nsymlink duplicate guard uniquekeyword999\n"
  );
  // Explicit symlink so the test is meaningful on every OS, not just macOS
  // (where $TMPDIR itself already contains a symlinked component).
  linkDir = join(testDir, "link-proj");
  await symlink(realDir, linkDir);
  realPath = realpathSync(linkDir);
  expect(realPath).toBe(realpathSync(realDir));
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("collection add path canonicalization", () => {
  test("add . stores the canonical path, not raw $PWD", async () => {
    const { dbPath, configDir } = await makeEnv("dot-stores-canonical");
    const add = await runQmd(["collection", "add", ".", "--name", "via-dot"], {
      cwd: linkDir,
      pwdEnv: linkDir,
      dbPath,
      configDir,
    });
    expect(add.exitCode, `collection add . failed: ${add.stderr}`).toBe(0);

    const yml = await readFile(join(configDir, "index.yml"), "utf8");
    expect(yml).toContain(`path: ${realPath}`);
    expect(yml).not.toContain(`path: ${linkDir}`);
  });

  test("add . then add canonical absolute path is rejected as duplicate", async () => {
    const { dbPath, configDir } = await makeEnv("dot-then-abs");
    const first = await runQmd(["collection", "add", ".", "--name", "c1"], {
      cwd: linkDir,
      pwdEnv: linkDir,
      dbPath,
      configDir,
    });
    expect(first.exitCode, `first add failed: ${first.stderr}`).toBe(0);

    const second = await runQmd(
      ["collection", "add", realPath, "--name", "c2"],
      { cwd: linkDir, pwdEnv: linkDir, dbPath, configDir }
    );
    expect(second.exitCode).not.toBe(0);
    expect(second.stderr).toContain("already exists for this path and pattern");

    const search = await runQmd(["search", "uniquekeyword999", "--all"], {
      cwd: linkDir,
      pwdEnv: linkDir,
      dbPath,
      configDir,
    });
    expect(search.exitCode).toBe(0);
    const hits = (search.stdout.match(/hello\.md/g) ?? []).length;
    expect(hits).toBe(1);
  });

  test("add canonical absolute path then add . is rejected as duplicate", async () => {
    const { dbPath, configDir } = await makeEnv("abs-then-dot");
    const first = await runQmd(
      ["collection", "add", realPath, "--name", "c1"],
      { cwd: linkDir, pwdEnv: linkDir, dbPath, configDir }
    );
    expect(first.exitCode, `first add failed: ${first.stderr}`).toBe(0);

    const second = await runQmd(["collection", "add", ".", "--name", "c2"], {
      cwd: linkDir,
      pwdEnv: linkDir,
      dbPath,
      configDir,
    });
    expect(second.exitCode).not.toBe(0);
    expect(second.stderr).toContain("already exists for this path and pattern");
  });

  test("normal adds are unchanged: same path+pattern rejected, different dirs allowed", async () => {
    const { dbPath, configDir } = await makeEnv("normal-adds");
    const otherDir = join(testDir, "other");
    await mkdir(otherDir, { recursive: true });
    await writeFile(join(otherDir, "other.md"), "# other\n");

    const first = await runQmd(
      ["collection", "add", realPath, "--name", "c1"],
      { cwd: realDir, dbPath, configDir }
    );
    expect(first.exitCode, `first add failed: ${first.stderr}`).toBe(0);

    const same = await runQmd(
      ["collection", "add", realPath, "--name", "c2"],
      { cwd: realDir, dbPath, configDir }
    );
    expect(same.exitCode).not.toBe(0);
    expect(same.stderr).toContain("already exists for this path and pattern");

    const different = await runQmd(
      ["collection", "add", otherDir, "--name", "c3"],
      { cwd: realDir, dbPath, configDir }
    );
    expect(different.exitCode, `different-dir add failed: ${different.stderr}`).toBe(0);

    // Same path with a different mask is a distinct collection (#536).
    const mask = await runQmd(
      ["collection", "add", realPath, "--name", "c4", "--mask", "hello.md"],
      { cwd: realDir, dbPath, configDir }
    );
    expect(mask.exitCode, `different-mask add failed: ${mask.stderr}`).toBe(0);
  });
});
