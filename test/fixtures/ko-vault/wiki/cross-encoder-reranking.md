---
type: concept
aliases:
  - "교차 인코더 재순위화"
  - "리랭킹"
  - "reranker"
topics:
  - "[[topics/information-retrieval|Information Retrieval]]"
status: draft
sources: []
created: "2026-09-15"
updated: "2026-09-15"
---

# Cross-Encoder Reranking

## Summary

리랭킹은 1차 검색이 뽑은 후보 문서를 질의와 함께 모델에 넣어 관련도를 다시 계산하고 순서를 바로잡는 단계다.

## Details

크로스 인코더는 질의와 문서를 한 입력으로 이어 붙여 판단하므로 임베딩 거리보다 정밀하지만 느리다. 그래서 전체 코퍼스가 아니라 상위 30~60개 후보에만 적용한다. 리랭커가 강하면 1차 검색의 약점이 가려져, 키워드 검색 품질이 떨어져도 최종 수치가 유지되는 착시가 생긴다. 그래서 평가할 때는 리랭킹 전 단계의 재현율도 따로 기록해야 한다. 로컬 리랭커 모델은 수백 MB로, 데스크톱 앱에 상주시키면 메모리 부담이 크다.

## Connections

- [[hybrid-search]] — 리랭킹 앞단의 후보 생성
- [[recall-at-k]] — 단계별로 따로 측정

## Open Questions

- 후보 수를 30에서 60으로 늘릴 때 지연 대비 이득이 있는가?
