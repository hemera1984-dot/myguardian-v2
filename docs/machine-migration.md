# 다른 PC로 이관하기 (업무용 노트북 등)

작업 환경은 세 덩어리로 나뉘고, 각각 옮기는 방법이 다르다.
① 저장소(git으로 자동) ② git 밖 파일(수동 복사) ③ 대화 기록·메모리(폴더 복사)

## 기기 역할 (2026-07-19 확정)

| 기기 | 역할 | 필요한 것 |
|---|---|---|
| 업무용 노트북 | **주력 1대** — 개발·케어센터 발행·고객관리·보장분석·브리핑 | 아래 전체 이관 절차 |
| 개인(집) 노트북 | **사용 전용** — 마이가디언 웹앱 열람·조회 | 브라우저만. GitHub Pages 주소 접속 후 홈 화면에 설치 |

개인 노트북에는 개발 도구·고객 데이터를 두지 않는다. 따라서 아래 1~6절은 업무용 노트북에만 해당한다.
개인 노트북은 Pages 주소를 열고 "홈 화면에 바로가기 설치"만 누르면 끝이다.

## 0. 가장 중요한 전제 — 같은 경로를 쓴다

새 PC에서도 저장소를 **`C:\projects\myguardian-v2`** 에 둔다.
Claude Code는 프로젝트 경로로 대화 기록 폴더 이름을 만든다(`C--projects-myguardian-v2`).
경로가 다르면 옮겨온 대화 기록을 인식하지 못한다.

## 1. 새 PC에 설치할 것

| 프로그램 | 확인 |
|---|---|
| Claude Code (데스크톱 앱) | 같은 계정(hemera1984@gmail.com)으로 로그인 |
| Git | `git --version` |
| Python 3.12+ | `python --version` |
| 파이썬 패키지 | `pip install playwright jsonschema pillow` |
| Playwright 브라우저 | `python -m playwright install chromium` |

## 2. 저장소 — git이 옮겨준다

```
cd C:\projects
git clone https://github.com/hemera1984-dot/myguardian-v2.git
```

옮기기 전 현재 PC에서 **모든 브랜치를 push** 해둔다. push 안 된 작업은 이관되지 않는다.
다른 세션(우리팀 등)이 커밋하지 않은 작업이 있는지도 확인한다: `git status`

## 3. git 밖 파일 — 수동 복사 (USB 또는 원드라이브)

| 대상 | 위치 | 비고 |
|---|---|---|
| 고객 저장소 3개 | `C:\projects\mg-clients-fc01`(86명) `fc02`(180명) `fc03`(4명) | 개인정보. 저장소에 절대 포함되지 않는다 |
| 네이버 API 키 | `pipeline\naver-keys.json` | gitignore 대상. 없으면 뉴스 수집만 안 된다 |
| 권한 설정 | `.claude\settings.local.json` | 없으면 승인 팝업이 다시 뜬다 (선택) |
| 상담 영상·보장분석 | 원드라이브 동기화 폴더 | 새 PC에 원드라이브 로그인하면 자동 |
| 디자인 원본 | `C:\projects\design-input` | 최적화본은 저장소에 있음 (선택) |
| 실행기·바로가기 | `C:\projects\myguardian-launcher` | 새로 만들어도 됨 |

키 파일은 화면 공유·채팅에 노출된 적이 있으면 NAVER API HUB 콘솔에서 재발급받아 교체한다.

## 4. 대화 기록·메모리 — 폴더 복사

현재 PC의 이 폴더를 통째로 복사해 새 PC의 같은 위치에 붙여넣는다.

```
C:\Users\<사용자>\.claude\projects\C--projects-myguardian-v2\
```

- `*.jsonl` — 세션별 대화 기록 (현재 5개, 약 54MB)
- `memory\` — 기억 파일과 MEMORY.md 색인

새 PC의 사용자 이름이 다르면 `C:\Users\<새 이름>\.claude\projects\` 아래에 넣는다.
폴더 이름(`C--projects-myguardian-v2`)은 반드시 그대로 유지한다.

주의: 대화 기록을 옮겨도 새 대화창은 과거 대화를 자동으로 읽지 않는다.
작업 인수인계는 원래 `docs/handoff.md`·`decisions.md`·`current-status.md`가 담당한다.
기록 복사는 "지난 대화를 다시 열어볼 수 있게" 하는 용도다.

## 4-1. 새 PC에서 첫 대화 시작하기

새 PC에 Claude Code 앱을 깔면 화면이 비어 있어 막막해 보이지만, **폴더만 열면 맥락이 잡힌다.**
앱은 프로젝트 폴더의 `CLAUDE.md`(헌법)를 자동으로 읽고 시작한다.

1. 앱에서 폴더 열기 → `C:\projects\myguardian-v2` 선택
2. 첫 메시지로 아래를 그대로 붙여넣는다:

```
docs/current-status.md, docs/decisions.md, docs/handoff.md를 읽고
지금 프로젝트가 어디까지 왔는지, 다음에 할 일이 뭔지 정리해줘.
그 다음 오늘 작업을 시작하자.
```

이 세 문서가 인수인계서다. 어느 PC의 어느 대화창이든 이걸 읽고 이어서 작업한다.
지난 대화 내용을 기억하지 못해도 프로젝트 상태는 문서가 알려준다.

3. 작업이 끝나면 항상: 변경 내용을 `docs/handoff.md`에 기록 → commit → push

## 5. 브라우저에 저장된 것 — 이관되지 않음 (새 PC에서 다시 입력)

localStorage는 PC·브라우저마다 따로다. 새 PC에서 한 번씩 다시 설정한다.

- 홈 → 내 프로필 (이름·직함·지점·연락처·전문분야·사진) — 저장하면 카톡 서명도 함께 갱신
- 케어센터 발행 데스크 → 이번 호 가제 (작성 중이던 내용)
- 고객관리 → 고객 저장소 폴더 다시 연결 (브라우저 권한이라 재승인 필요)

## 6. 이관 확인

```
cd C:\projects\myguardian-v2
python scripts\verify_review.py          # 29건 전건 통과여야 한다
python pipeline\collect_news.py          # 키를 옮겼으면 카테고리별 수집 성공
```

화면은 바탕화면 바로가기(또는 `python -m http.server 8123` 후 `localhost:8123/web/`)로 확인한다.

## 7. 회사 노트북일 경우 확인 사항

업무용 노트북이 회사 자산이면, 고객 개인정보와 API 키를 그 기기에 두는 것이 회사 보안 정책에
맞는지 먼저 확인한다. 정책상 어려우면 고객 저장소만 개인 기기에 남기고, 업무용에서는
공개 데이터(사례·판례·케어센터) 작업만 하는 분리 운용도 가능하다.
