# Codex 재검수 요청서 (3차 — 새 PC 세션 대량 업데이트)

작성: 2026-07-21. 사용자(안창민 FC)가 이 문서를 Codex에 붙여넣는다.

---

신한라이프 FC팀 플랫폼 `myguardian-v2`의 3차 검수다. 역할 고정: **검수 전담, 시공 금지.**

## 0. 필독
- AGENTS.md(= CLAUDE.md, 헌법 — 특히 디자인 개정 10차·모션 예외·개인정보 마스킹 조항)
- docs/decisions.md (7/20~21 신규 결정 다수 — 이 세션의 근거)
- docs/handoff.md (7/20 세션 기록 2건)
- docs/MYGUARDIAN-V2-DESIGN-SYSTEM.md (디자인 시스템 기준)
- docs/design-review/codex/findings-02.md 등 기존 검수(이미 해소된 지적의 재발견은 제외)

## 1. 브랜치
- git checkout -b codex/audit-03 (기준: main = 9aea04c 또는 최신)
- 산출물은 docs/design-review/codex/findings-03.md 하나만 커밋.

## 2. 이 세션 변경 범위 (검수 대상)
main에 28개 커밋. 주요 시공물:

### A. 디자인 전면 개편 (개정 10차)
- web/assets/platform.css 전면 개편: 다크 네이비 2-톤 사이드바(#102a4e + 시안 4px),
  포인트 #0758d6, radius 6/4/3, 선 중심 면 구분, 0.14초 색 전환만, 칸막이형 지표 격자.
- web/assets/style.css :root 팔레트 정합(케어·카톡카드 공유). issue 리더·카톡카드가
  팔레트 변경에 영향받지 않는지(딥네이비+골드·잡지 섹션 컬러 보존) 확인.
- 시작 스플래시(web/index.html): 세션당 1회, prefers-reduced-motion 처리, 헌법 모션 예외.

### B. 서비스워커 (재발 위험 영역)
- web/sw.js v2: 자산 stale-while-revalidate로 전환(구버전 CSS 고정 결함 수정).
  캐시 무한 고정·오프라인 폴백·개인정보(JSON) 캐시 여부를 검증하라.

### C. 고객관리 쓰기 확장 (web/customers/index.html)
- 진행상태 분류(profile.json "진행상태") + 미팅 차수 일정(profile.json "미팅").
  차수 자동 제안(취소 시 재사용), 소속 이동/저장 실패 시 메모리 원복,
  v1 이관 프로필(v1원본) 무변형 원칙 준수, FSA 쓰기 무결성을 재현·검증하라.

### D. 청구·지급 재구성 (web/claims/index.html)
- 판정 도구 금지 원칙. 분쟁 사례 자료실(색인 383 연결) + 사유별 서류 12유형 +
  실손24 안내(실손 유형만) + 보험사 변경 현황 패널.
- XSS(사례·서류·monitor-state 데이터 → innerHTML 경로), 고정 고지 문구 유지 확인.

### E. 보험사 감시 파이프라인 (pipeline/monitor_insurers.py)
- headless 렌더링으로 34개 청구안내 페이지 지문(해시) 비교. 접속실패 시 baseline 보존,
  본문 과소 판정(40자), monitor-state.json 정합성, 개인정보 미포함을 검증하라.
- data/claims/insurers.json(41개사) URL 신뢰성은 조사 확인분(일부 미확인 null)임을 감안.

### F. 관리자 화면 (web/admin/index.html)
- 미노출 원칙 유지 확인. 카톡 초대 문구 생성, 편집형 조직도(직급 변경·소속 이동 순환 방지·
  추가·삭제·기기 저장·JSON 내보내기). 순환 참조 차단이 완전한지 재현하라.

### G. 케어 공유 발행 (web/care/issue.html·desk.html, web/assets/care.js)
- ?fc=코드 에디션(제호·발행인·카톡 서명 교체, 편집장 안창민 고정, 무효 코드 폴백).
  data/care/publishers.json. 내용 무변형 원칙 준수 확인.

## 3. 중점 검증 요청
1. 디자인 정합: 전 화면(홈·고객·청구·사례·학습·브리핑·우리팀·케어·카톡카드·설치·관리자)이
   개정 10차 언어를 일관 적용했는가. 옛 style.css 잔재로 톤이 어긋나는 화면이 있는가.
2. 서비스워커 캐시 안전성(B) — 재발 방지가 확실한가.
3. 고객관리 쓰기 무결성(C) — 저장 실패·경합·원복 경로.
4. XSS·데이터 신뢰성 원칙(판례 생성 금지·고지 문구·마스킹)이 신규 화면에서 지켜지는가.
5. 접근성(키보드·포커스·터치 44px)과 3해상도(1920/1180/390) 무깨짐.

## 4. 형식
1·2차와 동일: [치명]/[중요]/[제안] + 위치·재현·근거·수정 제안. 이미 해소된 지적의
재발견은 제외. 총평에 **배포 가능 여부**를 판정하라. 시공은 하지 말 것(지적만).
