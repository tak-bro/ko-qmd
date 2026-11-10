import { describe, expect, test } from "vitest";
import { answerQuestion, parseAnswer, PROMPTS, renderAnswer, userPrompt } from "../scripts/rag/answer.js";
import { gradeAnswer, gradeSentence, parseGrade, stripInlineCitations, UNCITED } from "../scripts/rag/grade.js";
import { toChunks } from "../scripts/rag/retrieve.js";
import type { HybridQueryResult } from "../src/index.js";

const chunks = [
  { file: "wiki/a.md", title: "A", text: "에이 본문" },
  { file: "wiki/b.md", title: "B", text: "비 본문" },
];

describe("answer prompts", () => {
  test("grounded is baseline plus the grounding rules", () => {
    for (const line of PROMPTS.baseline.split("\n")) expect(PROMPTS.grounded).toContain(line);
    expect(PROMPTS.grounded).toMatch(/상식이나 배경지식/);
    expect(PROMPTS.baseline).not.toMatch(/상식이나 배경지식/);
  });

  test("narrow replaces grounded's abstain rule with a paraphrase rule and a narrower abstain rule", () => {
    const grounded = PROMPTS.grounded.split("\n");
    const narrow = PROMPTS.narrow.split("\n");
    const abstain = grounded.filter(l => l.includes("주제가 비슷한 문서가 있어도"));
    expect(abstain).toHaveLength(1);
    expect(narrow.filter(l => !grounded.includes(l))).toHaveLength(2);
    expect(grounded.filter(l => !narrow.includes(l))).toEqual(abstain);
  });

  test("user prompt numbers the chunks from 1", () => {
    expect(userPrompt("질문?", chunks)).toBe("질문: 질문?\n\n문서:\n[1] A\n에이 본문\n\n[2] B\n비 본문");
    expect(userPrompt("질문?", [])).toMatch(/검색된 문서 없음/);
  });
});

describe("parseAnswer", () => {
  test("accepts cited sentences, drops blank ones and duplicate citations", () => {
    const r = parseAnswer('{"unknown":false,"sentences":[{"text":" 하나 ","citations":[1,1,2]},{"text":"","citations":[]}]}', 2);
    expect(r).toEqual({ answer: { unknown: false, sentences: [{ text: "하나", citations: [1, 2] }] } });
  });

  test("an abstention keeps no sentences even if the model wrote some, valid or not", () => {
    expect(parseAnswer('{"unknown":true,"sentences":[{"text":"아마도","citations":[1]}]}', 2)).toEqual({ answer: { unknown: true, sentences: [] } });
    expect(parseAnswer('{"unknown":true,"sentences":[{"text":"x","citations":[9]}]}', 2)).toEqual({ answer: { unknown: true, sentences: [] } });
  });

  test.each([
    ["not json", /not JSON/],
    ['{"sentences":[]}', /unknown is not a boolean/],
    ['{"unknown":false,"sentences":[]}', /no sentences/],
    ['{"unknown":false,"sentences":[{"text":"x","citations":[3]}]}', /citation 3 is not a document number 1-2/],
    ['{"unknown":false,"sentences":[{"text":"x","citations":[1.5]}]}', /citation 1.5/],
    ['{"unknown":false,"sentences":[{"text":"x"}]}', /lacks text or citations/],
    ["null", /reply is not an object/],
    ['{"unknown":false,"sentences":{}}', /sentences is not an array/],
  ])("rejects %s", (reply, reason) => {
    const r = parseAnswer(reply, 2);
    expect("reason" in r && r.reason).toMatch(reason);
  });
});

describe("answerQuestion", () => {
  test("retries once with the reason, then throws", async () => {
    const users: string[] = [];
    const bad = async (_s: string, u: string) => (users.push(u), '{"unknown":false,"sentences":[]}');
    await expect(answerQuestion("q", chunks, "baseline", bad)).rejects.toThrow(/invalid twice: unknown is false but there are no sentences/);
    expect(users).toHaveLength(2);
    expect(users[1]).toMatch(/형식에 맞지 않았다/);
  });

  test("sends the variant's system prompt", async () => {
    let system = "";
    const chat = async (s: string) => ((system = s), '{"unknown":true,"sentences":[]}');
    expect(await answerQuestion("q", chunks, "grounded", chat)).toEqual({ unknown: true, sentences: [] });
    expect(system).toBe(PROMPTS.grounded);
  });
});

describe("renderAnswer", () => {
  test("marks citations inline and lists cited sources once, in number order", () => {
    const text = renderAnswer({ unknown: false, sentences: [{ text: "첫째.", citations: [2] }, { text: "둘째.", citations: [1, 2] }] }, chunks);
    expect(text).toBe("첫째. [2] 둘째. [1] [2]\n\n[1] A (wiki/a.md)\n[2] B (wiki/b.md)");
  });

  test("an abstention says 모른다", () => {
    expect(renderAnswer({ unknown: true, sentences: [] }, chunks)).toMatch(/^모른다/);
  });
});

