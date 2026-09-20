/**
 * log — the query record. Pure assembly and sink behaviour: no store, no
 * network, and the file sink is pointed at a temp dir.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appendQueryLog, fileLineSink, logEntry, logSinkFromEnv, type QueryLogEntry } from "../src/log.js";
import type { QueryOutcome } from "../src/run-query.js";

const jevHit = (file: string, noul?: number, kept?: boolean) => ({
	docid: file.slice(0, 6),
	file,
	title: file,
	score: 1,
	context: null,
	line: 1,
	snippet: `snippet of ${file}`,
	chunk: `chunk of ${file}`,
	...(noul !== undefined ? { noul } : {}),
	...(kept !== undefined ? { kept } : {}),
});

const outcome = (over: Partial<QueryOutcome> = {}): QueryOutcome => ({
	hits: over.hits ?? [jevHit("qmd://notes/a.md")],
	...(over.emptyReason !== undefined ? { emptyReason: over.emptyReason } : {}),
	...(over.jevFailure !== undefined ? { jevFailure: over.jevFailure } : {}),
	...(over.gate !== undefined ? { gate: over.gate } : {}),
	...(over.judged !== undefined ? { judged: over.judged } : {}),
	...(over.retrieval !== undefined ? { retrieval: over.retrieval } : {}),
});

describe("logEntry — what one line records", () => {
	it("a gated query records route jev, the model, the gate counts, and every judged hit's noul and kept", () => {
		const judged = [
			jevHit("qmd://notes/kept.md", 0.9, true),
			jevHit("qmd://notes/dropped.md", 0.1, false),
		];
		const entry = logEntry("pool sizing", outcome({
			gate: { scored: 2, dropped: 1, model: "jev-1.13.0" },
			judged,
			hits: [judged[0]!],
		}));
		expect(entry.route).toBe("jev");
		expect(entry.model).toBe("jev-1.13.0");
		expect(entry.scored).toBe(2);
		expect(entry.dropped).toBe(1);
		expect(entry.hits).toEqual([
			{ file: "qmd://notes/kept.md", docid: "qmd://", noul: 0.9, kept: true },
			{ file: "qmd://notes/dropped.md", docid: "qmd://", noul: 0.1, kept: false },
		]);
	});

	it("a fail-open query records route qmd and the failure — status or category, never a message", () => {
		const entry = logEntry("q", outcome({ jevFailure: "timeout" }));
		expect(entry.route).toBe("qmd");
		expect(entry.failure).toBe("timeout");
		expect(entry.model).toBeUndefined();
	});

	it("records the chosen retrieval route when --route jev chose one", () => {
		const entry = logEntry("q", outcome({ retrieval: "lex" }));
		expect(entry.retrieval).toBe("lex");
		expect(logEntry("q", outcome({})).retrieval).toBeUndefined();
	});

	it("a plain (gate off) query records route qmd with bare hits — no noul, no kept", () => {
		const entry = logEntry("q", outcome({}));
		expect(entry.route).toBe("qmd");
		expect(entry.failure).toBeUndefined();
		expect(entry.hits).toEqual([{ file: "qmd://notes/a.md", docid: "qmd://" }]);
	});

	it("without judged, a gated outcome logs the shown hits — never a crash", () => {
		const entry = logEntry("q", outcome({ gate: { scored: 1, dropped: 0, model: "m" } }));
		expect(entry.hits).toHaveLength(1);
	});
});

describe("appendQueryLog / sinks", () => {
	it("writes one JSON line per entry", () => {
		const lines: string[] = [];
		appendQueryLog((line) => lines.push(line), logEntry("q", outcome({})));
		expect(lines).toHaveLength(1);
		const parsed: QueryLogEntry = JSON.parse(lines[0]!);
		expect(parsed.query).toBe("q");
	});

	it("a throwing sink never propagates — a log write must not fail a query", () => {
		expect(() => appendQueryLog(() => { throw new Error("disk full"); }, logEntry("q", outcome({})))).not.toThrow();
	});

	it("the file sink appends a line and survives an unwritable path silently", () => {
		const dir = join(import.meta.dir, ".tmp-log-test");
		const path = join(dir, "log.jsonl");
		rmSync(dir, { recursive: true, force: true });
		const sink = fileLineSink(path);
		appendQueryLog(sink, logEntry("first", outcome({})));
		appendQueryLog(sink, logEntry("second", outcome({})));
		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1]!).query).toBe("second");
		// an impossible path (a file where a directory is wanted) is swallowed
		mkdirSync(dir, { recursive: true });
		const blocked = fileLineSink(path + "/x/y"); // path is a file → mkdir/append fail
		expect(() => appendQueryLog(blocked, logEntry("blocked", outcome({})))).not.toThrow();
		rmSync(dir, { recursive: true, force: true });
	});

	it("logSinkFromEnv: QMD_JEV_LOG set → a sink, unset or empty → null", () => {
		expect(logSinkFromEnv({ QMD_JEV_LOG: "/tmp/x.jsonl" })).not.toBeNull();
		expect(logSinkFromEnv({})).toBeNull();
		expect(logSinkFromEnv({ QMD_JEV_LOG: "" })).toBeNull();
	});
});

describe("the key never reaches the log", () => {
	it("an entry built from an outcome carries no key material, even with a key in the env", () => {
		const lines: string[] = [];
		// The outcome is what logEntry sees; the key (env or file) never enters one.
		process.env.TYPESAFE_API_KEY = "sk-secret-key-for-log-test";
		try {
			appendQueryLog((l) => lines.push(l), logEntry("q", outcome({ jevFailure: 500 })));
		} finally {
			delete process.env.TYPESAFE_API_KEY;
		}
		expect(lines.join("\n")).not.toContain("sk-secret-key-for-log-test");
	});
});
