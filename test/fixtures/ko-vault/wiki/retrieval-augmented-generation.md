---
type: concept
aliases:
  - "검색 증강 생성"
  - "RAG"
topics:
  - "[[topics/information-retrieval|Information Retrieval]]"
status: draft
sources: []
created: "2026-09-15"
updated: "2026-09-15"
---

# Retrieval-Augmented Generation

## Summary

RAG는 언어 모델이 답하기 전에 관련 문서를 검색해 문맥으로 넣어 주는 구성으로, 모델이 모르는 내부 지식을 근거와 함께 답하게 한다.

## Details

질문이 들어오면 검색기가 상위 문서 조각을 찾고, 모델은 그 조각만 보고 답을 쓴다. 검색이 틀리면 모델은 그럴듯한 오답을 만들기 때문에 전체 품질의 상한은 검색 재현율이 정한다. 매번 원문에서 새로 찾는 방식과 달리, 지식을 wiki 문서로 미리 정리해 두고 그 문서를 검색하면 답의 일관성이 높아진다. 답변에는 근거 문서 링크를 붙여 사용자가 확인할 수 있게 한다. 개인 문서가 섞인 코퍼스라면 검색 범위를 권한에 맞게 제한해야 한다.

## Connections

- [[hybrid-search]] — 검색 단계 구성
- [[chunking-strategy]] — 문맥 조각 크기
- [[provenance-tracking]] — 근거 인용
- [[query-expansion]] — 질의 변형

## Open Questions

- wiki 요약 문서와 원본 중 무엇을 검색 대상으로 둘까?
