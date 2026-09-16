---
type: pattern
aliases:
  - "인제스트 파이프라인"
  - "ingest"
topics:
  - "[[topics/knowledge-operations|Knowledge Operations]]"
status: draft
sources: []
created: "2026-09-15"
updated: "2026-09-15"
---

# Ingest Pipeline

## Summary

수집 파이프라인은 새로 들어온 클리핑을 원본 폴더로 옮기고 핵심 개념을 wiki 문서로 정리하는 하루 단위 작업 흐름이다.

## Details

받은편지함 폴더에 쌓인 자료를 하루 한 번 묶어서 처리한다. 먼저 중복 여부를 색인에서 확인하고, 기존 문서를 고칠지 새 문서를 만들지 정한다. 원본은 추가 전용 폴더로 옮기고, wiki 문서 프론트매터에 출처 경로를 남긴다. 작업 브랜치를 따로 만들어 변경을 모은 뒤 풀 리퀘스트로 사람이 검토한다. 실행마다 실행 기록 노트를 남겨 무엇을 처리했는지 추적한다. 에이전트가 없으면 수동 대체 절차로 같은 결과를 낸다.

## Connections

- [[append-only-archive]] — 원본 보관
- [[provenance-tracking]] — 출처 기록
- [[lint-automation]] — 수집 후 검증
- [[meeting-notes-workflow]] — 회의록도 같은 경로로 수집

## Open Questions

- 클리핑이 수십 건 쌓였을 때 배치를 나누는 기준은?
