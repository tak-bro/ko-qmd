#!/usr/bin/env node
// Electron embedding smoke test for ko-qmd.
//
// Run as `ELECTRON_RUN_AS_NODE=1 npx electron scripts/electron-smoke.mjs` after
// rebuilding better-sqlite3 for the Electron ABI. Also runs under plain node.
//
// The SDK is loaded with a dynamic import(): dist/ contains top-level await, so
// require() fails with ERR_REQUIRE_ASYNC_MODULE. BM25 only — no model is loaded.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = await mkdtemp(join(tmpdir(), "ko-qmd-electron-smoke-"));
const docs = join(root, "wiki");
await mkdir(docs, { recursive: true });
await writeFile(join(docs, "search.md"), "# 검색 개선\n\n한국어 문서 검색을 개선한다.\n");

const { createStore } = await import(pathToFileURL(join(process.cwd(), "dist", "index.js")).href);
const store = await createStore({
  dbPath: join(root, "index.sqlite"),
  config: { collections: { ko: { path: docs, pattern: "**/*.md" } } },
});

let code = 0;
try {
  await store.update();
  const results = await store.searchLex("검색");
  console.log(`runtime=${process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.versions.node}`} abi=${process.versions.modules} searchLex=${results.length}`);
  if (results.length < 1) code = 1;
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}
process.exit(code);
