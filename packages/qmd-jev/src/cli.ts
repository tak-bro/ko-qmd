/**
 * qmd-jev CLI. `doctor` and `query` run; `mcp` (slice 04) lands with its
 * slice — the usage text only advertises what runs.
 */
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createStore } from "ko-qmd";
import { allowedCollections } from "./consent.js";
import { keyFrom, MODEL, probeModel } from "./jev.js";
import type { JevDeps } from "./jev.js";
import { toText, toJson } from "./present.js";
import { runQuery } from "./run-query.js";

const USAGE = `qmd-jev — Jev-ranked search over qmd collections (pre-release)

usage:
  qmd-jev query [options] <query>   search: SDK retrieval, qmd's fused order (Jev ranking lands next)
  qmd-jev doctor                    is Jev configured, and does the pinned model still answer?

query options:
  -c, --collection <name>   restrict the search (repeatable)
  -n, --limit <num>         max results (default 10)
  --format <cli|json>       output format (default cli)

env:
  QMD_JEV_COLLECTIONS   comma-separated collections Jev may be told about; unset = off
  TYPESAFE_API_KEY      else ~/.config/typesafe/key
  QMD_JEV_TIMEOUT_MS    per-call deadline (default 2000)
`;

const realDeps = (): JevDeps => ({
	fetch: (url, init) => globalThis.fetch(url, init),
	env: process.env,
	readFile: (path) => readFileSync(path, "utf8"),
});

/**
 * Doctor's lines. Says `jev: off` when there is no key or no listed
 * collection, and — with a key — whether the pinned model still answers, so
 * a retired pin is visible before queries silently fall back forever. Never
 * the key itself, and never a vendor message: a failure is named by status
 * or category only.
 */
export const doctorLines = async (deps: JevDeps): Promise<string[]> => {
	const key = keyFrom(deps.env, deps.readFile);
	const collections = allowedCollections(deps.env);
	if (key === null) {
		return [
			"jev: off",
			"key: none — set TYPESAFE_API_KEY or create ~/.config/typesafe/key",
			collections.length > 0
				? `collections: ${collections.join(", ")} (listed, but no key)`
				: "collections: none listed — QMD_JEV_COLLECTIONS is unset or empty",
		];
	}
	const lines = [
		collections.length > 0 ? "jev: on" : "jev: off — no collections listed (QMD_JEV_COLLECTIONS)",
		`key: present (${deps.env.TYPESAFE_API_KEY?.trim() ? "env" : "file"})`,
	];
	if (collections.length > 0) lines.push(`collections: ${collections.join(", ")}`);
	const probe = await probeModel(deps);
	lines.push(
		probe?.answered
			? `model ${MODEL}: answers (served as ${probe.model})`
			: `model ${MODEL}: no answer (last: ${probe === null ? "none" : probe.failure})` +
					(probe !== null && probe.failure === 400 ? " — the pin may be retired; see README" : ""),
	);
	return lines;
};

export interface QueryArgs {
	query: string;
	collections?: string[];
	format: "cli" | "json";
	limit?: number;
}

/** Pure argv parser for `query` — the CLI seam tests hit instead of a store. `null` = usage error. */
export const parseQueryArgs = (argv: string[]): QueryArgs | null => {
	const args = argv.slice(1); // drop the command word
	const parsed: QueryArgs = { query: "", format: "cli" };
	for (let i = 0; i < args.length; i += 1) {
		const a = args[i]!;
		if (a === "-c" || a === "--collection") {
			const name = args[++i];
			if (!name) return null;
			(parsed.collections ??= []).push(name);
		} else if (a === "-n" || a === "--limit") {
			const n = Number(args[++i]);
			if (!Number.isInteger(n) || n <= 0) return null;
			parsed.limit = n;
		} else if (a === "--format") {
			const f = args[++i];
			if (f !== "cli" && f !== "json") return null;
			parsed.format = f;
		} else if (a.startsWith("-") || parsed.query) {
			return null;
		} else {
			parsed.query = a;
		}
	}
	return parsed.query ? parsed : null;
};

/**
 * The default index path, resolved here because the SDK does not export
 * `enableProductionMode` (its own CLI and MCP call it internally before
 * `getDefaultDbPath()` will answer) — and this package must not touch
 * ko-qmd's src/. Same precedence as the SDK: INDEX_PATH, then
 * XDG_CACHE_HOME or ~/.cache, then qmd/index.sqlite.
 */
const defaultIndexDbPath = (): string => {
	if (process.env.INDEX_PATH) return process.env.INDEX_PATH;
	const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
	const dir = join(cache, "qmd");
	mkdirSync(dir, { recursive: true });
	return join(dir, "index.sqlite");
};

export const main = async (argv: string[]): Promise<number> => {
	const [cmd] = argv;
	if (cmd === "query") {
		const args = parseQueryArgs(argv);
		if (args === null) {
			console.error("qmd-jev: bad query arguments");
			console.error(USAGE);
			return 2;
		}
		const store = await createStore({ dbPath: defaultIndexDbPath() });
		try {
			const outcome = await runQuery(store, args.query, {
				collections: args.collections,
				limit: args.limit,
			});
			if (args.format === "json") console.log(JSON.stringify(toJson(outcome), null, 2));
			else console.log(toText(outcome));
			return 0;
		} finally {
			await store.close();
		}
	}
	if (cmd === "doctor") {
		for (const line of await doctorLines(realDeps())) console.log(line);
		return 0;
	}
	if (cmd === "help" || cmd === "--help" || cmd === "-h") {
		console.log(USAGE);
		return 0;
	}
	console.error(cmd === undefined ? "qmd-jev: no command" : `qmd-jev: unknown command '${cmd}'`);
	console.error(USAGE);
	return 2;
};

// Run only when invoked directly (bin launcher or `bun src/cli.ts`), not when a test imports this module.
const invokedDirectly = (): boolean => {
	try {
		return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;
	} catch {
		return false;
	}
};

if (invokedDirectly()) process.exit(await main(process.argv.slice(2)));
