---
type: pattern
aliases:
  - "린트 자동화"
  - "lint"
topics:
  - "[[topics/knowledge-operations|Knowledge Operations]]"
status: draft
sources: []
created: "2026-09-15"
updated: "2026-09-15"
---

# Lint Automation

## Summary

린트 자동화는 문서 규칙 위반을 스크립트로 찾아내 커밋이나 풀 리퀘스트 전에 막는 검사 체계다.

## Details

검사 항목은 프론트매터 구문, 필수 헤딩 존재, 끊긴 위키링크, 고립 문서, 원본 폴더 수정 여부, 메모리 파일 용량 상한 등이다. 사람이 매번 눈으로 보던 규칙을 기계 검사로 옮기면 리뷰가 내용에 집중할 수 있다. 검사가 실패하면 종료 코드로 알리고, 결과 요약은 리포트 파일로 남긴다. 규칙을 새로 만들 때 검사기도 같이 만들지 않으면 규칙은 곧 지켜지지 않는다. 개인 데이터나 절대 경로 같은 항목은 아직 사람이 확인해야 하는 영역으로 남아 있다.

## Connections

- [[frontmatter-metadata]] — 구문 검사 대상
- [[wikilink-graph]] — 링크 검사
- [[append-only-archive]] — 원본 불변 검사

## Open Questions

- 절대 경로 검사를 오탐 없이 자동화할 수 있는가?
