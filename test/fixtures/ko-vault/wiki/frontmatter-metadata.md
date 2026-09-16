---
type: concept
aliases:
  - "프론트매터 메타데이터"
  - "frontmatter"
topics:
  - "[[topics/knowledge-operations|Knowledge Operations]]"
status: draft
sources: []
created: "2026-09-15"
updated: "2026-09-15"
---

# Frontmatter Metadata

## Summary

프론트매터는 마크다운 파일 맨 위 YAML 블록에 유형, 상태, 출처, 날짜 같은 메타데이터를 적어 기계가 읽게 하는 관례다.

## Details

사람은 본문을 읽고 도구는 프론트매터를 읽는다. 값이 열거형으로 정해져 있으면 상태별 필터와 대시보드를 만들 수 있다. 따옴표가 닫히지 않거나 들여쓰기가 틀리면 파서가 블록 전체를 버리므로, 커밋 전 검증 스크립트로 구문을 확인한다. 검색 엔진이 제목과 프론트매터를 색인하면, 본문에 없는 별칭이나 약어도 키워드 검색에 걸리게 만들 수 있다. 필드를 새로 추가할 때는 그 필드를 읽는 도구도 같이 만들어야 죽은 필드가 되지 않는다.

## Connections

- [[lint-automation]] — 구문 검증
- [[provenance-tracking]] — sources 필드
- [[topic-map]] — topics 필드로 분류

## Open Questions

- 별칭 필드를 모든 기존 문서에 소급 적용해야 하는가?
