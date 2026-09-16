---
type: concept
aliases:
  - "상호 순위 융합"
  - "RRF"
topics:
  - "[[topics/information-retrieval|Information Retrieval]]"
status: draft
sources: []
created: "2026-09-15"
updated: "2026-09-15"
---

# Reciprocal Rank Fusion

## Summary

RRF는 여러 검색 결과 목록에서 각 문서의 순위 역수를 더해 최종 순서를 정하는 단순한 융합 공식이다.

## Details

문서 d의 점수는 각 목록에서의 순위 r에 대해 1/(k+r)을 모두 더한 값이다. 상수 k는 보통 60을 쓰며, 상위권 차이를 완만하게 만든다. 원래 점수를 쓰지 않고 순위만 쓰기 때문에 BM25 점수와 코사인 유사도처럼 척도가 전혀 다른 결과도 정규화 없이 합칠 수 있다. 어느 한 목록에만 나온 문서도 점수를 받으므로 재현율이 떨어지지 않는다. 구현이 몇 줄이라 튜닝 부담이 적은 대신, 목록별 가중치를 따로 줄 수는 있다.

## Connections

- [[hybrid-search]] — RRF를 쓰는 대표 구성
- [[recall-at-k]] — 융합 효과를 재는 지표

## Open Questions

- 쿼리 확장으로 생긴 변형 질의 목록에 가중치를 낮게 줘야 하는가?
