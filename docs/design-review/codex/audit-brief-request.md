# Codex 검수 요청서 — 브리핑 시스템 1차 (claude/brief)

작성: 2026-07-19 앱 Code 세션. 사용자가 이 문서를 Codex에 붙여넣으면 된다.

---

신한라이프 FC팀 플랫폼 'myguardian-v2'의 브리핑 시스템 1차 검수다. 역할 고정(검수 전담), 시공 금지.

0. 필독: AGENTS.md, docs/handoff.md 최신 항목, docs/decisions.md의
   "브리핑 시스템 1차"·"헌법 개정 2차" 조항, data/schema/brief-doc.schema.json
1. 브랜치: git checkout -b codex/audit-04 (기준: claude/brief).
   산출물은 docs/design-review/codex/findings-brief.md 하나만 커밋.
2. 검수 대상: web/brief/(index·present·view·brief.js·brief.css),
   data/brief/(index.json·lecture-2026-001.json), pipeline/brief_from_care.py,
   scripts/verify_brief.py, 헌법 개정 반영분(CLAUDE.md·AGENTS.md·전 화면 사이드바)

3. 검수 질문

a. 동기화 규약·경합
   - 메시지 규격 v1(page/pointer/video/hello/state/doc)의 수신 검증이 충분한가?
     악의적·기형 메시지(같은 origin의 다른 탭에서 채널명만 맞춰 송신)에 view가 안전한가?
   - 늦은 입장 경합(문서 로드 전 state 도착)은 버퍼링으로 수정됨 — 남은 경합이 있는가?
     (예: 발표자 새로고침, 청중 창 다중 개설, 로컬 문서 재전송 시점)
   - 운반/규약 계층 분리가 실제로 2차(WebSocket) 교체를 감당하는 구조인가?

b. 보안·개인정보 (상담 모드가 고객 보장분석을 다룬다 — 최우선)
   - XSS: 렌더러가 innerHTML 없이 textContent로만 조립되는지 전 경로 확인.
     문서 JSON의 모든 문자열 필드(제목·본문·스크립트·캡션·킥커)로 주입 시도하라.
   - 경로 검증: ?doc=/?src= 파라미터와 문서 내 이미지·영상 경로의 이탈(.., 절대경로,
     외부 URL) 차단이 완전한가? assetUrl·loadDocBySrc의 정규식 우회 가능성.
   - 로컬 문서가 sessionStorage를 거친다 — 개인정보 잔존 위험 평가(닫은 뒤 수명,
     같은 origin 다른 화면에서 접근 가능성). 외부 전송이 없는지 네트워크 관점 확인.
   - 스크립트(발표자 전용)가 청중 창 DOM에 어떤 경로로도 실리지 않는가?
     (doc 메시지로 문서 전체가 청중 창에 전달되는 설계다 — 1차(같은 기기)에서 허용
     가능한지, 2차 원격에서 금지 조건이 문서화만으로 충분한지 판정하라.)

c. 데이터 신뢰성
   - 변환 공정(brief_from_care.py)이 추출·재배치만 하는가? 원문(weekly-11.json)과
     대조해 문장 생성·변형이 없는지 표본 검증하라. 번호형 문단의 소제목 승격과
     800자 분할이 내용을 왜곡하는 경우가 있는가?
   - lecture-2026-001.json이 스키마에 실제 합치하는가(재검증). index.json 메타
     (페이지수 22 등)와 본체의 정합성.

d. 화면·헌법 준수
   - 발표자 다크 화면과 청중 잡지 조판이 헌법 디자인 조항(서체 용법: 세리프는
     지면 제목만, 이모지·장식 금지, 전환 0.2초, 상태색 용법)을 지키는가?
   - 3해상도(1920/1180/390) 및 태블릿 상담 시나리오에서 깨짐이 없는가?
     캔버스 배율(1280×800 scale) 방식의 흐림·성능 부작용 평가.
   - 접근성: 키보드만으로 발표 진행 가능한가, 포커스 링, prefers-reduced-motion.
   - 사이드바 9메뉴가 전 화면에서 순서·활성 표시 일관인가(브리핑 화면 포함).
     헌법 개정 2차(상한 9개)가 CLAUDE.md·AGENTS.md에 동일 반영됐는가.

e. 검증 스크립트 적정성
   - scripts/verify_brief.py 10항목이 실효 검증인가, 통과 조건이 느슨한 항목은
     없는가? (특히 영상 seek — 검증 클립이 탐색 불가 매체라 두 창 시각 일치만
     확인함. 이 한계의 보완 방법을 제안하라.)

4. 형식: 기존과 동일 ([치명]/[중요]/[제안], 위치·재현·근거·수정 제안).
   총평에 main 병합 가능 여부를 판정하라. 시공 수정은 하지 말고 지적만 하라.
