---
type: concept
aliases:
  - "한국어 형태소 분석"
  - "형태소 분석"
topics:
  - "[[topics/information-retrieval|Information Retrieval]]"
status: draft
sources: []
created: "2026-09-15"
updated: "2026-09-15"
---

# Korean Morphology

## Summary

한국어는 어간에 조사와 어미가 붙는 교착어라서, 검색에서는 어절을 형태소로 나누거나 조사를 떼는 처리가 필요하다.

## Details

같은 명사가 문장마다 '검색은', '검색을', '검색에서'처럼 다른 어절로 나타난다. 공백 단위로 색인하면 이들이 서로 다른 단어가 되어 키워드 검색이 실패한다. 형태소 분석기는 사전과 통계 모델로 어절을 쪼개지만 신조어와 외래어 표기에서 흔들리고 배포 크기가 크다. 가벼운 대안은 끝에 붙는 흔한 조사 목록만 떼어 내는 규칙이다. 두 음절 이하 단어에서 떼면 뜻이 망가지므로 길이 조건을 둔다. 띄어쓰기가 사람마다 다른 문제는 형태소 분석으로도 완전히 풀리지 않아 음절 n-gram과 함께 쓰기도 한다.

## Connections

- [[ngram-tokenization]] — 분석기 없이 쓰는 대안
- [[bm25-ranking]] — 토큰 단위가 점수에 주는 영향
- [[query-expansion]] — 질의 쪽에서 흡수하는 방법

## Open Questions

- 조사 규칙만으로 형태소 분석기 대비 몇 퍼센트를 따라가는가?
