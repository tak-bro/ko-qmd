/**
 * mcp — `qmd-jev mcp`: an MCP stdio server exposing one `query` tool over
 * the same `runQuery` the CLI uses, so gate, consent and fail-open behaviour
 * cannot fork between the two front doors. Speaks the same SDK transport as
 * `qmd mcp`, so a client configured for one can point at the other.
 *
 * Concurrency: MCP clients may keep several calls in flight, and the Jev
 * client is shared. When the breaker trips mid-flight, every in-flight call
 * still resolves — the gate's failure path is qmd's fused order, never a
 * throw — and `claimTripNotice` guarantees the notice is emitted exactly
 * once per process, to whichever call claims it first.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { allowedCollections } from "./consent.js";
import { createJev, type JevClient } from "./jev.js";
import type { JevDeps } from "./jev.js";
import { appendQueryLog, logEntry, logSinkFromEnv, type LineSink } from "./log.js";
import { toText, toJson, type EmptyReason, type JevHit } from "./present.js";
import { runQuery, type GateStats, type RetrievalStore } from "./run-query.js";

/** What one tool call needs — the seams tests inject. */
export interface QueryToolDeps {
	store: RetrievalStore;
	jev: JevClient;
	/** Collections Jev may be told about (the consent allowlist). */
	allowed: string[];
	/** QMD_JEV_LOG sink, or null for no logging. */
	log: LineSink | null;
	/** Where the trip notice and jev-failure line go; stderr in production. */
	notify: (line: string) => void;
}

export interface QueryToolInput {
	query: string;
	collections?: string[];
	limit?: number;
	explain?: boolean;
	expand?: boolean;
	route?: "full" | "jev";
}

/** The tool result: human text plus the structured hit array MCP clients read. (A `type`, not an `interface` — the SDK's callback result carries an index signature.) */
export type QueryToolResult = {
	content: { type: "text"; text: string }[];
	structuredContent: {
		hits: JevHit[];
		emptyReason?: EmptyReason;
		jevFailure?: number | "timeout" | "network" | "parse";
		gate?: GateStats;
		retrieval?: "lex" | "vec" | "full";
	};
}

/** One `query` call, transport-free. Resolves always; throws only for store failures, like the CLI. */
export const handleQuery = async (deps: QueryToolDeps, input: QueryToolInput): Promise<QueryToolResult> => {
	const outcome = await runQuery(deps.store, input.query, {
		collections: input.collections,
		limit: input.limit,
		expand: input.expand,
		explain: input.explain,
		route: input.route,
		jev: deps.jev,
		allowed: deps.allowed,
	});
	if (outcome.jevFailure !== undefined) {
		deps.notify(`jev: no answer (${outcome.jevFailure}) — results are in qmd's order, unranked`);
	}
	const notice = deps.jev.claimTripNotice();
	if (notice !== null) deps.notify(notice);
	if (deps.log) appendQueryLog(deps.log, logEntry(input.query, outcome));
	const { hits, emptyReason, jevFailure, gate, retrieval } = outcome;
	return {
		content: [{ type: "text", text: toText(outcome, input.explain === true) }],
		structuredContent: {
			hits: toJson(outcome),
			...(emptyReason !== undefined ? { emptyReason } : {}),
			...(jevFailure !== undefined ? { jevFailure } : {}),
			...(gate !== undefined ? { gate } : {}),
			...(retrieval !== undefined ? { retrieval } : {}),
		},
	};
};

/** The MCP server: one tool, `query`, over `handleQuery`. */
export const createQueryServer = (deps: QueryToolDeps): McpServer => {
	const server = new McpServer({ name: "qmd-jev", version: "0.1.0" });
	server.registerTool(
		"query",
		{
			title: "Query",
			description:
				"Search the qmd knowledge base: hybrid retrieval in qmd's own fused order, and — when Jev is " +
				"configured and the collection is consented — a relevance gate that drops hits that are not " +
				"about the query. Each hit carries `line`, the absolute 1-indexed line of the best match; read " +
				"more context from the source document around that line. Jev being down never fails the tool: " +
				"the answer comes back in qmd's order, marked unranked.",
			inputSchema: {
				query: z.string().describe("The search query — natural language or keywords"),
				collections: z.array(z.string()).optional().describe("Restrict the search to these collection names"),
				limit: z.number().int().positive().optional().describe("Max results (default 10)"),
				explain: z.boolean().optional().describe("Include dropped hits with their relevance score, for calibration"),
				expand: z.boolean().optional().describe("Use qmd's own LLM query expansion (slower; see the package README)"),
				route: z.enum(["full", "jev"]).optional().describe("jev: one choice question about the query picks lex / vec / full retrieval (default full)"),
			},
		},
		async (input: QueryToolInput) => handleQuery(deps, input),
	);
	return server;
};

/** Real wiring: SDK store + live Jev client + stdio transport + stdin-EOF shutdown. The db path is a parameter, not an import — the CLI entry is a top-level-await module, and importing it from here would deadlock on its evaluation. Resolves when the client disconnects. */
export const startQueryServer = async (deps: JevDeps, dbPath: string): Promise<void> => {
	const { createStore } = await import("ko-qmd");
	const store = await createStore({ dbPath });
	const toolDeps: QueryToolDeps = {
		store,
		jev: createJev(deps),
		allowed: allowedCollections(deps.env),
		log: logSinkFromEnv(deps.env),
		notify: (line) => console.error(line),
	};
	const handle = serveStdio(() => createQueryServer(toolDeps));
	// The SDK transport does not watch for EOF; when the client goes, close and
	// resolve so the entry's process.exit fires after the server is done, not
	// before it starts serving.
	return new Promise<void>((resolve) => {
		process.stdin.once("end", () => {
			handle.close();
			resolve();
		});
	});
};
