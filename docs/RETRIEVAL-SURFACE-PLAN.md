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

## Who this is for, and the one story that matters

Two users. A person at a terminal with a vault of Markdown, and an agent session reaching
the same index over MCP — which on this machine is the heavier user of the two.

The story neither can tell today: *write a note, ask about it a minute later, find it.*
Right now the answer is "run `qmd update` first", and nobody remembers to. Everything else
in this plan is a convenience; that one is the difference between a tool you trust and a
tool you re-run by hand. It is item 3.

**MVP**: item 3 plus `--since` from item 1. That is the whole story above, and it is
shippable without the glob syntax, without `grep`, and without touching the embedding stack.

## The plan

Order: 3, 1, 2, 5 — the engineering order was 1, 2, 5, 3, cheapest first, and this is the
same list ordered by what a user notices. Item 3 goes first because a stale index is the
only one here that makes the tool wrong rather than merely limited; item 1 is next because
`--since` completes that story. Item 4 is deferred (see Settled).

Items are numbered by the order they were decided, not the order they get built.

### 1. Path and time filters on a query

`--path <glob>`, repeatable, `!` prefix to exclude. `--since` / `--until`, accepting both a
relative span (`7d`) and a date. On `query`, `search` and `vsearch`, and on the MCP tool,
which today takes only `collections`.

`documents` already stores `path` and `modified_at`, so this is a `WHERE` clause. It has to
be that clause and not a post-filter: `MIN_RETRIEVAL_BREADTH` guarantees 20 candidates
*before* filtering, and a filter applied after it re-creates the bug that floor just fixed —
a narrow request silently searching a narrow pool.

`--mask` / `--glob` are taken by collection creation, which is why the query-side flag is
`--path`. Match globs with `picomatch`, already a dependency and already how collection
masks and ignore rules are matched (`src/store.ts:3422`, `:4776`).

