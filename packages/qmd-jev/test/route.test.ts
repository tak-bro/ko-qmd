/**
 * chooseRoute — `--route jev`: one Jev `choice` question about the query
 * alone picks lex / vec / full. Silence, a wrong answer type, or an unknown
 * choice all fall back to `full`. The state carries the query text and
 * nothing else — no collection content, because no consent question has
 * even arisen yet.
 */
import { describe, expect, it } from "bun:test";
import { chooseRoute, ROUTE_CRITERIA } from "../src/route.js";
import type { Ask, Answers, JevResult, Json, Questions } from "../src/jev.js";

const asking = (answers: Answers | null, model = "jev-test"): { ask: Ask; requests: { state: Json; questions: Questions }[] } => {
	const requests: { state: Json; questions: Questions }[] = [];
	const ask: Ask = async (state, questions) => {
		requests.push({ state, questions });
		if (answers === null) return null;
		const result: JevResult = { answers, model };
		return result;
	};
	return { ask, requests };
};

const choice = (c: string): Answers => ({ route: { type: "choice", choice: c, confidence: 0.9 } });

describe("chooseRoute", () => {
	it("maps each known choice to its route", async () => {
		expect(await chooseRoute(asking(choice("lex")).ask, "q")).toBe("lex");
		expect(await chooseRoute(asking(choice("vec")).ask, "q")).toBe("vec");
		expect(await chooseRoute(asking(choice("full")).ask, "q")).toBe("full");
	});

	it("asks exactly one choice question, with the criteria for lex / vec / full", async () => {
		const { ask, requests } = asking(choice("lex"));
		await chooseRoute(ask, "connection pool");
		expect(requests).toHaveLength(1);
		const question = requests[0]!.questions.route;
		expect(question.type).toBe("choice");
		expect(question.type === "choice" && Object.keys(question.criteria)).toEqual(["lex", "vec", "full"]);
		expect(ROUTE_CRITERIA.lex).toContain("exact");
		expect(ROUTE_CRITERIA.vec).toContain("meaning");
	});

	it("sends the query alone — no collection content in the state", async () => {
		const { ask, requests } = asking(choice("lex"));
		await chooseRoute(ask, "connection pool sizing");
		expect(requests[0]!.state).toEqual({ query: "connection pool sizing" });
	});

	it("silence falls back to full", async () => {
		expect(await chooseRoute(asking(null).ask, "q")).toBe("full");
	});

	it("an unknown choice, a non-choice answer, or a missing answer falls back to full", async () => {
		expect(await chooseRoute(asking(choice("hybrid")).ask, "q")).toBe("full");
		expect(await chooseRoute(asking({ route: { type: "noul", noul: 0.9 } }).ask, "q")).toBe("full");
		expect(await chooseRoute(asking({}).ask, "q")).toBe("full");
	});
});
