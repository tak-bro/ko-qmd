---
type: concept
aliases:
  - "n-gram 토큰화"
  - "bigram"
topics:
  - "[[topics/information-retrieval|Information Retrieval]]"
status: draft
sources: []
created: "2026-09-15"
updated: "2026-09-15"
---

# N-gram Tokenization

## Summary

n-gram 토큰화는 텍스트를 연속된 n개 글자 조각으로 잘라 색인하는 방식으로, 사전 없이 부분 일치 검색을 가능하게 한다.

## Details

음절 unigram은 글자 하나씩, bigram은 이웃한 두 글자씩 자른다. 예를 들어 세 글자 어절은 bigram 두 개가 된다. 띄어쓰기가 달라도 같은 글자 조각이 생기므로 붙여 쓴 복합어와 띄어 쓴 표현이 서로 매치된다. 대신 색인 크기가 커지고, unigram은 흔한 글자가 너무 많은 문서에 걸려 랭킹 변별력이 낮다. bigram은 변별력이 높지만 한 글자 질의를 못 찾는다. 그래서 unigram과 bigram을 함께 넣는 합집합 방식이 자주 쓰인다. 중국어·일본어 검색에서 오래 쓰여 온 방법이다.

## Connections

- [[inverted-index]] — n-gram 토큰이 들어가는 곳
- [[korean-morphology]] — 형태소 분석과의 비교

## Open Questions

- 합집합 방식이 색인 크기를 얼마나 늘리는가?
