# 현재 구현 상태

기준: main 병합본. 갱신일 2026-07-21 (새 PC 세션: 디자인 개정 10차·청구 재구성·보험사 감시·관리자 화면 반영).

## 화면 (web/)

| 화면 | 상태 | 비고 |
|---|---|---|
| 홈 | 완성 | 내 프로필(명함) 최상단, 통합검색, 자료 현황 타일(칸막이 격자), 발행 D-day·최근 열람. 시작 스플래시(세션당 1회). 개정 10차 디자인 |
| 고객관리 | 완성 (읽기+쓰기) | 로컬 폴더 연결, 검색·필터·상세, 메모 저장, 신규 등록, 이관·삭제. **진행상태 분류**(배지·필터·원클릭) + **미팅 차수 일정**(자동 차수·완료·취소, 진행상태 연동) 신규 |
| 사례·판례 | 완성 | 서비스 색인 383건, 검색·탭·필터·2단 상세, 등급 배지, 공유 문구, ?q=/?id= 진입 |
| 청구·지급 | 완성·재정의 (2026-07-21) | 판정 도구 금지 원칙. 분쟁 사례 자료실(색인 383 연결) + 사유별 서류 가이드 12유형(실손24 안내 포함) + 보험사 청구 안내 변경 현황(41개사 자동 감시). 알릴의무 셀프체크는 제거 |
| 학습 | 완성 | 용어 418·질병 275 검색·상세 |
| 브리핑 (brief/) | 1차 완성 + 업로드 확장 | 상담·교육·강의 3모드. 발표자·청중 두 창 동기화. 로컬 자료 4형식 + 스크립트 사이드카, IndexedDB 전달, pdf.js 내장. 2차(원격 동기화) 미착공 |
| 우리팀 (team/) | 팀 관리 도구 | 주간 확인표 + 월간 캘린더(케어 발행 자동) + 과제 + 공지 + 출근·Aitom 배지. **조직도 데이터(org.json) 신설** — 관리자 화면에서 편집. members·schedule 실데이터 입력은 사용자 몫 |
| 케어센터 | 완성 | 서재 15권 + 12호, 잡지 리더, 카톡 문구 작성함, 발행인/편집장 체계. **공유 발행(팀원 에디션 ?fc=)**. 서재·데스크 셸 개정 10차 통일 |
| 카톡카드 | 완성 | 실시간 미리보기+이미지 저장, 금액 형식 검증. 딥네이비+골드 보존 |
| 관리자 (admin/) | 완성 (2026-07-21) | 미노출(주소 직접). 카톡 초대 문구 생성 + 편집형 조직도(직급 변경·소속 이동·추가·삭제). 승인·조인웍은 2차 |
| 설치 (install.html) | 완성 (2026-07-21) | 기기별 안내·상태 배지·주소 복사. 서비스워커 앱 셸 캐시(stale-while-revalidate) |
| 고객 리포트 (r/) | 준비중 | |

## 데이터 (data/)

- 사례: 원본 726건 보존 + 서비스 색인 383건 (중복 그룹 228, 복수 쟁점 35그룹 쟁점목록 보존)
- 등급(전량 검증 공정 통과 필수 — 커버리지 안전장치): 검증완료 209 / 부분검증 147 / 미검증-참고용 27
- 검증 보고서 3종: fss(금감원 129) · scourt(법원 243) · tribunal(조세심판원 9)
- 용어 418 · 질병 275 / 케어 15호 + 최적화 이미지(8.4MB)
- 브리핑 문서 1건 (brief/) — 주간 11호 변환 샘플(강의 모드, 22페이지). 스키마 brief-doc.schema.json, 변환 공정 pipeline/brief_from_care.py. 상담용(보장분석) 문서는 공개 저장소 금지 — 로컬 고객 저장소에 두고 파일로 연다
- 우리팀: notices·members·schedule·tasks + 조직도 org.json(직급표·구성원 트리) + 스키마 (실데이터 입력 대기)
- 케어: publishers.json(발행인 3인) — 공유 발행 대상
- 청구: doc-guide.json(서류 12유형 + 실손24) / insurers.json(보험사 41개사) / monitor-state.json(감시 지문) + 스키마
- 고객 실데이터는 저장소 외부: C:/projects/mg-clients-fc01~03 (270명, 새 PC 미복사 — docs/migration-todo.md)

## 파이프라인 (pipeline/)

- 운영: ingest_backup, migrate_clients(실행 완료), scrape_care, optimize_images, build_case_index, verify_fss, verify_scourt, brief_from_care
- 케어 발행: collect_news(네이버 API), new_care_issue, publish_care_issue
- **보험사 감시: monitor_insurers.py** — headless 렌더링 지문 비교, 월 1회 자동(작업 스케줄러 MyGuardianInsurerMonitor, 매달 1일 09:00). run_monitor.cmd 래퍼
- 뼈대: collect_fss, collect_law, tag_cases(재분류 대기), report/p1~p5(보장분석, 고객 데이터 대기)

## 검증·환경

- 새 PC(2026-07-20~): Python 3.12.10 + playwright/jsonschema/pillow + Chromium, gh CLI(로그인 완료). GitHub Pages 활성
- scripts/verify_review.py 29건 / scripts/screenshot.py 3해상도(HTTP 서빙) — 쿼리 URL 파일명 미지원(개선 항목)
- scripts/verify_brief.py — 브리핑 동기화 자동 검증 15항목(페이지·포인터·영상 실이동·늦은 입장·선개설·기형 메시지 내성·로컬 동선·PDF 사이드카·HTML 스크롤·PDF/HTML 스크립트·스크립트 비노출·콘솔) + 3해상도 스크린샷
- 공용 web/assets/platform.js (이스케이프·복사·사이드바)
- .claude/launch.json — 정적 미리보기 서버 (8123 / static-8124)
- Python 3.12 + Playwright, Node 없음
