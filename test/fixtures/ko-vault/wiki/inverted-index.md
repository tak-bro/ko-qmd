---
type: concept
aliases:
  - "역색인"
  - "inverted index"
topics:
  - "[[topics/information-retrieval|Information Retrieval]]"
status: draft
sources: []
created: "2026-09-15"
updated: "2026-09-15"
---

# Inverted Index

## Summary

역색인은 단어마다 그 단어가 등장하는 문서와 위치 목록을 저장해 키워드 검색을 빠르게 만드는 자료구조다.

## Details

책 뒤편의 찾아보기처럼 단어에서 문서로 가는 방향을 미리 만들어 둔다. 색인 시점에 문서를 토큰으로 쪼개고, 각 토큰에 포스팅 리스트를 붙인다. 위치 정보를 함께 저장하면 구문 검색, 즉 여러 단어가 붙어서 나오는지 확인하는 phrase 질의가 가능하다. SQLite FTS5 같은 내장 전문 검색 모듈도 내부적으로 역색인을 쓴다. 문서를 고치면 해당 포스팅을 갱신해야 하므로 대량 수정 뒤에는 재색인이 필요하다. 토큰화 규칙을 바꾸면 기존 색인과 호환되지 않아 전체를 다시 만들어야 한다.

## Connections

- [[bm25-ranking]] — 역색인 위에서 계산하는 랭킹
- [[ngram-tokenization]] — 색인 토큰을 만드는 규칙
- [[chunking-strategy]] — 색인 단위 결정

## Open Questions

- 문서 수백 건 규모에서 재색인 비용을 무시해도 되는가?
