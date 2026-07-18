# Codex 재검수 요청서 (2차 검수)

작성: 2026-07-19 자율 개선 루프. 사용자가 이 문서를 Codex에 붙여넣으면 된다.

---

신한라이프 FC팀 플랫폼 'myguardian-v2'의 2차 검수다. 역할 고정(검수 전담), 시공 금지.

0. 필독: AGENTS.md, docs/handoff.md, docs/design-review/codex/findings.md(1차 검수),
   docs/design-review/codex/response.md(시공자 판정), docs/design-review/self-audit-20260718.md
1. 브랜치: git checkout -b codex/audit-02 (기준: claude/auto-improve).
   산출물은 docs/design-review/codex/findings-02.md 하나만 커밋.

2. 재검수 질문 (1차 지적의 해소 확인)
a. [치명1] 사례 중복: data/cases/index.json(383건)과 dedup-report.json이 1차 지적을 해소했는가?
   대표 선정(최장 요약) 기준의 부작용, 색인-원본 정합성, 통계 재생성 정확성을 검증하라.
b. [치명4] 고객 중복 적재: 중첩 픽스처(루트 C-* + 하위 fc-*/C-*)에서 수정이 유효한가?
   3단계 중첩, 동일 코드 충돌 시 표시 동작까지 재현하라.
c. [중요1·2] 필터 전체 노출·상세 잔존 수정이 사례·고객·학습 세 화면 모두에서 일관적인가?
d. 1차에서 배포 차단으로 남긴 금감원 82건·검증등급 재분류는 미착수 상태다 — 차단 유지가 맞는지,
   중복 색인 반영 후 영향 범위(금감원 고유 건수)가 달라졌는지 재산정하라.

3. 신규 기능 검수 (자율 사이클 1~8)
a. 홈 통합검색(web/index.html): 사전 지연 로드, 제안 정확성, XSS(사전 데이터 → innerHTML 경로)
b. 학습 사전(web/learn/index.html): 418+275건 표시 정확성, 탭·검색·상세 상태 일치
c. 고객관리 쓰기(web/customers/index.html): memo.md 저장·신규 등록의 파일 무결성,
   원본 profile.json 무변형 원칙 준수, 코드 자동 부여 충돌 케이스
d. 카톡카드(web/card/index.html): 입력 특수문자 처리, 이미지 생성 품질, 골드 사용이 허용 구역에 한정되는지
e. 사례 공유 문구·고객→사례 연결: 문구 정확성, URL 인코딩
f. 케어 리더 글자 조절·진행바: 상태 저장, 접근성

4. 형식: 1차와 동일 ([치명]/[중요]/[제안], 위치·재현·근거·수정 제안). 이미 알려진 미착수
   과제의 재발견은 제외. 총평에 배포 가능 여부를 다시 판정하라.
