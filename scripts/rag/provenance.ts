/**
 * provenance.ts — tie each stage-3 file to the file it was made from.
 *
 * answers record the hash of the contexts they answered from; grades record the hash of the
 * answers they graded. report.ts and agreement.ts refuse a pairing whose hashes do not match, so
 * new answers can never be scored with grades made for old ones, even when sentence counts agree.
 */

import { createHash } from "node:crypto";

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The server's version, or "unknown" when the endpoint does not answer. Recorded, never required. */
export async function ollamaVersion(host: string): Promise<string> {
  try {
    const res = await fetch(`${host.replace(/\/$/, "")}/api/version`);
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : "unknown";
  } catch {
    return "unknown";
  }
}
