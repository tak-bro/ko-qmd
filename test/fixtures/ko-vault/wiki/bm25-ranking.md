---
type: concept
aliases:
  - "BM25 랭킹"
  - "BM25"
topics:
  - "[[topics/information-retrieval|Information Retrieval]]"
status: draft
sources: []
created: "2026-09-15"
updated: "2026-09-15"
---

# BM25 Ranking

## Summary

BM25는 단어 빈도와 문서 길이를 함께 보정해 질의와 문서의 관련도를 점수로 매기는 확률적 랭킹 함수다.

## Details

BM25는 TF-IDF 계열 함수를 개선한 것으로, 같은 단어가 반복될수록 점수가 오르지만 포화 파라미터 k1 때문에 무한정 오르지는 않는다. 파라미터 b는 긴 문서가 단어를 우연히 많이 포함하는 효과를 누르는 길이 정규화 강도다. 희귀한 단어일수록 역문서빈도(IDF)가 커서 점수 기여가 크다. 검색 엔진은 BM25 점수를 계산하기 위해 역색인에서 단어별 문서 목록을 읽는다. 한국어처럼 조사가 붙는 언어에서는 어절 단위 토큰이 서로 달라져 빈도 계산이 흩어지므로, 토큰화 방식이 BM25 품질을 크게 좌우한다.

## Connections

- [[inverted-index]] — 점수 계산에 필요한 단어별 문서 목록
- [[ngram-tokenization]] — 한글 토큰 단위 선택
- [[hybrid-search]] — 벡터 검색과 결합

## Open Questions

- 짧은 wiki 문서 위주의 코퍼스에서 b 값을 낮추는 편이 나은가?
