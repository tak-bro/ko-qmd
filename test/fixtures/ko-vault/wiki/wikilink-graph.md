---
type: concept
aliases:
  - "위키링크 그래프"
  - "wikilink"
topics:
  - "[[topics/knowledge-operations|Knowledge Operations]]"
status: draft
sources: []
created: "2026-09-15"
updated: "2026-09-15"
---

# Wikilink Graph

## Summary

위키링크 그래프는 문서 사이의 이중 대괄호 링크를 간선으로 보고 만든 연결망으로, 고립 문서와 허브 문서를 드러낸다.

## Details

문서마다 나가는 링크와 들어오는 백링크를 세면 어떤 개념이 중심인지 보인다. 들어오는 링크가 하나도 없는 고립 문서는 찾아가기 어려워 사실상 버려진다. 링크 대상 이름에 별칭을 붙이면 본문에는 자연스러운 한국어를 보이고 파일 이름은 영어 슬러그로 유지할 수 있다. 검색 결과에서 한 단계 이웃 문서를 함께 보여 주면 질의와 직접 겹치지 않는 관련 문서도 발견된다. 파일 이름을 바꾸면 기존 링크가 끊기므로 개명은 전체 치환과 함께 해야 한다.

## Connections

- [[zettelkasten]] — 링크 중심 구조의 원형
- [[topic-map]] — 허브 문서
- [[lint-automation]] — 고립·끊긴 링크 검사

## Open Questions

- 고립 문서 비율의 적정 상한은 얼마인가?
