---
type: pattern
aliases:
  - "골드셋"
  - "정답 데이터셋"
  - "golden set"
topics:
  - "[[topics/information-retrieval|Information Retrieval]]"
status: draft
sources: []
created: "2026-09-15"
updated: "2026-09-15"
---

# Golden Dataset

## Summary

골드셋은 질의마다 정답 문서를 사람이 확정해 둔 평가용 목록으로, 검색 개선을 감이 아니라 수치로 판정하게 해 준다.

## Details

먼저 문서를 읽고 유형별로 질의 초안을 만든 뒤, 담당자가 정답 문서를 하나에서 세 개까지 확정한다. 정답이 확정되기 전의 수치는 기준선으로 쓰지 않는다. 질의 유형은 정확한 용어, 동의어·약어, 바꿔 말하기, 주제 질의, 여러 문서에 걸친 질의로 나누어 분포를 정한다. 평가 데이터가 개선 대상 코드와 같은 사람 손에서 반복 수정되면 과적합이 생기므로 버전을 매기고 변경 이력을 남긴다. 개인 문서로 만든 골드셋은 공유 저장소에 올리지 않고 로컬에만 둔다.

## Connections

- [[recall-at-k]] — 골드셋으로 계산하는 지표
- [[decision-record]] — 정답 확정 이력 기록

## Open Questions

- 합성 픽스처 골드셋이 실제 코퍼스 수치를 얼마나 예측하는가?
