/**
 * qmd-jev CLI. `doctor` now; `query` (slice 02) and `mcp` (slice 04) land
 * with their slices — the usage text only advertises what runs.
 */
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { allowedCollections } from "./consent.js";
import { keyFrom, MODEL, probeModel } from "./jev.js";
import type { JevDeps } from "./jev.js";

const USAGE = `qmd-jev — Jev-ranked search over qmd collections (pre-release)

usage:
  qmd-jev doctor        is Jev configured, and does the pinned model still answer?

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

export const main = async (argv: string[]): Promise<number> => {
	const [cmd] = argv;
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
