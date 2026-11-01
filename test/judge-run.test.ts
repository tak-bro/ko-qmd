import { describe, expect, test } from "vitest";
import { ollamaChat, type FetchLike } from "../scripts/judge/ollama.js";
import { buildPools, corpusPath, loadDoc } from "../scripts/judge/pool.js";
import { exitCode, judgeAll, judgeQuery, parseGrades, shuffled } from "../scripts/judge/run.js";
import type { BenchmarkResult } from "../src/bench/types.js";

const docs = [
  { file: "wiki/a.md", title: "A", body: "a" },
  { file: "wiki/b.md", title: "B", body: "b" },
  { file: "wiki/c.md", title: "C", body: "c" },
];

/** A fake judge that grades by title: A=3, B=1, C=0, reading the ids out of the prompt. */
function titleJudge(calls: string[] = []) {
  const byTitle: Record<string, number> = { A: 3, B: 1, C: 0 };
  return async (_system: string, user: string) => {
    calls.push(user);
    const grades = [...user.matchAll(/^\[(d\d+)\] (\w+)$/gm)].map(m => ({ id: m[1], grade: byTitle[m[2]!] }));
    return JSON.stringify({ grades });
  };
}

describe("judgeQuery", () => {
  test("maps grades back to files whatever order the seed shows them in", async () => {
    for (const seed of [1, 2, 3]) {
      expect(await judgeQuery("q", docs, seed, "rubric", titleJudge())).toEqual({
        "wiki/a.md": 3,
        "wiki/b.md": 1,
        "wiki/c.md": 0,
      });
    }
  });

  test("retries once with the reason when a reply misses an id", async () => {
    const calls: string[] = [];
    const good = titleJudge(calls);
    let first = true;
    const chat = async (system: string, user: string) => {
      if (first) {
        first = false;
        calls.push(user);
        return JSON.stringify({ grades: [{ id: "d1", grade: 2 }] });
      }
      return good(system, user);
    };
    const grades = await judgeQuery("q", docs, 1, "rubric", chat);
    expect(Object.keys(grades)).toHaveLength(3);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatch(/missing ids/);
  });

  test("a second bad reply throws instead of filling zeros", async () => {
    const chat = async () => "not json";
    await expect(judgeQuery("q", docs, 1, "rubric", chat)).rejects.toThrow(/invalid twice: reply is not JSON/);
  });
});

describe("judgeAll", () => {
  const pools = [
    { id: "q1", query: "x", files: ["wiki/a.md", "wiki/b.md"], rankings: {} },
    { id: "q2", query: "boom", files: ["wiki/c.md"], rankings: {} },
  ];
  const titles: Record<string, string> = { "wiki/a.md": "A", "wiki/b.md": "B", "wiki/c.md": "C" };
  const load = (file: string) => ({ title: titles[file]!, body: "" });

  test("a query that fails is recorded in errors with no grades, the others are graded, exit is 2", async () => {
    const good = titleJudge();
    const chat = async (system: string, user: string) => {
      if (user.includes("boom")) throw new Error("ollama 500: out of memory");
      return good(system, user);
    };
    const log: string[] = [];
    const passes = await judgeAll(pools, [1, 2], "rubric", chat, load, l => log.push(l));
    expect(passes.map(p => p.seed)).toEqual([1, 2]);
    expect(passes[0]!.grades.q1).toEqual({ "wiki/a.md": 3, "wiki/b.md": 1 });
    expect(passes[0]!.grades.q2).toBeUndefined();
    expect(passes[1]!.errors.q2).toMatch(/out of memory/);
    expect(log.filter(l => l.includes("ERROR"))).toHaveLength(2);
    expect(exitCode(passes)).toBe(2);
  });

  test("pointwise sends each document alone and merges the grades", async () => {
    const calls: string[] = [];
    const passes = await judgeAll(pools.slice(0, 1), [0], "rubric", titleJudge(calls), load, undefined, "pointwise");
    expect(passes[0]!.grades.q1).toEqual({ "wiki/a.md": 3, "wiki/b.md": 1 });
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c).toMatch(/문서 1개/);
  });

  test("every query graded in every pass exits 0", async () => {
    const passes = await judgeAll(pools.slice(0, 1), [1], "rubric", titleJudge(), load);
    expect(exitCode(passes)).toBe(0);
  });
});

describe("parseGrades", () => {
  const ids = ["d1", "d2"];
  test("accepts every id graded once", () => {
    expect(parseGrades('{"grades":[{"id":"d2","grade":0},{"id":"d1","grade":3}]}', ids)).toEqual({
      grades: { d1: 3, d2: 0 },
    });
  });
  test.each([
    ['{"grades":[{"id":"d1","grade":4},{"id":"d2","grade":0}]}', /grade 4/],
    ['{"grades":[{"id":"d1","grade":1.5},{"id":"d2","grade":0}]}', /grade 1.5/],
    ['{"grades":[{"id":"d1","grade":1},{"id":"d1","grade":0}]}', /twice/],
    ['{"grades":[{"id":"d9","grade":1}]}', /unknown id/],
    ['{"grades":[{"id":"d1","grade":1}]}', /missing ids d2/],
    ['{"other":1}', /no grades array/],
    ["null", /no grades array/],
  ])("rejects %s", (reply, reason) => {
    const r = parseGrades(reply, ids);
    expect("reason" in r && r.reason).toMatch(reason);
  });
});

describe("shuffled", () => {
  test("is a seeded permutation", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(shuffled(xs, 5)).toEqual(shuffled(xs, 5));
    expect([...shuffled(xs, 5)].sort()).toEqual(xs);
    expect(shuffled(xs, 5)).not.toEqual(shuffled(xs, 6));
  });
});

