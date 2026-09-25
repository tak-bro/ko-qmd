/**
 * scripts/bench-ko.sh corpus/goldset overrides: `KO_CORPUS` and `KO_BENCH`.
 *
 * The script runs from a copy under a temp root, so ROOT and tmp/bench-ko/ are the temp
 * root's and the repo's own bench outputs are never touched. With no package.json there,
 * a run that gets past validation stops at its first `npm run qmd` — after index.yml is
 * written and before any model loads.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/bench-ko.sh", import.meta.url));

let root: string;
let fixture: string;
let sentinel: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bench-ko-env-")));
  mkdirSync(join(root, "scripts"));
  copyFileSync(script, join(root, "scripts", "bench-ko.sh"));
  // Skips the script's `npm install` guard, which must look here (ROOT), not at the caller's cwd.
  mkdirSync(join(root, "node_modules"));
  fixture = join(root, "test", "fixtures", "ko-vault");
  mkdirSync(join(fixture, "wiki"), { recursive: true });
  writeFileSync(join(fixture, "ko-bench.json"), JSON.stringify({ collection: "ko-vault", queries: [] }));
  writeFileSync(join(fixture, "models.yml"), "embed: hf:none/none.gguf\n");
  // A previous run's output: an override that fails validation must leave it in place.
  mkdirSync(join(root, "tmp", "bench-ko"), { recursive: true });
  sentinel = join(root, "tmp", "bench-ko", "bench.json");
  writeFileSync(sentinel, "{}");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const run = (env: Record<string, string>, cwd = root) => {
  // PWD is dropped so bash reports the physical cwd, the same form realpathSync gives.
  const { PWD: _pwd, KO_CORPUS: _corpus, KO_BENCH: _bench, ...base } = process.env;
  return spawnSync("bash", [join(root, "scripts", "bench-ko.sh")], {
    cwd,
    encoding: "utf-8",
    env: { ...base, ...env },
    timeout: 30_000,
  });
};

const indexYml = () => readFileSync(join(root, "tmp", "bench-ko", "config", "index.yml"), "utf-8");

const makeCaller = () => {
  const caller = join(root, "caller");
  mkdirSync(join(caller, "corpus", "wiki"), { recursive: true });
  return caller;
};

describe("bench-ko.sh KO_CORPUS / KO_BENCH", () => {
  test("defaults to the committed fixture when neither is set", () => {
    const res = run({});
    expect(res.stderr).toContain(`corpus=${fixture}\n`);
    expect(res.stderr).toContain(`bench=${join(fixture, "ko-bench.json")}\n`);
    expect(indexYml()).toContain(`    path: "${fixture}"\n`);
    expect(indexYml()).toContain("  embed: hf:none/none.gguf\n");
  });

  test("a relative KO_CORPUS resolves against the caller's cwd and is what gets indexed", () => {
    const caller = makeCaller();
    const res = run({ KO_CORPUS: "corpus" }, caller);
    expect(res.stderr).toContain(`corpus=${join(caller, "corpus")}\n`);
    expect(indexYml()).toContain(`    path: "${join(caller, "corpus")}"\n`);
    // Models still come from the committed fixture, not the corpus copy.
    expect(indexYml()).toContain("  embed: hf:none/none.gguf\n");
  });

  test("a relative KO_BENCH resolves against the caller's cwd", () => {
    const caller = makeCaller();
    writeFileSync(join(caller, "gold.json"), JSON.stringify({ collection: "ko-vault", queries: [] }));
    const res = run({ KO_BENCH: "gold.json" }, caller);
    expect(res.stderr).toContain(`bench=${join(caller, "gold.json")}\n`);
  });

  test("running from another directory never runs npm install there", () => {
    const caller = makeCaller();
    run({ KO_CORPUS: "corpus" }, caller);
    expect(existsSync(join(caller, "package-lock.json"))).toBe(false);
    expect(existsSync(join(root, "package-lock.json"))).toBe(false);
  });

  test.each([
    ["a missing KO_CORPUS", () => ({ KO_CORPUS: join(root, "no-such-corpus") }), "KO_CORPUS is not a directory: <root>/no-such-corpus"],
    ["a KO_CORPUS without wiki/", () => ({ KO_CORPUS: join(root, "tmp") }), "KO_CORPUS has no wiki/"],
    ["an empty KO_CORPUS", () => ({ KO_CORPUS: "" }), "KO_CORPUS is set but empty"],
    ["a missing KO_BENCH", () => ({ KO_BENCH: join(root, "no-such-bench.json") }), "KO_BENCH is not a file: <root>/no-such-bench.json"],
    ["an empty KO_BENCH", () => ({ KO_BENCH: "" }), "KO_BENCH is set but empty"],
  ])("%s fails before the previous output is removed", (_name, env, message) => {
    const res = run(env());
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(message.replace("<root>", root));
    expect(existsSync(sentinel)).toBe(true);
  });

  test.each([
    ["a newline that would inject YAML keys", "ko-vault\n    update: touch pwned"],
    ["a missing collection", undefined],
  ])("a goldset collection with %s fails before the previous output is removed", (_name, collection) => {
    const gold = join(root, "gold.json");
    writeFileSync(gold, JSON.stringify({ collection, queries: [] }));
    const res = run({ KO_BENCH: gold });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("goldset collection must match [A-Za-z0-9._-]+");
    expect(existsSync(sentinel)).toBe(true);
    expect(existsSync(join(root, "tmp", "bench-ko", "config", "index.yml"))).toBe(false);
  });
});