Vector search cannot take the same `WHERE`. `annVecScan` searches the whole table and the
document predicate is applied to its output, which is the post-filter starvation that
collection scoping already hit (#791, #803): a narrow filter leaves nothing behind. Reuse
the fix that landed for collections — resolve the filter to a `hash_seq` set first and run
`exactVecScanByHashSeq` when that set is under `COLLECTION_VEC_EXACT_SCAN_MAX`, otherwise
ANN with over-fetch and a documented ceiling on how narrow a filter it can serve.

A filter that removes everything must say so. `search`, `vsearch` and `query` returning an
empty list is indistinguishable from "no match"; report the filtered corpus size when the
filter matched zero documents.

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

Why not just ripgrep, which is already on the machine and faster? For a person at a terminal
that is often the right answer, and this feature does not pretend otherwise. It earns its
place for the caller who has no shell — an MCP client whose only tools are `query`, `get`
and `multi_get` — and for the caller who wants one corpus definition: `qmd grep` searches
exactly what the index holds, honours collection exclusion, and returns `qmd://` paths and
docids that `qmd get` accepts. If those two reasons stop being true, cut the item.

Risk to design for: a user-supplied pattern compiled as a JS `RegExp` is a ReDoS surface,
and a per-document time budget does not contain it — a catastrophic backtrack blocks the
only thread, so no timer fires and the daemon stops answering every session on the machine.

**Settled during implementation (supersedes the worker-thread plan above):** contain it by
bounding the input instead of by being able to kill the scan. The scan runs line by line,
and lines past 4KB are tested in overlapping slices, so the worst case is a 4KB string
rather than a whole document — and the exponents that make a backtrack catastrophic need a
long input to bite. Pattern length is capped at 1000 characters. A worker thread was
rejected because the tsx development path and the `dist/` path resolve worker entry points
differently, which is real cost for a second line of defence. Measured: `(a+)+$` against a
50KB single line returns in under two seconds with the per-line bound, and does not return
within 45 seconds without it (`test/grep.test.ts`, "a pathological pattern terminates").

Do not load the corpus into one array. `rebuildFTSForCjkNormalization` already reads bodies
in keyset-paginated batches (`WHERE id > ? ORDER BY id LIMIT ?`) for exactly this reason;
the scan reuses that shape and stops once `limit` files have matched. `--path` from item 1
narrows the scan before it starts, which is the cheap way to make a large vault tolerable.

Per-result context is an N+1: `getContextForFile` re-reads every collection per call
(`src/store.ts:3490`). Line-grouped results multiply it, so resolve context once per file
and hoist the collection list out of the loop.

### 3. Daemon refresh

An mtime check on each query, with a 30-second cooldown, refreshing the text index only.
Vectors stay manual: embedding 232 documents took 3m38s on this machine, so an automatic
re-embed would hold the GPU during someone's search. A new document is findable by BM25
immediately and by vector search after the next `qmd embed`, which is a better failure than
a stalled query.

The refresh re-indexes and nothing else. `qmd update` runs a collection's configured
pre-update command first — `git pull` in the documented example — and those hooks are gated
on `qmd trust`. A refresh that fired them would run shell commands on a timer nobody asked
for, so it must call the indexing path directly rather than the update command, and must
never prompt for trust. Hook execution lives in the CLI (`src/cli/qmd.ts`), which keeps the
two apart as long as the daemon does not reach for it.

The MCP daemon is shared by several sessions, so the refresh writes while other sessions
read. `test/store-concurrency.test.ts` already fixes what that boundary must hold.

The mtime check walks the collection's files. On a large or network-backed vault that walk
is the cost, not the re-index, so the cooldown is what bounds it: one walk per 30 seconds
per collection, skipped entirely when no query arrives.

### 4. A lighter embedding backend (deferred)

Not in this round. Recorded here because the decision and its reasoning are worth keeping.

transformers.js with a small multilingual ONNX model (`multilingual-e5-small` class),
offered alongside node-llama-cpp. Qwen3-Embedding-0.6B stays the default; this is opt-in for
a first index over a large vault.

The published model2vec/Potion packages on npm are all potion-base, which is English-only,
so they are not an option for a Korean corpus whatever their speed.

The real cost is not the backend but the migration. `vectors_vec` is a fixed-dimension
table; `content_vectors.embed_fingerprint` distinguishes models per row, but the vector
table does not. Switching models means rebuilding it, and the three `searchVec` tests that
fail on a fixture embedded at 768 dimensions against a 1024-dimension default are that
mismatch already showing. Design the rebuild path first; the backend is the easy half. `clearAllEmbeddings` already
drops and recreates `vectors_vec` so the next embed run can size it to the new model, and
`embed_fingerprint` already keys rows per model, so the parts exist — what is missing is the
decision of what happens to a user who switches models with a half-embedded index.

### 5. Per-group ranks in `--explain` (developer-facing)

This one buys a user nothing. It is instrumentation: it exists so the next question about
expansion quality is answered by a flag instead of a one-off script, and it is in the plan
on that basis, not as product value. Cut it first if the round runs long.



Keep the fused list as the answer, and expose the per-sub-query lists under `--explain`
only, so neither the default output nor the MCP response shape changes.

`rankedListMeta` already carries `(source, queryType, query)` for every list RRF consumed,
and `buildRrfTrace` already walks them. Diagnosing "what did expansion contribute" took a
one-off probe script this week; this is that probe, in the product.

## Tests each item owes

Named per branch the item introduces, because a branch with no test is the one that breaks
quietly. `test/store.test.ts` and `test/mcp.test.ts` are where the first three land.

1. **Filters** — a path glob that keeps a document and one that excludes it; a `!` exclusion
   beating an include; `--since` accepting both `7d` and a date, and rejecting garbage; a
   filter narrow enough that the old post-filter would have starved it, asserting the result
   still comes back (the regression test for the vector path above); a filter matching zero
   documents reporting that rather than an empty list; the same filter through the MCP tool.
2. **grep** — smart case both ways; a pattern with regex metacharacters; a match on a line
   whose number is then fed to `qmd get`; an excluded collection staying out of results;
   a pattern that a Hangul FTS query misses but grep finds, which is the reason it exists;
   a pathological pattern terminating instead of hanging.
3. **Refresh** — a file changed on disk becoming findable on the next query; the cooldown
   suppressing the second walk; a configured update hook *not* running; a refresh writing
   while a second connection reads.
4. **Embedding backend** — an index embedded by one backend rejecting a query embedded by
   the other with a clear message, not a dimension error; the rebuild path emptying and
   re-creating `vectors_vec`.
5. **Explain groups** — a query whose expansion produced three sub-queries showing three
   groups with their own ranks, and the default output shape unchanged.

Regression rule: the starvation case in (1) and the hang case in (2) are both bugs this
plan can reintroduce. Their tests are required, not optional.

## Failure modes

| Path | Fails as | Seen by the user as |
| --- | --- | --- |
| Filter + vector | Post-filter starvation | Fewer results than asked for, no error — the reason (1) reports filtered corpus size |
| grep pattern | Catastrophic backtracking | Daemon stops answering every session — contained by the worker thread |
| Refresh | Write during read | Query error under concurrency — covered by the existing concurrency boundary |
| Refresh | mtime walk on a network vault | Every query pays the walk — bounded by the cooldown |
| Backend switch | Dimension mismatch | `Expected 768 dimensions but received 1024`, today's test failure, shown to users |

## What already exists

`picomatch` (a dependency) for globs; `exactVecScanByHashSeq` and
`COLLECTION_VEC_EXACT_SCAN_MAX` for filtered vector scans; keyset-batched body reads in
`rebuildFTSForCjkNormalization`; `clearAllEmbeddings` and `embed_fingerprint` for the
backend migration; `rankedListMeta` and `buildRrfTrace` for item 5; `getContextForFile`,
which items 1 and 2 must call less often rather than more.

## Risks

| Risk | Response |
| --- | --- |
| Item 4 rebuilds the vector table under a user's real 1042-document index | Deferred out of this round; when it returns, opt-in only, never on upgrade, and reversible before the backend ships |
| Item 3 writes to the shared index while sessions read it | The existing concurrency boundary, plus text-only writes so a refresh is milliseconds |
| Item 2 duplicates ripgrep and is used by nobody | Justified above on the shell-less caller; measure it — if the MCP tool never sees it in a month, delete it |
| The round grows past what one person finishes | Item 4 is already cut; item 5 is the next one to drop |

## Not in scope

Symbol-type filters and ripgrep file types (zvec has both): this corpus is Markdown, and
qmd's AST chunking already covers the code case. A remote embedding service: the point of
this tool is that nothing leaves the machine. Per-group ranks in the default output or the
MCP response: the shape is a contract other sessions depend on.

## TODOs surfaced by this review

- `getContextForFile` re-reads the collection list per result row — an N+1 that predates
  this plan and gets worse with line-level results.
- The three `searchVec` dimension-mismatch test failures are a fixture pinned to 768
  dimensions against a 1024-dimension default; item 4 forces the question.

## Settled

- **One PR** for the whole round. The items share the CLI option table and the store entry
  points, so splitting them would mean three passes over the same files.
- **Item 4 is out of this round.** The lighter backend is a day's work; rebuilding a
  fixed-dimension vector table under a real index is the project, and it is the only item
  here that touches a user's existing data. It returns when that rebuild path is designed.

The round is items 3, 1, 2 and 5.
