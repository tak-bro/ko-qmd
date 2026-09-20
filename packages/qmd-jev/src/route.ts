/**
 * chooseRoute — `--route jev`. One Jev `choice` question about the query
 * alone picks the retrieval route: `lex` (exact-term search), `vec`
 * (meaning search), or `full` (both, today's composition). The state
 * carries the query text and nothing else — no collection content has been
 * retrieved yet, so no consent question has even arisen.
 *
 * Anything other than one of the three known choices — silence, a wrong
 * answer type, a hallucinated choice — falls back to `full`. Fail-open is
 * the same contract as the gate: a routing question must never cost the
 * caller their answer.
 */
import type { Ask } from "./jev.js";

export type RetrievalRoute = "lex" | "vec" | "full";

export const ROUTE_CRITERIA: Record<RetrievalRoute, string> = {
	lex: "exact terms, identifiers, error strings, code symbols — word-for-word search",
	vec: "concept or meaning search, where wording likely differs from the documents",
	full: "unclear or mixed — search both ways",
};

const isRoute = (value: string): value is RetrievalRoute => value === "lex" || value === "vec" || value === "full";

export const chooseRoute = async (ask: Ask, query: string): Promise<RetrievalRoute> => {
	const result = await ask(
		{ query },
		{
			route: {
				type: "choice",
				instructions:
					"Pick how to search a local knowledge base for this query. Reply with exactly one choice.",
				criteria: ROUTE_CRITERIA,
			},
		},
	);
	const answer = result?.answers.route;
	const choice = answer?.type === "choice" ? answer.choice : "";
	return isRoute(choice) ? choice : "full";
};
