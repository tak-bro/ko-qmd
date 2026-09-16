---
type: pattern
aliases:
  - "의사결정 기록"
  - "ADR"
topics:
  - "[[topics/knowledge-operations|Knowledge Operations]]"
status: draft
sources: []
created: "2026-09-15"
updated: "2026-09-15"
---

# Decision Record

## Summary

의사결정 기록은 중요한 기술 결정을 배경, 선택지, 결정, 결과로 짧게 남겨 나중에 왜 그렇게 했는지 추적하게 하는 문서 형식이다.

## Details

아키텍처 결정 기록(ADR)이라는 이름으로 소프트웨어 팀에서 널리 쓰인다. 결정 하나당 파일 하나를 만들고 번호를 붙이며, 뒤집힌 결정은 지우지 않고 대체됨으로 표시한다. 회의에서 합의한 내용이 채팅에만 남으면 몇 달 뒤 같은 논쟁을 반복한다. 기록에는 버린 선택지와 그 이유를 꼭 적는다. 평가 기준이나 정답 목록을 바꾼 이유도 같은 방식으로 남기면 수치 비교의 신뢰가 유지된다.

## Connections

- [[meeting-notes-workflow]] — 결정이 나오는 곳
- [[golden-dataset]] — 평가 기준 변경 이력
- [[append-only-archive]] — 대체된 결정 보존

## Open Questions

- 결정 기록과 프로젝트 README의 상태 필드는 어떻게 나눌까?
