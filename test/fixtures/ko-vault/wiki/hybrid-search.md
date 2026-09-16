---
type: pattern
aliases:
  - "하이브리드 검색"
  - "hybrid search"
topics:
  - "[[topics/information-retrieval|Information Retrieval]]"
status: draft
sources: []
created: "2026-09-15"
updated: "2026-09-15"
---

# Hybrid Search

## Summary

하이브리드 검색은 키워드 기반 BM25 결과와 벡터 유사도 결과를 합쳐 한 목록으로 돌려주는 검색 방식이다.

## Details

키워드 검색은 정확한 용어에 강하고, 벡터 검색은 바꿔 말한 표현에 강하다. 두 검색기를 따로 돌린 뒤 순위를 합치면 서로의 빈틈을 메운다. 점수 척도가 달라 그대로 더할 수 없으므로 보통 순위만 쓰는 융합 방법을 택한다. 합친 후보 상위 몇십 개를 다시 정밀하게 정렬하는 리랭킹 단계를 붙이기도 한다. 지연 시간은 벡터 질의 한 번만큼 늘어나므로, 타이핑 중에는 키워드 검색만 하고 제출할 때 하이브리드를 쓰는 식으로 나누는 설계가 흔하다.

## Connections

- [[bm25-ranking]] — 키워드 쪽 검색기
- [[vector-embedding]] — 의미 쪽 검색기
- [[reciprocal-rank-fusion]] — 두 목록을 합치는 방법
- [[cross-encoder-reranking]] — 합친 뒤 재정렬

## Open Questions

- 리랭킹 없이 융합만으로 충분한 질의 유형은 무엇인가?
