# ko-vault fixture

Synthetic Korean wiki vault + `qmd bench` goldset for Hangul search work (`docs/vault-search/`).

- Source: 2nd-brain `projects/second-brain/config/skills/vault-search/fixtures/` at commit `e856721` (A4, aliases included).
  `wiki/` is a verbatim copy of `ko-vault/wiki/`, `ko-bench.json` of `ko-search-bench.json`.
- Do not edit `wiki/` here — fix upstream in 2nd-brain and re-copy. `ko-bench.json` has diverged: queries
  `ko-01`…`ko-16` and `ali-12`…`ali-22` were added in this repo (see `BASELINE.md`); keep them on a re-copy.
- `models.yml`: models used by `scripts/bench-ko.sh` (top-level `embed`/`rerank`/`generate` keys). Pinned to Qwen3-Embedding-0.6B-Q8_0, the package default (switched from embeddinggemma on 2026-09-16, see `BASELINE.md`).
- `BASELINE.md`: recorded `RESULT` lines.

Run: `bash scripts/bench-ko.sh` (isolated index under `tmp/bench-ko/`). `KO_CORPUS` / `KO_BENCH` swap in
another corpus copy or goldset for an A/B; `KO_FORM` picks the seam form (default, no query expansion) or
`plain` — usage and validation in the script header.

## `distractors/` — near-topic decoys (created in this repo, not upstream)

69 documents (23 wiki topics × 3). Same domain vocabulary as the topic they shadow, different
concept — near enough to tempt a ranker, never an answer to that topic's bench queries. Do NOT
index them for real use; they exist to give the benchmark a recall@1 pressure floor. Length and
frontmatter mirror `wiki/`; basenames never collide with a wiki basename (bench matches by path
suffix). Original `ko-…` queries that fall in r@1 after these land are attributed to the
shadowing distractor (see `BASELINE.md` 2026-09-24 pair).

| wiki topic | distractors (concept) |
|---|---|
| append-only-archive | semantic-versioning (버전 번호 규약) · checksum (변조 확인 값) · file-locking (동시 편집 잠금) |
| bm25-ranking | tf-idf (원형 가중치) · stopwords (불용어 전처리) · index-compression (색인 압축) |
| chunking-strategy | document-summarization (요약) · search-pagination (오프셋·커서) · context-window (입력 크기 한도) |
| cross-encoder-reranking | click-model (클릭 신호 모형) · position-bias (위치 효과 보정) · query-understanding (의도 추출) |
| decision-record | changelog (변경 나열) · runbook (대응 절차) · postmortem (장애 분석) |
| frontmatter-metadata | exif (사진 촬영 정보) · id3-tag (MP3 태그) · opengraph-metadata (미리보기 메타) |
| golden-dataset | regression-testing (재실행) · chaos-engineering (장애 주입) · load-testing (트래픽 시험) |
| hybrid-search | search-operators (조건 문법) · result-highlighting (구절 강조) · query-caching (결과 재사용) |
| ingest-pipeline | cicd-pipeline (빌드·배포 흐름) · data-migration (데이터 이전) · file-synchronization (기기 파일 동기화) |
| inverted-index | forward-index (문서→단어 방향) · suffix-array (문자열 구조) · btree-index (DB 페이지 나무) |
| korean-morphology | named-entity-recognition (개체명 분류) · korean-spacing-correction (공백 교정) · machine-translation (자동 번역) |
| lint-automation | unit-test (단위 검증) · code-review (동료 검토) · continuous-integration (푸시마다 자동 검사) |
| meeting-notes-workflow | journaling (매일 쌓기) · book-notes (구절·감상) · kanban-board (카드 보드) |
| ngram-tokenization | unicode-normalization (코드 통일) · character-encoding (바이트 약속) · regex-pattern (패턴 언어) |
| provenance-tracking | digital-watermarking (식별 표식) · audit-log (행적 장부) · signed-commit (커밋 서명) |
| query-expansion | autocomplete (입력 제안) · spell-correction (오타 교정) · search-log-analysis (로그 경향) |
| recall-at-k | latency-percentile (응답 꼬리 지표) · ab-testing (집단 비교) · click-through-rate (노출 대비 클릭) |
| reciprocal-rank-fusion | elo-rating (대결 점수) · pagerank (링크 중요도) · bayesian-average (표본 보정 평균) |
| retrieval-augmented-generation | fine-tuning (추가 학습) · prompt-engineering (지시문 설계) · tool-calling (외부 함수 실행) |
| spaced-repetition | pomodoro-technique (시간 관리) · interleaving-practice (유형 섞기) · method-of-loci (장소 암기) |
| vector-embedding | one-hot-encoding (0/1 자리열) · dimensionality-reduction (차원 축소) · autoencoder (압축 재구성) |
| wikilink-graph | citation-network (인용 그래프) · social-graph (사람 관계망) · dependency-graph (모듈 의존) |
| zettelkasten | outliner (들여쓰기 구조화) · cornell-notes (세 구역 필기) · mind-map (가지 뻗기) |

## Hard query types (added by the ko-bench-hard work)

`ko-bench.json`'s `type` field is `exact`/`semantic`/`topical`/`cross-domain`/`alias` plus three
hard kinds:

- `sem-hard` — everyday wording that avoids the target's own vocabulary. The fixture test asserts
  no overlap with the target's *title terms* (file name, `# ` heading, frontmatter aliases; loanword
  forms included). Body words may still overlap, and most such overlaps are generic words
  (11 of 12 queries share at least one body stem as of 2026-09-24).
- `multi` — the answer spans 2–3 notes; `expected_in_top_k` equals their count.
- `neg` — “X 말고 Y”: names a concept to exclude; `expected_files` lists only Y. The excluded X is
  usually one of the `distractors/`.

## `bench-ko.sh` stdout — two lines

1. `RESULT bm25_r5=<f> vector_r5=<f> hybrid_r5=<f> full_r5=<f> full_mrr=<f>` — format fixed;
   `scripts/dogfood.sh`'s `bm25_of` regex parses it.
2. `RESULT-HARD hybrid_r1=<f> hybrid_mrr=<f> full_r1=<f> full_mrr=<f> n=<n> form=<seam|plain>` — the
   hard types pooled, weighted by query count. `n=0` (and `nan` values) while the fixture has no
   hard queries. This line feeds the dogfood hard gate, which needs `form=` to match its baseline.
