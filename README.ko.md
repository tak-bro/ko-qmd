# ko-qmd

[tobi/qmd](https://github.com/tobi/qmd)의 한국어 배포판. 한국어 vault 검색을 위해 작은 패치 스택만 얹는다. 사용법·CLI·MCP 서버는 업스트림 [README.md](README.md)와 같다 — bin 이름과 MCP 서버명은 `qmd` 그대로다.

- 패키지 이름: `ko-qmd` (npm 발행 — `v*` 태그 push 가 `publish.yml` 로 발행)
- 버전 규칙: `<업스트림 버전>-ko.N` (예: `2.8.3-ko.0`)
- 브랜치: `develop` = 작업 브랜치(PR 은 여기로), `main` = 배포 브랜치(develop 을 머지한 뒤 `/release` 로 태그 → `publish.yml` 이 `NPM_TOKEN` 시크릿으로 발행). 업스트림은 `upstream` 원격으로만 따라간다 — 포크가 아니다.

## 업스트림과 다른 점

1. 패키징: 이름·repository·플러그인 marketplace owner, `publish.yml` 은 `ko-qmd` 로 발행, CI에 `windows-latest`와 Electron 스모크 잡 추가
2. Hangul FTS (`src/hangul.ts`, `store.ts` 접점 2곳)
   - 질의: 따옴표 없는 한글 단어는 끝 조사 하나 또는 `기`를 뗀 어간도 매칭한다(`검색을` → `검색`, 어간 2음절 이상). 따옴표 구문·한자·가나는 그대로.
   - 색인: 한글 구간의 음절 bigram을 필드 끝에 덧붙인다. `FTS_CJK_NORMALIZED_VERSION`이 `"2"`라 기존 인덱스는 처음 열 때 FTS를 한 번 다시 만든다.
3. 한국어 기본값
   - 기본 임베딩 모델: `hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf`(업스트림은 embeddinggemma-300M). 리랭커·질의 확장 모델은 업스트림 기본값 그대로. 업스트림 [README.md](README.md)의 모델 표·"Custom Embedding Model" 절은 업스트림 기본값 기준이다.
   - 스킬 `skills/qmd/SKILL.md`에 "Korean queries" 절(`lex:`에 어간·alias·영문 용어, `vec:`에 한국어 패러프레이즈).

4. 데몬 질의 로그 (`src/query-log.ts`, `server.ts` 접점 = REST 핸들러·`status` 툴): `QMD_QUERY_LOG=1` 로 띄운 HTTP 데몬이 REST 검색마다 `queries-YYYY-MM.jsonl` 에 한 줄을 남긴다(결과 경로·점수, 스니펫 없음). 헤더 `X-QMD-Tag`·`X-QMD-Qid`·`X-QMD-Role`·`X-QMD-No-Log`. 계약은 [README.md § Query log](README.md#query-log-ko-qmd). 업스트림 PR 대상 아님.

### 기본 임베딩 변경 후 재임베딩

벡터는 모델 사이에 호환되지 않는다. embeddinggemma로 만든 기존 인덱스는 다시 임베딩해야 한다.

```sh
qmd embed -f
```

embeddinggemma를 계속 쓰려면 `index.yml`의 `models: embed:` 또는 `QMD_EMBED_MODEL`로 지정한다.

### ko-vault 벤치

`bash scripts/bench-ko.sh` (픽스처 `test/fixtures/ko-vault/`, 문서 28·질의 36, 임베딩은 픽스처 `models.yml`의 embeddinggemma로 고정). 표와 run별 수치는 [BASELINE.md](test/fixtures/ko-vault/BASELINE.md).

| 단계 | bm25_r5 | vector_r5 | full_r5 |
|---|---|---|---|
| 업스트림 2.8.3 (B1) | 0.6250 | 0.9861 | 1.0000 |
| + 질의 조사 처리 (B2) | 0.6528 | 0.9861 | 1.0000 |
| + bigram 색인 (B3) | 0.6528 | 0.9861 | 1.0000 |

Qwen3-Embedding 기본값의 벤치 수치는 미측정이다(design §6 라운드 M1).

## 설치

```sh
# 팀 CLI
npm install -g ko-qmd@<version>

# 앱 package.json
"ko-qmd": "<version>"
```

업스트림 `@tobilu/qmd` 와 bin 이름이 같아 둘을 함께 둘 수 없다 — `npm uninstall -g @tobilu/qmd` 뒤 설치한다. 미발행 커밋은 GitHub 에서 직접(`npm i github:tak-bro/ko-qmd#<sha>`) 받을 수 있고, 그때는 `prepare`가 `scripts/build.mjs`(= `tsc -p tsconfig.build.json`)로 `dist/`를 만든다. **설치에는 node + tsc만 필요하고 bun은 필요 없다.** 개발용 `npm run test:unit`은 vitest와 `bun test`를 둘 다 돌리므로 bun이 필요하다.

설치 스모크(빈 디렉터리):

```sh
npm i github:tak-bro/ko-qmd#<commit-sha>
node -e "import('ko-qmd').then(m=>{if(typeof m.createStore!=='function')process.exit(1)})"
```

## Electron 내장

앱은 SDK(`createStore`)를 워커(utilityProcess)에서 쓴다. CI의 `electron-smoke` 잡이 이 조건을 대변한다 — Electron 39(ABI 140)로 `better-sqlite3`를 리빌드하고 `ELECTRON_RUN_AS_NODE=1 npx electron scripts/electron-smoke.mjs`로 `createStore` → `searchLex('검색')`을 확인한다.

- **동적 `import()`만 된다.** `dist/`에 top-level await가 있어 `require()`는 `ERR_REQUIRE_ASYNC_MODULE`로 실패한다. `XDG_CACHE_HOME` 같은 env는 모듈 로드 시점에 읽히므로, 워커 진입점에서 env를 설정한 뒤 `await import('ko-qmd')`한다.
- **`asarUnpack`** (asar 안에서는 네이티브 바이너리를 로드할 수 없다):
  - `node_modules/@node-llama-cpp/**`
  - `node_modules/sqlite-vec-*/**`
  - `node_modules/better-sqlite3/build/**`
- **pnpm `onlyBuiltDependencies`**: `better-sqlite3`, `node-llama-cpp`
- `better-sqlite3`는 Electron ABI로 리빌드해야 한다(`@electron/rebuild` 또는 electron-builder `install-app-deps`). 리빌드된 모듈은 시스템 Node(vitest)에서 `NODE_MODULE_VERSION` 불일치로 로드되지 않는다.

Windows CI 결과·리빌드 소요 시간은 `docs/vault-search/WINDOWS.md` 에 기록한다(아직 미작성 — CI 로그가 유일한 기록).

## 업스트림 동기화

```sh
git fetch upstream
git rebase upstream/<tag>   # on ko
npm run test:unit && bash scripts/bench-ko.sh
```

통과하면 `v<업스트림 버전>-ko.N` 태그를 push한다.

## 라이선스

MIT. 원저작권은 Tobi Lutke([LICENSE](LICENSE))에게 있으며 이 배포판도 같은 라이선스를 따른다.
