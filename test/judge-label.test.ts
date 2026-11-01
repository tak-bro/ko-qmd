import { describe, expect, test } from "vitest";
import { labelPairs, runLabeling, type LabelFile } from "../scripts/judge/label.js";
import type { Pool } from "../scripts/judge/pool.js";

const CORPUS = "test/fixtures/ko-vault";

const pools: Pool[] = [
  {
    id: "g1",
    query: "역색인",
    files: [
      "wiki/inverted-index.md",
      "wiki/bm25-ranking.md",
      "distractors/forward-index.md",
      "wiki/INDEX.md",
      "wiki/hybrid-search.md",
      "wiki/zettelkasten.md",
      "distractors/suffix-array.md",
    ],
    rankings: {
      full: ["wiki/inverted-index.md", "wiki/bm25-ranking.md", "distractors/forward-index.md", "wiki/INDEX.md", "wiki/hybrid-search.md", "wiki/zettelkasten.md"],
      bm25: ["wiki/zettelkasten.md", "distractors/suffix-array.md"],
    },
  },
  { id: "o1", query: "열린 질의", files: [], rankings: { full: ["wiki/bm25-ranking.md"] } },
];

function scripted(answers: string[]) {
  const saves: LabelFile[] = [];
  const io = {
    ask: async () => answers.shift() ?? null,
    print: () => {},
    save: (f: LabelFile) => saves.push(JSON.parse(JSON.stringify(f)) as LabelFile),
  };
  return { io, saves };
}

const empty = (): LabelFile => ({ description: "", rubric_sha256: "x", labels: {} });

describe("labelPairs", () => {
  test("takes the top 2 of full plus 3 others from the pool, for the listed queries only", () => {
    const pairs = labelPairs(pools, new Set(["g1"]));
    const files = pairs.map(p => p.file);
    expect(pairs.map(p => p.id)).toEqual(["g1", "g1", "g1", "g1", "g1"]);
    expect(new Set(files).size).toBe(5);
    expect(files).toEqual(expect.arrayContaining(["wiki/inverted-index.md", "wiki/bm25-ranking.md"]));
    for (const f of files) expect(pools[0]!.files).toContain(f);
  });

  test("the draws reach low ranks and files only another backend returned", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...pools[0]!, id: `g${i}` }));
    const drawn = new Set(labelPairs(many, new Set(many.map(p => p.id))).map(p => p.file));
    expect(drawn).toContain("distractors/suffix-array.md");
    expect(drawn).toContain("wiki/zettelkasten.md");
  });

  test("pairs are shuffled so the top hit is not always first", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...pools[0]!, id: `g${i}` }));
    const firsts = new Set(labelPairs(many, new Set(many.map(p => p.id))).filter((_, i) => i % 5 === 0).map(p => p.file));
    expect(firsts.size).toBeGreaterThan(1);
  });

  test("a pool without the backend's ranking throws", () => {
    expect(() => labelPairs(pools, new Set(["g1"]), "vector")).toThrow(/no vector ranking/);
  });
});

describe("runLabeling", () => {
  const pairs = labelPairs(pools, new Set(["g1"]));

  test("records each grade and saves after every label", async () => {
    const file = empty();
    const { io, saves } = scripted(["3", "1", "0", "2", "0"]);
    expect(await runLabeling(pairs, file, CORPUS, io)).toBe(5);
    expect(Object.values(file.labels.g1!).sort()).toEqual([0, 0, 1, 2, 3]);
    expect(saves).toHaveLength(5);
    expect(saves[0]!.labels.g1![pairs[0]!.file]).toBe(3);
  });

  test("q stops, and a rerun resumes at the first unlabeled pair", async () => {
    const file = empty();
    await runLabeling(pairs, file, CORPUS, scripted(["2", "q"]).io);
    expect(Object.keys(file.labels.g1!)).toEqual([pairs[0]!.file]);
    const { io } = scripted(["1", "1", "1", "1"]);
    expect(await runLabeling(pairs, file, CORPUS, io)).toBe(4);
    expect(file.labels.g1![pairs[0]!.file]).toBe(2);
    expect(Object.keys(file.labels.g1!)).toHaveLength(5);
  });

  test("s skips without a label, bad input asks again, end of input stops", async () => {
    const file = empty();
    const { io, saves } = scripted(["s", "7", "x", "3"]);
    expect(await runLabeling(pairs, file, CORPUS, io)).toBe(1);
    expect(file.labels.g1![pairs[0]!.file]).toBeUndefined();
    expect(file.labels.g1![pairs[1]!.file]).toBe(3);
    expect(saves).toHaveLength(1);
  });
});