describe("buildPools", () => {
  const bench: BenchmarkResult = JSON.parse(JSON.stringify({
    results: [
      {
        id: "q1",
        query: "lex: x\nvec: x",
        type: "open",
        backends: {
          bm25: { top_files: ["qmd://ko-vault/wiki/a.md", "qmd://ko-vault/wiki/b.md"] },
          full: { top_files: ["qmd://ko-vault/wiki/b.md", "qmd://ko-vault/wiki/c.md"] },
        },
      },
    ],
  }));
  const querySet = { description: "", queries: [{ id: "q1", query: "x", type: "open", expected_files: [] as string[] }] };

  test("unions backend rankings in first-seen order and keeps each ranking", () => {
    const [pool] = buildPools(bench, querySet, ["bm25", "full"]);
    expect(pool!.query).toBe("x");
    expect(pool!.files).toEqual(["wiki/a.md", "wiki/b.md", "wiki/c.md"]);
    expect(pool!.rankings.full).toEqual(["wiki/b.md", "wiki/c.md"]);
  });

  test("answer files no backend retrieved join the pool after the rankings, unranked", () => {
    const gold = { description: "", queries: [{ id: "q1", query: "x", type: "exact", expected_files: ["wiki/b.md", "wiki/gold.md"] }] };
    const [pool] = buildPools(bench, gold, ["bm25", "full"]);
    expect(pool!.files).toEqual(["wiki/a.md", "wiki/b.md", "wiki/c.md", "wiki/gold.md"]);
    expect(Object.values(pool!.rankings).flat()).not.toContain("wiki/gold.md");
  });

  test("a missing query, backend or failed backend stops the run", () => {
    expect(() => buildPools(bench, { ...querySet, queries: [{ id: "q9", query: "y", type: "open", expected_files: [] }] }, ["bm25"])).toThrow(/no query q9/);
    expect(() => buildPools(bench, querySet, ["vector"])).toThrow(/no backend vector/);
    const failed = JSON.parse(JSON.stringify(bench)) as BenchmarkResult;
    failed.results[0]!.backends.bm25!.error = "no embeddings";
    expect(() => buildPools(failed, querySet, ["bm25"])).toThrow(/failed: no embeddings/);
  });

  test("corpusPath strips the qmd:// collection prefix", () => {
    expect(corpusPath("qmd://ko-vault/wiki/x.md")).toBe("wiki/x.md");
    expect(corpusPath("wiki/x.md")).toBe("wiki/x.md");
  });
});

describe("loadDoc", () => {
  test("takes the heading as title, keeps aliases, drops frontmatter", () => {
    const d = loadDoc("test/fixtures/ko-vault", "wiki/bm25-ranking.md");
    expect(d.title).toBe("BM25 Ranking");
    expect(d.body).toMatch(/^별칭: BM25 랭킹, BM25\n/);
    expect(d.body).not.toMatch(/created:/);
    expect(d.body).not.toMatch(/topics\/information-retrieval/);
  });
});

describe("ollamaChat", () => {
  test("posts a non-thinking, temperature-0 JSON request and returns the content", async () => {
    let sent: { url: string; body: Record<string, unknown> } | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      sent = { url, body: JSON.parse(init.body) as Record<string, unknown> };
      return new Response(JSON.stringify({ message: { content: '{"grades":[]}' }, prompt_eval_count: 100 }));
    };
    const chat = ollamaChat({ host: "http://h:1/", model: "m", schema: { type: "object" }, seed: 9, fetchImpl });
    expect(await chat("s", "u")).toBe('{"grades":[]}');
    expect(sent!.url).toBe("http://h:1/api/chat");
    expect(sent!.body).toMatchObject({ model: "m", stream: false, think: false, options: { temperature: 0, seed: 9 } });
  });

  test("a prompt that filled the context window throws instead of trusting the reply", async () => {
    const full: FetchLike = async () =>
      new Response(JSON.stringify({ message: { content: '{"grades":[]}' }, prompt_eval_count: 1000 }));
    await expect(ollamaChat({ host: "h", model: "m", schema: {}, seed: 1, numCtx: 1024, fetchImpl: full })("s", "u")).rejects.toThrow(/filled the context \(1000 tokens, num_ctx 1024\)/);
    const fits: FetchLike = async () =>
      new Response(JSON.stringify({ message: { content: "ok" }, prompt_eval_count: 500 }));
    expect(await ollamaChat({ host: "h", model: "m", schema: {}, seed: 1, numCtx: 1024, fetchImpl: fits })("s", "u")).toBe("ok");
  });

  test("a reply without prompt_eval_count throws: truncation cannot be ruled out", async () => {
    const noCount: FetchLike = async () => new Response(JSON.stringify({ message: { content: "ok" } }));
    await expect(ollamaChat({ host: "h", model: "m", schema: {}, seed: 1, fetchImpl: noCount })("s", "u")).rejects.toThrow(/no prompt_eval_count/);
  });

  test("an HTTP error or an error body throws with the server's message", async () => {
    const fail: FetchLike = async () => new Response("model not found", { status: 404 });
    await expect(ollamaChat({ host: "h", model: "m", schema: {}, seed: 1, fetchImpl: fail })("s", "u")).rejects.toThrow(/404: model not found/);
    const errBody: FetchLike = async () => new Response(JSON.stringify({ error: "out of memory" }));
    await expect(ollamaChat({ host: "h", model: "m", schema: {}, seed: 1, fetchImpl: errBody })("s", "u")).rejects.toThrow(/out of memory/);
  });
});
