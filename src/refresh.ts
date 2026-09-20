/**
 * refresh.ts - keep the text index current for the daemon, without `qmd update`.
 *
 * A note written a minute ago should be findable now. The index only moves when someone runs
 * `qmd update`, and nobody does between writing and asking, so the daemon checks the
 * collections a query is about to search and re-indexes the ones that changed on disk.
 *
 * Three things it deliberately does not do:
 * - Run a collection's `update:` command. That is a shell hook (`git pull` in the documented
 *   example), gated on `qmd trust` for project-local configs; firing it because a query
 *   arrived would run commands nobody asked for.
 * - Clear the LLM cache. `store.update()` does, and a refresh after every edit would then send
 *   every following query through expansion and rerank cold.
 * - Embed. Embedding 232 documents takes minutes on a laptop GPU; a new note is findable by
 *   BM25 immediately and by vector search after the next `qmd embed`.
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { QMDStore } from "./index.js";
import {
  getStoreCollections,
  listCollectionFiles,
  listCollections,
  reindexCollection,
} from "./store.js";
import { isCollectionPathInsideProject, isLocalConfigPath } from "./trust.js";

export type RefreshCollection = {
  readonly name: string;
  readonly path: string;
  readonly pattern: string;
  readonly ignore?: string[];
};

export type CollectionSnapshot = {
  readonly fileCount: number;
  readonly newestMtimeMs: number;
};

export type IndexRefresherDeps = {
  /** Collections with the time the index last recorded a change in each, or null if never. */
  readonly listCollections: () => ReadonlyArray<RefreshCollection & { readonly lastIndexedMs: number | null }>;
  readonly snapshot: (collection: RefreshCollection) => Promise<CollectionSnapshot>;
  readonly reindex: (collection: RefreshCollection) => Promise<void>;
  readonly now?: () => number;
  readonly cooldownMs?: number;
  readonly onError?: (collection: string, error: unknown) => void;
};

export type IndexRefresher = {
  /** Re-index each named collection that changed on disk. Never rejects. */
  readonly refreshIfStale: (collections: readonly string[]) => Promise<void>;
};

/** How long a collection's last check stays good. Bounds the directory walk, not the re-index. */
export const REFRESH_COOLDOWN_MS = 30_000;

type CollectionState = {
  checkedAt: number;
  /** When this refresher last re-indexed the collection — see the touched-file note below. */
  refreshedAt: number;
  fileCount: number;
};

export const createIndexRefresher = (deps: IndexRefresherDeps): IndexRefresher => {
  const now = deps.now ?? Date.now;
  const cooldownMs = deps.cooldownMs ?? REFRESH_COOLDOWN_MS;
  const state = new Map<string, CollectionState>();
  // One refresh per collection at a time: two queries arriving together would otherwise both
  // see the same stale collection and index it twice, the second waiting on the first's lock.
  const inflight = new Map<string, Promise<void>>();

  const refreshOne = async (collection: RefreshCollection & { lastIndexedMs: number | null }): Promise<void> => {
    const startedAt = now();
    const previous = state.get(collection.name);
    if (previous && startedAt - previous.checkedAt < cooldownMs) return;

    const snap = await deps.snapshot(collection);
    // reindexCollection deactivates every document it does not see, and an unmounted drive or
    // a dropped network share looks exactly like "every file was deleted". Emptying a
    // collection is a choice for someone running `qmd update` by hand, not for a query.
    const vanished = snap.fileCount === 0 && (previous?.fileCount ?? 0) > 0;
    if (vanished) {
      state.set(collection.name, { ...previous!, checkedAt: startedAt });
      return;
    }
    // reindexCollection only records a change when content changes, so a file whose mtime
    // moved and whose content did not stays "newer than the index" for good. Measuring
    // against this refresher's own last pass as well stops that file re-indexing the
    // collection on every cooldown.
    const indexedAt = Math.max(collection.lastIndexedMs ?? 0, previous?.refreshedAt ?? 0);
    const somethingIsNewer = snap.newestMtimeMs > indexedAt;
    const fileSetChanged = previous !== undefined && snap.fileCount !== previous.fileCount;

    if (!somethingIsNewer && !fileSetChanged) {
      state.set(collection.name, {
        checkedAt: startedAt,
        refreshedAt: previous?.refreshedAt ?? 0,
        fileCount: snap.fileCount,
      });
      return;
    }

    await deps.reindex(collection);
    state.set(collection.name, { checkedAt: startedAt, refreshedAt: startedAt, fileCount: snap.fileCount });
  };

  const refreshShared = (collection: RefreshCollection & { lastIndexedMs: number | null }): Promise<void> => {
    const running = inflight.get(collection.name);
    if (running) return running;
    const started = refreshOne(collection)
      .catch((error: unknown) => { deps.onError?.(collection.name, error); })
      .finally(() => { inflight.delete(collection.name); });
    inflight.set(collection.name, started);
    return started;
  };

  return {
    refreshIfStale: async (names) => {
      // The lookup reads the index, and SQLITE_BUSY from the other writer — the launchd job
      // running `qmd update` — is exactly the failure this refresh has to survive. Letting it
      // out here would fail the query the refresh was meant to help.
      let targets: ReturnType<IndexRefresherDeps["listCollections"]>;
      try {
        const wanted = new Set(names);
        targets = deps.listCollections().filter(c => wanted.has(c.name));
      } catch (error) {
        for (const name of names) deps.onError?.(name, error);
        return;
      }
      await Promise.all(targets.map(refreshShared));
    },
  };
};

const snapshotCollection = async (collection: RefreshCollection): Promise<CollectionSnapshot> => {
  const files = await listCollectionFiles(collection.path, collection.pattern, collection.ignore);
  let newestMtimeMs = 0;
  for (const file of files) {
    try {
      newestMtimeMs = Math.max(newestMtimeMs, statSync(resolve(collection.path, file)).mtimeMs);
    } catch {
      // Deleted between the glob and the stat — the count already reflects the listing.
    }
  }
  return { fileCount: files.length, newestMtimeMs };
};

/**
 * A refresher wired to a store's own collections.
 *
 * `configPath`, when given, is the config the daemon was started from. A project-local config
 * arrives with `git clone`, so its collection paths outside the project are somebody else's
 * choice until the user runs `qmd trust`; `qmd update` skips them for an untrusted config, and
 * a refresh — which never asks — skips them always.
 */
export const createStoreIndexRefresher = (
  store: QMDStore,
  options: {
    configPath?: string;
    cooldownMs?: number;
    onError?: (collection: string, error: unknown) => void;
  } = {},
): IndexRefresher => {
  const db = store.internal.db;
  const configPath = options.configPath;
  const isOutsideLocalProject = (path: string): boolean =>
    configPath !== undefined && isLocalConfigPath(configPath) && !isCollectionPathInsideProject(configPath, path);

  return createIndexRefresher({
    listCollections: () => {
      const lastIndexed = new Map(listCollections(db).map(c => [c.name, c.last_modified]));
      return getStoreCollections(db)
        .filter(c => !isOutsideLocalProject(c.path))
        .map(c => {
          const stamp = lastIndexed.get(c.name);
          return {
            name: c.name,
            path: c.path,
            pattern: c.pattern || "**/*.md",
            ignore: c.ignore,
            lastIndexedMs: stamp ? Date.parse(stamp) : null,
          };
        });
    },
    snapshot: snapshotCollection,
    reindex: async (c) => {
      await reindexCollection(store.internal, c.path, c.pattern, c.name, { ignorePatterns: c.ignore });
    },
    cooldownMs: options.cooldownMs,
    onError: options.onError,
  });
};
