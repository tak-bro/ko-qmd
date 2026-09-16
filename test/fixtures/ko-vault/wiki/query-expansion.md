---
type: pattern
aliases:
  - "질의 확장"
  - "query expansion"
topics:
  - "[[topics/information-retrieval|Information Retrieval]]"
status: draft
sources: []
created: "2026-09-15"
updated: "2026-09-15"
---

# Query Expansion

## Summary

쿼리 확장은 사용자가 입력한 질의를 동의어, 약어, 바꿔 쓴 문장으로 늘려 검색이 놓치는 문서를 줄이는 기법이다.

## Details

사용자는 문서에 적힌 용어와 다른 단어로 묻는 경우가 많다. 확장기는 원래 질의에서 키워드용 변형, 의미 검색용 패러프레이즈, 답이 담긴 가상 문서 한 문장을 만들어 각각 검색한다. 언어 모델로 확장하면 품질이 좋지만 영어로만 학습된 모델은 한국어 질의를 엉뚱하게 바꾸기도 한다. 에이전트가 검색 도구를 쓸 때는 에이전트 스스로 변형 질의를 작성하게 하는 편이 모델을 따로 두는 것보다 싸다. 한국어에서는 조사를 뗀 어간형과 영문 용어를 함께 넣는 것이 가장 효과가 크다.

## Connections

- [[korean-morphology]] — 어간형 변형의 근거
- [[hybrid-search]] — 확장 질의를 흘려보내는 곳
- [[retrieval-augmented-generation]] — 생성 파이프라인의 검색 앞단

## Open Questions

- 영어 확장 모델을 한국어로 다시 학습할 만한 데이터가 있는가?
