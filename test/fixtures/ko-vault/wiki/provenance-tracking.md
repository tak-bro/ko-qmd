---
type: concept
aliases:
  - "출처 추적"
  - "provenance"
topics:
  - "[[topics/knowledge-operations|Knowledge Operations]]"
status: draft
sources: []
created: "2026-09-15"
updated: "2026-09-15"
---

# Provenance Tracking

## Summary

출처 추적은 wiki 문서의 모든 주장이 어느 원본에서 왔는지 경로 문자열로 남겨 검증 가능하게 하는 규칙이다.

## Details

요약은 원문을 줄이는 과정에서 뜻이 바뀌기 쉽다. 프론트매터 sources 필드에 원본 경로를 적어 두면 누구든 원문을 열어 대조할 수 있다. 원본을 가리키는 값은 링크가 아니라 문자열로 적는데, 원본 폴더를 링크 그래프에 끌어들이지 않기 위해서다. 근거가 없는 주장은 추정이라고 표시하거나 갱신 필요 상태로 둔다. 원본 이름이 바뀌면 이를 가리키는 모든 출처 문자열을 같은 커밋에서 고쳐야 한다.

## Connections

- [[append-only-archive]] — 출처가 가리키는 원본의 불변성
- [[frontmatter-metadata]] — sources 필드
- [[retrieval-augmented-generation]] — 답변 근거 인용

## Open Questions

- 외부 URL 출처가 사라지는 경우를 어떻게 대비할까?
