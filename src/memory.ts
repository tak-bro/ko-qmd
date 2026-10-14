/**
 * memory.ts — shared second-brain write/read core (slice 03).
 *
 * Thin and pure by design: validation, filename derivation, document
 * rendering, and collection jailing live here so both the MCP tools
 * (`src/mcp/server.ts`) and the write eval (`recall-write.sh` rule mirror)
 * share one rule set. File I/O and search stay with the callers.
 *
 * Storage contract: one claim per file under the `mem` collection,
 * machine fields in `qmd.metadata` (see knowledge-base CLAUDE.md
 * § provenance), human claim in the body. Corrections never edit —
 * a new file carries `supersedes`, the old file keeps a footer.
 */

import YAML from "yaml";

export const MEMORY_COLLECTION = "mem";
export const MEMORY_MAX_CHARS = 8000;
export const MEMORY_MAX_SOURCE_CHARS = 500;
export const MEMORY_MAX_ACTOR_CHARS = 80;
export const MEMORY_MAX_REASON_CHARS = 500;
/** Tool-derived names only; the optional rand4 segment predates collision hardening. */
export const MEMORY_FILENAME_RE = /^\d{8}-\d{6}-(?:[0-9a-f]{4}-)?[0-9a-f]{8}\.md$/;
const SUPERSEDED_MARKER = "> superseded_by:";
const SUPERSEDED_LINE_RE = /^> superseded_by: (\S+\.md) — /m;

export type MemoryType = "fact" | "opinion" | "decision";

export interface MemoryStoreInput {
  text: string;
  actor: string;
  type: MemoryType;
  source?: string;
  project?: string;
  confidence?: number;
}

export type MemoryValidation = { ok: true } | { ok: false; error: string; rule: string };

const SECRET_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, label: "private key" },
  { pattern: /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}/, label: "api key" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{8,}\b/, label: "github token" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{8,}/, label: "github token" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, label: "aws key" },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}/, label: "google api key" },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/, label: "slack token" },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/, label: "jwt" },
  // A literal value (letters + digits, 8+) — not a type name, `$VAR`, `${…}`, or `process.env.X`.
  { pattern: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"]?(?!\$|process\.env)(?=[^\s'"]*\d)(?=[^\s'"]*[A-Za-z])[^\s'"]{8,}/i, label: "credential assignment" },
];

/** A located source: URL, a path, `file.ext[:line]`, `session:<id>`, or `#<id>`. Bare words are not provenance. */
const SOURCE_LOCATOR_RE = /^[a-z][a-z0-9+.-]*:\/\/\S|\/|[\w-]{2,}\.[A-Za-z][A-Za-z0-9]{0,7}\b|\bsession:\S|#\d+/i;

function findSecret(values: readonly unknown[]): string | undefined {
  const haystacks = values.filter((v): v is string => typeof v === "string");
  for (const { pattern, label } of SECRET_PATTERNS) {
    if (haystacks.some(h => pattern.test(h))) return label;
  }
  return undefined;
}

function hasReservedMarker(text: string): boolean {
  return text.split("\n").some(line => line.trimStart().startsWith(SUPERSEDED_MARKER));
}

/**
 * Claim-lint, rule ids R1..R6 (scored by scripts/eval/recall-write.sh).
 * Rejects caller-fixable input; never throws on unknown shapes.
 */
export function validateMemoryStoreInput(input: unknown): MemoryValidation {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "input must be an object", rule: "R1" };
  }
  // JSON callers send explicit null for absent optionals — treat as absent.
  const raw = input as Record<string, unknown>;
  const nonNull = (v: unknown): unknown => (v === null ? undefined : v);
  const { text, actor, type } = raw;
  const source = nonNull(raw["source"]);
  const project = nonNull(raw["project"]);
  const confidence = nonNull(raw["confidence"]);

  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, error: "text is required", rule: "R1" };
  }
  if (text.length > MEMORY_MAX_CHARS) {
    return { ok: false, error: `text exceeds ${MEMORY_MAX_CHARS} chars`, rule: "R3" };
  }
  if (typeof actor !== "string" || actor.trim().length === 0) {
    return { ok: false, error: "actor is required (user | agent:<name>)", rule: "R1" };
  }
  if (actor.length > MEMORY_MAX_ACTOR_CHARS || /[/\\\u0000-\u001f\u007f]/.test(actor)) {
    return { ok: false, error: "actor must be a flat name without path separators", rule: "R3" };
  }
  if (type !== "fact" && type !== "opinion" && type !== "decision") {
    return { ok: false, error: "type must be fact | opinion | decision", rule: "R1" };
  }
  if ((type === "fact" || type === "decision") && (typeof source !== "string" || source.trim().length === 0)) {
    return { ok: false, error: `${type} requires source`, rule: "R2" };
  }
  if (source !== undefined && (typeof source !== "string" || source.length > MEMORY_MAX_SOURCE_CHARS || /[\u0000-\u001f\u007f]/.test(source))) {
    return { ok: false, error: `source must be a single line ≤ ${MEMORY_MAX_SOURCE_CHARS} chars`, rule: "R3" };
  }
  if ((type === "fact" || type === "decision") && !SOURCE_LOCATOR_RE.test(source as string)) {
    return { ok: false, error: "source must be locatable: file:line, path, URL, session:<id>, or #<id>", rule: "R2" };
  }
  if (project !== undefined && typeof project !== "string") {
    return { ok: false, error: "project must be a string", rule: "R1" };
  }
  if (typeof project === "string" && (project.length > MEMORY_MAX_ACTOR_CHARS || /[\u0000-\u001f\u007f]/.test(project))) {
    return { ok: false, error: `project must be a single line ≤ ${MEMORY_MAX_ACTOR_CHARS} chars`, rule: "R3" };
  }
  if (confidence !== undefined && (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    return { ok: false, error: "confidence must be a number in 0..1", rule: "R5" };
  }
  const secret = findSecret([text, actor, source, project]);
  if (secret !== undefined) {
    return { ok: false, error: `rejected: looks like a ${secret} — never store secrets`, rule: "R4" };
  }
  if (hasReservedMarker(text)) {
    return { ok: false, error: `text must not contain a '${SUPERSEDED_MARKER}' line — only memory_correct writes it`, rule: "R6" };
  }
  return { ok: true };
}

