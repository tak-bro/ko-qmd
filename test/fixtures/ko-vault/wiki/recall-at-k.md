---
type: concept
aliases:
  - "재현율@k"
  - "recall@k"
topics:
  - "[[topics/information-retrieval|Information Retrieval]]"
status: draft
sources: []
created: "2026-09-15"
updated: "2026-09-15"
---

# Recall at K

## Summary

Recall@k는 정답 문서가 검색 결과 상위 k개 안에 몇 개나 들어왔는지의 비율로, 검색 품질을 숫자로 비교하는 기본 지표다.

## Details

정답이 하나인 질의에서는 상위 k 안에 있으면 1, 없으면 0이 된다. 여러 질의에 대한 평균을 내서 검색기끼리 비교한다. MRR은 첫 정답이 나온 순위의 역수를 평균한 값이라, 정답을 찾았는지뿐 아니라 얼마나 위에 올렸는지를 본다. k를 5로 잡는 이유는 사람이 결과 목록에서 한눈에 훑는 범위가 대략 그 정도이기 때문이다. 질의 수가 수십 개 수준이면 한두 문항 차이로 수치가 크게 요동하므로, 유형별 표를 함께 보고 이상치를 확인해야 한다.

## Connections

- [[golden-dataset]] — 지표를 계산할 정답 목록
- [[reciprocal-rank-fusion]] — 융합 효과 측정
- [[cross-encoder-reranking]] — 단계별 측정

## Open Questions

- 5포인트 차이를 유의미하다고 볼 최소 질의 수는 얼마인가?
