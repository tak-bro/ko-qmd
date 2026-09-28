/**
 * scripts/bench-ko.sh overrides: `KO_CORPUS`, `KO_BENCH` and `KO_FORM`.
 *
 * The script runs from a copy under a temp root, so ROOT and tmp/bench-ko/ are the temp
 * root's and the repo's own bench outputs are never touched. With no package.json there,
 * a run that gets past validation stops at its first `npm run qmd` — after index.yml is
 * written and before any model loads. The KO_FORM tests that need the whole run put a stub
 * `qmd` script in that root instead.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  const { PWD: _pwd, KO_CORPUS: _corpus, KO_BENCH: _bench, KO_FORM: _form, ...base } = process.env;
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
    ["queries that are not a list", { collection: "ko-vault", queries: {} }],
    ["a query that is not a string", { collection: "ko-vault", queries: [{ id: "q", query: 7 }] }],
  ])("a goldset with %s fails before the previous output is removed", (_name, goldset) => {
    const gold = join(root, "gold.json");
    writeFileSync(gold, JSON.stringify(goldset));
    const res = run({ KO_BENCH: gold });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("goldset queries must be a list of {query: string}");
    expect(existsSync(sentinel)).toBe(true);
  });

  // bench's parseStructuredQuery throws on these, and the backend's catch would score them 0 silently.
  test.each([
    ["a whitespace-only query", " \n "],
    ["several lines without a lex:/vec:/hyde:/intent: prefix", "역색인\n색인 구조"],
  ])("a goldset with %s fails before the previous output is removed", (_name, query) => {
    const gold = join(root, "gold.json");
    writeFileSync(gold, JSON.stringify({ collection: "ko-vault", queries: [{ id: "bad", query }] }));
    const res = run({ KO_BENCH: gold });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("goldset query bad must be one line or typed lex:/vec:/hyde:/intent: lines");
    expect(existsSync(sentinel)).toBe(true);
  });

  test("a KO_BENCH inside tmp/bench-ko/ fails before the rm could delete it", () => {
    const gold = join(root, "tmp", "bench-ko", "ko-bench.seam.json");
    writeFileSync(gold, JSON.stringify({ collection: "ko-vault", queries: [] }));
    const res = run({ KO_BENCH: gold });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("KO_BENCH must not be inside tmp/bench-ko/");
    expect(existsSync(gold)).toBe(true);
    expect(existsSync(sentinel)).toBe(true);
  });

  test("a KO_BENCH that reaches tmp/bench-ko/ through a symlink is refused too", () => {
    const gold = join(root, "tmp", "bench-ko", "ko-bench.seam.json");
    writeFileSync(gold, JSON.stringify({ collection: "ko-vault", queries: [] }));
    symlinkSync(join(root, "tmp", "bench-ko"), join(root, "outputs"));
    const res = run({ KO_BENCH: join(root, "outputs", "ko-bench.seam.json") });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("KO_BENCH must not be inside tmp/bench-ko/");
    expect(existsSync(gold)).toBe(true);
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

describe("bench-ko.sh KO_FORM", () => {
  const seamFile = () => join(root, "tmp", "bench-ko", "ko-bench.seam.json");
  const writeGold = () =>
    writeFileSync(join(fixture, "ko-bench.json"), JSON.stringify({
      collection: "ko-vault",
      queries: [
        { id: "one", query: "역색인", expected_files: ["wiki/a.md"] },
        { id: "typed", query: "lex: 역색인\nvec: 색인 구조", expected_files: ["wiki/a.md"] },
        { id: "typed-one-line", query: "lex: 색인", expected_files: ["wiki/a.md"] },
        { id: "trailing-newline", query: " 역색인 구조\n", expected_files: ["wiki/a.md"] },
      ],
    }));

  // A stand-in for `npm run qmd`: update/embed pass, bench records the goldset path it was handed
  // and prints a minimal bench JSON, so the whole script runs through to its RESULT lines.
  const stubQmd = () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { qmd: "node stub.mjs" } }));
    writeFileSync(join(root, "stub.mjs"), [
      'import { writeFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      'const at = args.indexOf("bench");',
      "if (at >= 0) {",
      '  writeFileSync("bench-arg.txt", args[at + 1]);',
      "  const b = { avg_recall_at_5: 1, avg_mrr: 1 };",
      "  console.log(JSON.stringify({ summary: { bm25: b, vector: b, hybrid: b, full: b },",
      "    summary_hard: { hybrid_r1: 0.5, hybrid_mrr: 0.5, full_r1: 0.5, full_mrr: 0.5, n: 2 } }));",
      "}",
    ].join("\n"));
  };
  const benchArg = () => readFileSync(join(root, "bench-arg.txt"), "utf-8");

  test.each([
    ["an empty KO_FORM", "", "KO_FORM is set but empty"],
    ["an unknown KO_FORM", "hybrid", "KO_FORM must be seam or plain, got: hybrid"],
  ])("%s fails before the previous output is removed", (_name, form, message) => {
    const res = run({ KO_FORM: form });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(message);
    expect(existsSync(sentinel)).toBe(true);
  });

  test("defaults to seam: each plain query becomes lex:/vec: lines, a typed query is kept", () => {
    writeGold();
    const res = run({});
    expect(res.stderr).toContain("form=seam\n");
    const derived = JSON.parse(readFileSync(seamFile(), "utf-8"));
    expect(derived.collection).toBe("ko-vault");
    expect(derived.queries.map((q: { query: string }) => q.query)).toEqual([
      "lex: 역색인\nvec: 역색인",
      "lex: 역색인\nvec: 색인 구조",
      "lex: 색인",
      "lex: 역색인 구조\nvec: 역색인 구조",
    ]);
    expect(derived.queries[0].expected_files).toEqual(["wiki/a.md"]);
  });

  test("KO_FORM=plain benches the goldset as written and leaves no derived file", () => {
    writeGold();
    mkdirSync(join(root, "tmp", "bench-ko"), { recursive: true });
    writeFileSync(seamFile(), "stale");
    const res = run({ KO_FORM: "plain" });
    expect(res.stderr).toContain("form=plain\n");
    expect(existsSync(seamFile())).toBe(false);
  });

  test("the seam run hands qmd bench the derived goldset and tags RESULT-HARD form=seam", () => {
    writeGold();
    stubQmd();
    const res = run({});
    expect(res.status).toBe(0);
    expect(benchArg()).toBe(seamFile());
    expect(res.stdout).toMatch(/^RESULT bm25_r5=1\.0000 vector_r5=1\.0000 hybrid_r5=1\.0000 full_r5=1\.0000 full_mrr=1\.0000\n/);
    expect(res.stdout).toContain("RESULT-HARD hybrid_r1=0.5000 hybrid_mrr=0.5000 full_r1=0.5000 full_mrr=0.5000 n=2 form=seam\n");
  });

  test("the plain run hands qmd bench the goldset itself and tags RESULT-HARD form=plain", () => {
    writeGold();
    stubQmd();
    const res = run({ KO_FORM: "plain" });
    expect(res.status).toBe(0);
    expect(benchArg()).toBe(join(fixture, "ko-bench.json"));
    expect(res.stdout).toContain(" n=2 form=plain\n");
  });
});