/**
 * Correction preconditions (R6 supersedes chain, plus reason hygiene).
 * The old doc must not already be superseded — correct the newest link instead,
 * so the chain stays linear. The reason lands in the old file, so it is one line.
 */
export function validateCorrection(oldBody: string, reason: unknown): MemoryValidation {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return { ok: false, error: "reason is required", rule: "R1" };
  }
  if (reason.length > MEMORY_MAX_REASON_CHARS || /[\u0000-\u001f\u007f]/.test(reason)) {
    return { ok: false, error: `reason must be a single line ≤ ${MEMORY_MAX_REASON_CHARS} chars`, rule: "R3" };
  }
  const secret = findSecret([reason]);
  if (secret !== undefined) {
    return { ok: false, error: `rejected: reason looks like a ${secret} — never store secrets`, rule: "R4" };
  }
  const already = parseSupersededBy(oldBody);
  if (already !== undefined) {
    return { ok: false, error: `already superseded by ${MEMORY_COLLECTION}/${already} — correct that file instead`, rule: "R6" };
  }
  return { ok: true };
}

/** The newer file a mem doc points to via its footer, or undefined when it is current. */
export function parseSupersededBy(body: string): string | undefined {
  return SUPERSEDED_LINE_RE.exec(body)?.[1];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `YYYYMMDD-HHMMSS-<rand4>-<hash8>.md`, derived — callers never take a filename.
 * The random segment keeps same-second/same-text writes from colliding. */
export function buildMemoryFilename(now: Date, text: string): string {
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  }
  const suffix = (hash >>> 0).toString(16).padStart(8, "0");
  const rand = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${stamp}-${rand}-${suffix}.md`;
}

/** Full markdown: YAML frontmatter (qmd.metadata) + `# title` + claim body. */
export function renderMemoryDoc(input: MemoryStoreInput, opts?: { supersedes?: string }): string {
  const metadata: Record<string, string | number> = {
    actor: input.actor,
    type: input.type,
  };
  if (input.project !== undefined) metadata["project"] = input.project;
  if (input.source !== undefined) metadata["source"] = input.source;
  if (input.confidence !== undefined) metadata["confidence"] = input.confidence;
  if (opts?.supersedes !== undefined) metadata["supersedes"] = opts.supersedes;
  const frontmatter = YAML.stringify({ qmd: { metadata } }).trimEnd();
  const title = input.text.split("\n", 1)[0]?.slice(0, 60) ?? "memory";
  return `---\n${frontmatter}\n---\n\n# ${title}\n\n${input.text}\n`;
}

/** Append-only correction marker for the superseded file. History stays. */
export function renderSupersededFooter(newFile: string, reason: string): string {
  return `\n\n${SUPERSEDED_MARKER} ${newFile} — ${reason}\n`;
}

/**
 * Jail a caller-supplied ref inside the mem dir. Tool-derived filenames only
 * (MEMORY_FILENAME_RE) — no subdirs, traversal, README, or hand-named files.
 * Returns the absolute path or null (reject). Symlinks are the caller's
 * check: this stays pure.
 */
export function resolveInCollection(memDir: string, ref: string): string | null {
  if (typeof ref !== "string" || !MEMORY_FILENAME_RE.test(ref)) return null;
  return `${memDir.replace(/\/+$/, "")}/${ref}`;
}

export const VECTORS_STALE_NOTICE = "lex-searchable now; vectors need `qmd embed -c mem`";

/** Store/correct success receipt — vectors_stale is always true at write time. */
export function buildStoreReceipt(filename: string, supersedes?: string): {
  ok: true;
  file: string;
  vectors_stale: true;
  notice: string;
  supersedes?: string;
} {
  return {
    ok: true,
    file: `${MEMORY_COLLECTION}/${filename}`,
    vectors_stale: true,
    notice: VECTORS_STALE_NOTICE,
    ...(supersedes !== undefined ? { supersedes: `${MEMORY_COLLECTION}/${supersedes}` } : {}),
  };
}
