/**
 * consent — `QMD_JEV_COLLECTIONS`, the only thing that decides whether a
 * collection's content may be described to Jev.
 *
 * The unit of content in qmd is the collection, and the vendor offers zero
 * data retention to enterprise customers only, so consent is an allowlist:
 * it fails closed on a collection nobody listed — a denylist would fail open
 * on the next one. Unset means off.
 */

export type Env = Record<string, string | undefined>;

/** The collection name in a hit's `file` (`qmd://collection/path`); empty when the path is not a collection URI. */
export const collectionOf = (file: string): string =>
	file.startsWith("qmd://") ? (file.slice("qmd://".length).split("/")[0] ?? "") : "";

/** The collections Jev may be told about: comma-separated names, unset or empty = none. */
export const allowedCollections = (env: Env): string[] => {
	const listed = (env.QMD_JEV_COLLECTIONS ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
	return [...new Set(listed)];
};
