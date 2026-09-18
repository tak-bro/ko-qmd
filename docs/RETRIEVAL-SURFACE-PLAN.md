# Retrieval surface plan

What ko-qmd is missing that a reader of [zvec-grep](https://github.com/zvec-ai/zvec-grep)
would expect, which of those gaps we decided to close, and in what order. Decisions were
settled in a design interview on 2026-09-18; this file is the record, not a proposal.

Nothing here is implemented yet.

## Why zvec-grep is the comparison

Both tools index a corpus and search it with BM25 and vectors. They aim at different
questions, which is why the comparison is useful rather than a feature checklist:

| | ko-qmd | zvec-grep |
| --- | --- | --- |
| Corpus | Markdown collections in one global index (`~/.cache/qmd/index.sqlite`) | One project, index in its own `.zvec-grep/` |
| Layers | FTS5 BM25, sqlite-vec | ripgrep regex, BM25, vectors |
| Query handling | An LLM expands the query into lex/vec/hyde sub-queries, RRF fuses them, a reranker rescores | The caller names the routes (`--fts`, `--vector`, `--hybrid`), groups keep their own rank unless `--fuse` |
| Models | node-llama-cpp GGUF: embedding 0.6B, reranker 0.6B, expansion 1.7B | model2vec/Potion, llama.cpp, transformers.js, or a remote service |
| Freshness | `qmd update`, run by hand | Incremental refresh, in the background on a server-mode query |
| Filters on a query | Collection only | Path globs, ripgrep file types, modified-before/after, symbol type |

The four gaps that follow all sit in that last row and the two above it. They are surface
and plumbing, not ranking: today's measurement (below) is a reminder that ranking work on
this corpus has run out of easy wins, while the surface still refuses ordinary requests.

## What we measured first

Two fixes shipped in v2.8.3-ko.3 — the expansion drift filter and the retrieval-breadth
floor — were A/B'd on the paraphrase goldset (30 queries over a 232-document vault, one
fresh index and embedding pass per side, `scripts/bench-vault.sh`):

| | before | after |
| --- | --- | --- |
| bm25 r@5 / r@1 / MRR | .567 / .467 / .520 | .567 / .467 / .520 |
| vector r@5 | .800 | .800 |
| hybrid r@5 | .833 | .800 |
| full r@5 / MRR | .933 / .883 | .933 / .900 |

One query is .033 at n=30, so nothing here is a difference. The breadth floor moved no
backend at all on this goldset; the drift filter cost one unreranked hybrid hit and gained
a little ordering in the reranked path. Both changes stand on what they remove — 22 English
boilerplate sub-queries that cost an embedding call each, and a result set that changed with
`-n` — not on recall.

## The plan

Order: 1, 2, 5, 3, 4. The cheap independent ones first; 5 before 3 and 4 because it is the
instrument that shows what expansion actually did, and 3 and 4 are the two that are hard to
undo.

### 1. Path and time filters on a query

`--path <glob>`, repeatable, `!` prefix to exclude. `--since` / `--until`, accepting both a
relative span (`7d`) and a date. On `query`, `search` and `vsearch`, and on the MCP tool,
which today takes only `collections`.

`documents` already stores `path` and `modified_at`, so this is a `WHERE` clause. It has to
be that clause and not a post-filter: `MIN_RETRIEVAL_BREADTH` guarantees 20 candidates
*before* filtering, and a filter applied after it re-creates the bug that floor just fixed —
a narrow request silently searching a narrow pool.

`--mask` / `--glob` are taken by collection creation, which is why the query-side flag is
`--path`.

### 2. `qmd grep`

A subcommand, not a flag on `search`: BM25 ranking and exact matching are different
contracts, and a `--regex` that invalidates `--min-score` teaches nothing.

Scans document bodies from `content.doc`, so it needs no ripgrep on the machine, returns
`qmd://` paths and docids like every other command, and answers for exactly the corpus the
index holds. Smart case: a pattern with an uppercase letter matches case-sensitively.
Hangul has no case, so Korean patterns are unaffected either way. Default scope follows the
collection-exclusion rules the other search commands use, so results are comparable.

Results are lines grouped by file, with line numbers that address `qmd get file.md:120:40`.

This is the escape hatch for the failure mode this fork keeps hitting: a query that finds
nothing because Hangul tokenization did not produce the term the document contains.

Risk to design for: a user-supplied pattern compiled as a JS `RegExp` is a ReDoS surface.
Bound the pattern length and give each document a time budget.

### 3. Daemon refresh

An mtime check on each query, with a 30-second cooldown, refreshing the text index only.
Vectors stay manual: embedding 232 documents took 3m38s on this machine, so an automatic
re-embed would hold the GPU during someone's search. A new document is findable by BM25
immediately and by vector search after the next `qmd embed`, which is a better failure than
a stalled query.

The MCP daemon is shared by several sessions, so the refresh writes while other sessions
read. `test/store-concurrency.test.ts` already fixes what that boundary must hold.

### 4. A lighter embedding backend

transformers.js with a small multilingual ONNX model (`multilingual-e5-small` class),
offered alongside node-llama-cpp. Qwen3-Embedding-0.6B stays the default; this is opt-in for
a first index over a large vault.

The published model2vec/Potion packages on npm are all potion-base, which is English-only,
so they are not an option for a Korean corpus whatever their speed.

The real cost is not the backend but the migration. `vectors_vec` is a fixed-dimension
table; `content_vectors.embed_fingerprint` distinguishes models per row, but the vector
table does not. Switching models means rebuilding it, and the three `searchVec` tests that
fail on a fixture embedded at 768 dimensions against a 1024-dimension default are that
mismatch already showing. Design the rebuild path first; the backend is the easy half.

### 5. Per-group ranks in `--explain`

Keep the fused list as the answer, and expose the per-sub-query lists under `--explain`
only, so neither the default output nor the MCP response shape changes.

`rankedListMeta` already carries `(source, queryType, query)` for every list RRF consumed,
and `buildRrfTrace` already walks them. Diagnosing "what did expansion contribute" took a
one-off probe script this week; this is that probe, in the product.

## Open

How many PRs to split this into.
