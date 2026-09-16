---
type: pattern
aliases:
  - "회의록 워크플로"
  - "meeting notes"
topics:
  - "[[topics/knowledge-operations|Knowledge Operations]]"
status: draft
sources: []
created: "2026-09-15"
updated: "2026-09-15"
---

# Meeting Notes Workflow

## Summary

회의록 작성 흐름은 녹음이나 받아쓰기 텍스트를 주제별로 정리하고 결정과 할 일을 분리해 남기는 절차다.

## Details

음성 인식 결과는 말버릇과 중복이 많아 그대로 저장하면 나중에 찾기 어렵다. 먼저 안건별로 문단을 나누고, 결정된 사항과 담당자가 정해진 할 일을 따로 뽑는다. 결정 중 오래 영향을 주는 것은 의사결정 기록으로 옮기고, 반복되는 개념은 wiki 문서로 승격한다. 참석자의 개인 평가나 민감한 발언은 정리 단계에서 지운다. 회의록 원문은 수집 파이프라인을 따라 원본 폴더에 보관된다.

## Connections

- [[decision-record]] — 결정 사항 이관
- [[ingest-pipeline]] — 원문 수집 경로

## Open Questions

- 받아쓰기 품질이 낮을 때 화자 구분을 어떻게 보정할까?
