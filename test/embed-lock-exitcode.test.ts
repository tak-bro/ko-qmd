/**
 * Regression tests for embed lock contention exit code.
 *
 * Contention ("Another embed process is already running. Skipping.") used to
 * exit 0, so automation (`qmd embed && deploy`) mistook a skip for success.
 * The contention path must exit nonzero while keeping the message; the
 * uncontended (free lock) path must still acquire and proceed.
 */
import { describe, test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  embedLockPathForDb,
  tryAcquireEmbedLock,
  EMBED_LOCK_BUSY_MESSAGE,
} from "../src/cli/embed-lock.ts";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..");
const cliTs = join(projectRoot, "src", "cli", "qmd.ts");
const holderTs = join(thisDir, "_helpers", "embed-lock-holder.ts");
const tsxCli = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

async function waitForStdoutContains(
  getOutput: () => string,
  needle: string,
  timeoutMs = 15000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (getOutput().includes(needle)) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${JSON.stringify(needle)} in child output`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("embed lock contention exit code", () => {
  test("contended `qmd embed` exits 1 with the busy message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qmd-embed-exitcode-"));
    const dbPath = join(dir, "index.sqlite");
    const lockPath = embedLockPathForDb(dbPath);
    try {
      // Live qmd-like holder for this DB's lock (argv carries `qmd embed` tokens).
      const holderArgs = isBunRuntime
        ? [holderTs, lockPath, "60000", "qmd", "embed"]
        : [tsxCli, holderTs, lockPath, "60000", "qmd", "embed"];
      const holder = spawn(process.execPath, holderArgs, { stdio: ["ignore", "pipe", "pipe"] });
      let holderOut = "";
      holder.stdout.on("data", (d: Buffer) => { holderOut += d.toString(); });
      await waitForStdoutContains(() => holderOut, "HOLD");

      // Contender: real CLI against the contended DB.
      const cliArgs = isBunRuntime ? [cliTs, "embed"] : [tsxCli, cliTs, "embed"];
      const contender = spawn(process.execPath, cliArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, INDEX_PATH: dbPath },
      });
      let stdout = "";
      let stderr = "";
      contender.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      contender.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      const exitCode = await new Promise<number | null>((resolve) => {
        contender.on("close", (code) => resolve(code));
      });
      holder.kill();

      expect(stdout).toContain(EMBED_LOCK_BUSY_MESSAGE);
      expect(stderr).not.toContain(EMBED_LOCK_BUSY_MESSAGE);
      expect(exitCode).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 90_000);

  test("uncontended lock still acquires (proceed path unchanged)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qmd-embed-exitcode-free-"));
    const lockPath = embedLockPathForDb(join(dir, "index.sqlite"));
    try {
      const handle = tryAcquireEmbedLock(lockPath);
      expect(handle).not.toBeNull();
      handle!.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
