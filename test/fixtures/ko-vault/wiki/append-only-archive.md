---
type: pattern
aliases:
  - "추가 전용 보관소"
  - "append-only"
topics:
  - "[[topics/knowledge-operations|Knowledge Operations]]"
status: draft
sources: []
created: "2026-09-15"
updated: "2026-09-15"
---

# Append-Only Archive

## Summary

추가 전용 보관소는 한번 넣은 원본을 고치거나 지우지 않고 새 파일만 더하는 저장 규칙으로, 출처의 신뢰성을 지킨다.

## Details

요약 문서는 계속 다시 쓰이지만 원본은 그대로 남아야 나중에 요약이 틀렸는지 대조할 수 있다. 원본 폴더에 수정·이름 변경·삭제가 들어오면 검증 스크립트가 커밋을 막는다. 끝난 프로젝트나 대체된 설정도 삭제하지 않고 보관 폴더로 옮긴다. 저장 공간은 늘지만 텍스트 위주라 부담이 작다. 민감 정보가 원본에 섞여 들어온 경우만 예외로, 이때는 사람 승인과 이력 정리 절차를 따른다.

## Connections

- [[provenance-tracking]] — 원본을 가리키는 출처 문자열
- [[ingest-pipeline]] — 원본이 들어오는 경로
- [[lint-automation]] — 위반 검사

## Open Questions

- 보관 폴더가 커지면 검색 대상에서 제외해야 하는가?
