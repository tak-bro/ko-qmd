/**
 * `qmd bench --backend` — run a subset of backends from the CLI.
 *
 * The lex CI gate (scripts/bench-lex-gate.sh) benches bm25 alone so it needs
 * no embedding or reranker model. runBenchmark already took a `backends`
 * list; these tests lock the CLI flag that reaches it.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createStore } from "../src/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const qmdScript = join(repoRoot, "src", "cli", "qmd.ts");
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

describe("qmd bench --backend", () => {
  let dir: string;
  let fixturePath: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "qmd-bench-backend-"));
    const docs = join(dir, "docs");
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, "api.md"), "# API versioning\n\nUse /v1 and /v2 endpoints.\n");
    const configPath = join(dir, "index.yml");
    await writeFile(configPath, `collections:\n  docs:\n    path: ${JSON.stringify(docs)}\n    pattern: "**/*.md"\n`);
    const dbPath = join(dir, "index.sqlite");
    const store = await createStore({ dbPath, configPath });
    await store.update();
    await store.close();

    fixturePath = join(dir, "fixture.json");
    await writeFile(fixturePath, JSON.stringify({
      description: "backend flag",
      version: 1,
      collection: "docs",
      queries: [{
        id: "q1",
        query: "API versioning",
        type: "exact",
        description: "kw",
        expected_files: ["api.md"],
        expected_in_top_k: 1,
      }],
    }));
    env = { INDEX_PATH: dbPath, QMD_CONFIG_DIR: dir, QMD_DOCTOR_DEVICE_PROBE: "0" };
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function runBenchCli(args: string[]) {
    const cmdArgs = isBun ? [qmdScript, ...args] : [tsxCli, qmdScript, ...args];
    return spawnSync(process.execPath, cmdArgs, {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, ...env },
      timeout: 120_000,
    });
  }

  test("--backend bm25 runs only the bm25 backend", () => {
    const res = runBenchCli(["--index", "index", "bench", fixturePath, "--backend", "bm25", "--json"]);
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(Object.keys(out.results[0].backends)).toEqual(["bm25"]);
    expect(out.summary.bm25.avg_recall_at_5).toBe(1);
  });

  test("a comma list and repeated flags both reach the backend check", () => {
    // runBenchmark alone would bench the known half of `bm25,nope`; the CLI refuses the typo.
    const comma = runBenchCli(["--index", "index", "bench", fixturePath, "--backend", "bm25,nope", "--json"]);
    const repeated = runBenchCli(["--index", "index", "bench", fixturePath, "--backend", "bm25", "--backend", "nope", "--json"]);
    for (const res of [comma, repeated]) {
      expect(res.status).toBe(1);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain("Unknown backend(s): nope");
    }
  });

  test("an unknown backend exits 1 and lists the available ones", () => {
    const res = runBenchCli(["--index", "index", "bench", fixturePath, "--backend", "nope"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Unknown backend(s): nope");
    expect(res.stderr).toContain("Available: bm25, vector, hybrid, full");
  });
});
