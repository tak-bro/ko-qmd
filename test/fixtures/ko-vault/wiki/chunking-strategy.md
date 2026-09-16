---
type: pattern
aliases:
  - "청킹 전략"
  - "문서 분할"
  - "chunking"
topics:
  - "[[topics/information-retrieval|Information Retrieval]]"
status: draft
sources: []
created: "2026-09-15"
updated: "2026-09-15"
---

# Chunking Strategy

## Summary

청킹은 긴 문서를 검색과 임베딩에 알맞은 크기의 조각으로 나누는 규칙이며, 조각 크기에 따라 정밀도와 문맥 보존이 갈린다.

## Details

임베딩 모델은 입력 길이 한계가 있어 긴 문서를 통째로 넣으면 뒷부분이 잘린다. 헤딩 경계로 자르면 의미 단위가 유지되고, 고정 토큰 수로 자르면 구현이 단순하다. 조각 사이에 약간 겹치는 구간을 두면 경계에 걸친 문장을 놓치지 않는다. 조각이 너무 작으면 앞뒤 맥락이 사라져 답변 생성에 쓸 수 없다. 한 개념을 한 파일에 담는 wiki 문서는 대부분 짧아서 헤딩 단위 청킹만으로 충분한 경우가 많다.

## Connections

- [[vector-embedding]] — 입력 길이 제한
- [[inverted-index]] — 색인 단위
- [[retrieval-augmented-generation]] — 조각을 문맥으로 사용

## Open Questions

- 헤딩 없는 긴 회의록은 어떤 기준으로 자를까?