describe("toChunks", () => {
  test("keeps the top k as corpus paths with the best chunk, falling back to the body", () => {
    const r = (file: string, bestChunk: string): HybridQueryResult => JSON.parse(JSON.stringify({ file, title: file, body: "body", bestChunk }));
    expect(toChunks([r("qmd://ko-vault/wiki/a.md", " best "), r("qmd://ko-vault/wiki/b.md", ""), r("qmd://ko-vault/wiki/c.md", "c")], 2)).toEqual([
      { file: "wiki/a.md", title: "qmd://ko-vault/wiki/a.md", text: "best" },
      { file: "wiki/b.md", title: "qmd://ko-vault/wiki/b.md", text: "body" },
    ]);
  });
});

describe("parseGrade", () => {
  test("accepts one verdict per cited chunk", () => {
    expect(parseGrade('{"support":"partial","citations":[{"n":2,"supports":false},{"n":1,"supports":true}]}', [1, 2])).toEqual({
      grade: { support: "partial", citations: { "1": true, "2": false }, uncited: false },
    });
  });

  test.each([
    ['{"support":"yes","citations":[]}', /not full, partial or none/],
    ['{"support":"full","citations":[{"n":3,"supports":true}]}', /citation 3 was not cited/],
    ['{"support":"full","citations":[{"n":1,"supports":true},{"n":1,"supports":true}]}', /judged twice/],
    ['{"support":"full","citations":[{"n":1}]}', /no boolean supports/],
    ['{"support":"full","citations":[{"n":1,"supports":true}]}', /missing citations 2/],
    ["[]", /not full, partial or none/],
    ["not json", /reply is not JSON/],
    ['{"support":"full","citations":{}}', /citations is not an array/],
  ])("rejects %s", (reply, reason) => {
    const r = parseGrade(reply, [1, 2]);
    expect("reason" in r && r.reason).toMatch(reason);
  });
});

describe("gradeSentence", () => {
  test("a citation outside the retrieved chunks throws before any judge call", async () => {
    let calls = 0;
    const chat = async () => (calls++, "");
    await expect(gradeSentence("q", { text: "x", citations: [3] }, chunks, "rubric", chat)).rejects.toThrow(/citation 3 is outside the 2 retrieved chunks/);
    expect(calls).toBe(0);
  });

  test("an uncited sentence is unsupported without a judge call", async () => {
    let calls = 0;
    const chat = async () => (calls++, "");
    expect(await gradeSentence("q", { text: "x", citations: [] }, chunks, "rubric", chat)).toEqual(UNCITED);
    expect(calls).toBe(0);
  });

  test("the judge sees only the cited chunks, renumbered from 1, and verdicts map back", async () => {
    let user = "";
    const chat = async (_s: string, u: string) => ((user = u), '{"support":"partial","citations":[{"n":1,"supports":true},{"n":2,"supports":false}]}');
    const grade = await gradeSentence("q", { text: "문장", citations: [2, 1] }, chunks, "rubric", chat);
    expect(user).toContain("[1] B\n비 본문\n\n[2] A\n에이 본문");
    expect(grade.citations).toEqual({ "2": true, "1": false });
    const lone = async (_s: string, u: string) => ((user = u), '{"support":"full","citations":[{"n":1,"supports":true}]}');
    expect((await gradeSentence("q", { text: "비 문장", citations: [2] }, chunks, "rubric", lone)).citations).toEqual({ "2": true });
    expect(user).not.toContain("에이 본문");
  });

  test("inline citation markers in the sentence are not shown to the judge", async () => {
    let user = "";
    const chat = async (_s: string, u: string) => ((user = u), '{"support":"full","citations":[{"n":1,"supports":true}]}');
    await gradeSentence("q", { text: "비 문장이다. [2]", citations: [2] }, chunks, "rubric", chat);
    expect(user).toContain("판정할 문장: 비 문장이다.\n");
    expect(stripInlineCitations("가다. [1, 2, 5]")).toBe("가다.");
    expect(stripInlineCitations("가다 [1], 나다[3].")).toBe("가다, 나다.");
    expect(stripInlineCitations("필요하다. citations: [1]")).toBe("필요하다.");
    expect(stripInlineCitations("배열 a[0] 의 값")).toBe("배열 a[0] 의 값");
    expect(stripInlineCitations("가[1]나")).toBe("가[1]나");
    expect(stripInlineCitations("[2]")).toBe("[2]");
  });

  test("gradeAnswer grades every sentence in order and throws after two bad replies", async () => {
    const replies = ['{"support":"full","citations":[{"n":1,"supports":true}]}'];
    const ok = async () => replies[0]!;
    const grades = await gradeAnswer("q", { unknown: false, sentences: [{ text: "a", citations: [1] }, { text: "b", citations: [] }] }, chunks, "r", ok);
    expect(grades.map(g => g.support)).toEqual(["full", "none"]);
    await expect(gradeSentence("q", { text: "a", citations: [1] }, chunks, "r", async () => "x")).rejects.toThrow(/invalid twice/);
  });
});
