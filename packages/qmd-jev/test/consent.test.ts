/**
 * consent — `QMD_JEV_COLLECTIONS`, the only thing that decides whether a
 * collection's content may be described to Jev. Unset means off: an allowlist
 * fails closed, a denylist would fail open on the next collection nobody listed.
 */
import { describe, expect, it } from "bun:test";
import { allowedCollections } from "../src/consent.js";

describe("allowedCollections", () => {
	it("is off when unset — no collection may be described", () => {
		expect(allowedCollections({})).toEqual([]);
		expect(allowedCollections({ QMD_JEV_COLLECTIONS: undefined })).toEqual([]);
	});

	it("is off when empty or whitespace-only", () => {
		expect(allowedCollections({ QMD_JEV_COLLECTIONS: "" })).toEqual([]);
		expect(allowedCollections({ QMD_JEV_COLLECTIONS: "  ,  , " })).toEqual([]);
	});

	it("parses comma-separated names, trimming each", () => {
		expect(allowedCollections({ QMD_JEV_COLLECTIONS: " notes ,journals" })).toEqual([
			"notes",
			"journals",
		]);
	});

	it("drops duplicate names", () => {
		expect(allowedCollections({ QMD_JEV_COLLECTIONS: "a, a ,b" })).toEqual(["a", "b"]);
	});
});
