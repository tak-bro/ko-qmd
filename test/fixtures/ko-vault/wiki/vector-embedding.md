---
type: concept
aliases:
  - "벡터 임베딩"
  - "임베딩 모델"
  - "embedding"
topics:
  - "[[topics/information-retrieval|Information Retrieval]]"
status: draft
sources: []
created: "2026-09-15"
updated: "2026-09-15"
---

# Vector Embedding

## Summary

임베딩은 문장이나 문서를 고정 길이 실수 벡터로 바꿔 의미가 비슷한 텍스트끼리 가까이 놓이게 하는 표현 방식이다.

## Details

임베딩 모델은 대량의 문장 쌍으로 학습되어, 표현이 달라도 뜻이 같은 문장을 가까운 좌표에 둔다. 두 벡터의 코사인 유사도로 관련도를 잰다. 키워드가 하나도 겹치지 않는 질의도 찾아낼 수 있다는 점이 장점이지만, 고유명사나 정확한 코드 식별자는 오히려 놓치기 쉽다. 다국어 모델을 고르지 않으면 한국어 문장의 거리가 부정확해진다. 모델을 교체하면 이미 저장한 벡터를 모두 다시 계산해야 한다. 로컬에서 돌리는 작은 모델은 수백 MB 크기라 노트북 CPU로도 수 분 안에 수백 건을 처리한다.

## Connections

- [[hybrid-search]] — 키워드 검색의 약점을 보완
- [[chunking-strategy]] — 임베딩 입력 길이 제한
- [[retrieval-augmented-generation]] — 생성 전 문맥 검색

## Open Questions

- 한국어 전용 임베딩과 다국어 임베딩의 차이를 우리 코퍼스에서 측정할 수 있는가?
