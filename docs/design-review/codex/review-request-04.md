# Codex 4차 검수 요청 — 시각 라운드 + 케어 발행 공정

- 대상 브랜치: claude/auto-improve
- 범위: f4c8524..28b76ce (3차 재심 통과 이후 전체)
- 판정 형식: 배포 가능/불가 + 발견 사항을 치명/중요/사소로 분류. 응답은 한국어.
- 역할 경계: 검수·검증만. 수정 시공은 Claude Code가 한다.

## 이번 라운드 변경 요약

1. 이미지 12종 반입·배치 (df17518): 플랫폼 배경 질감, 홈 히어로, 서재·리포트 실사 헤더,
   빈 상태 일러스트(투명 PNG), 리더 표지 원단 질감, 카톡카드 배경 2종. 총 2.1MB
2. 내 프로필·자동 명함 (df17518): localStorage 프로필(이름·직함·지점·연락처·전문분야·사진),
   케어 카톡 서명(mg_care_sender) 동기화, html2canvas 명함 생성(CDN 지연 로드)
3. 모션 3종 (df17518): 수치 카운트업, 표지 호버 확대, 버튼 누름 반응 (reduced-motion 분기)
4. 사파리 iOS 설치 안내 (f23ea58): beforeinstallprompt 부재 기기 수동 안내 패널
5. UX 라운드 (06760ac): 카드 번호 장식 제거, 고객관리 삭제(2단계 확인)·이관(복사→검증→원본 삭제),
   케어 발행 데스크 1차
6. 케어 워크스페이스 재편 (0ce74c6): 사이드바(발행 데스크/서재/홈), desk.html 신설,
   공용 care.js 추출, 발행 상태(초안/발행) 도입, 파이프라인 3종
   (collect_news / new_care_issue / publish_care_issue), weekly-12 초안 생성
7. NAVER API HUB 전환 (6f7827c): 구 openapi.naver.com → naverapihub.apigw.ntruss.com
8. 가제 주도 공정 (de53ff1, 28b76ce): 기획 구획(가제 입력·localStorage), 집필 지시문 생성,
   --query 모드(뉴스+백과사전), 주제 추천 지시문

## 중점 검수 요청 (위험도 순)

1. **고객관리 이관·삭제** (web/customers/index.html): 파일 유실 시나리오.
   - 이관 중 복사 실패 시 원본 보존·대상 사본 정리가 실제로 보장되는가
   - 대상 저장소 동일성 검사(isSameEntry)와 코드 충돌 검사에 빈틈이 있는가
   - 삭제 확인 UI가 다른 고객으로 오도될 경로가 있는가 (목록 갱신 타이밍)
2. **발행 공정 정합성** (pipeline/*.py, data/care/issues.json):
   - new_care_issue 채번이 발행인·채널 조합에서 충돌 없는가 (팀원 slug 포함)
   - publish_care_issue 검증 항목 누락 (커버 없이 발행 허용이 의도임 — 표지 없는 호 전례 존재)
   - 상태:초안 필터 누락 화면이 있는가 (서재/홈/최신호/카톡문구/발행인 탭은 처리함.
     리더 issue.html 직접 URL 접근은 검토용으로 의도적으로 허용)
3. **care.js 추출 회귀**: 서재·데스크의 카톡 문구가 기존 15호에서 이전과 동일하게 생성되는가
4. **프로필·명함**: XSS(esc 처리 누락), localStorage 파손 시 복구, 사진 dataURL 용량 한계
5. **카톡카드 배경 2종**: html2canvas가 background-image를 PNG에 포함하는가 (로컬 자산, useCORS)
6. **이미지 배치**: 경로 오타, 미사용 자산(hero-team·hero-care-2·hero-report-2는 예비로 의도),
   모바일 성능(배경 fixed cover)
7. **케어 사이드바 셸**: 구 .sidebar 컴포넌트 재사용이 platform.js 토글과 충돌하는 경우

## 이미 수행한 검증 (재검증 환영)

- Playwright: 3해상도 스크린샷 15장, 카드 배경 전환, 리더 표지, 프로필 수정 모드,
  iOS UA 설치 안내, OPFS 모의 저장소 이관·삭제(하위 폴더 포함 실파일 확인),
  발행 데스크 D-day·초안 표시·후보 60건 렌더·지시문 클립보드, 콘솔 오류 0
- publish_care_issue: 빈 초안 발행 차단 18건 검출 확인
- NAVER API HUB 실키 수집 60건 성공 (키 파일은 gitignore, 저장소 미포함)

## 알려진 한계 (검수 대상 아님)

- 홈 팀 캘린더 자리표시 카드: 우리팀 세션(claude/team-workspace) 소관으로 존치
- 사이드바에 우리팀 메뉴 미반영: 동일 사유 (병합 시 팀 세션 변경분과 합쳐짐)
- data/care/desk/candidates.json·naver-keys.json: 로컬 전용, gitignore 등록
- 2차 공사(Workers 화면 내 생성·수집)는 착공 전
