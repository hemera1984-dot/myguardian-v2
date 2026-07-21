# 새 PC 이관 — 남은 파일 체크리스트

새 업무용 노트북으로 이관하며 아직 예전 PC에서 가져오지 않은 것들. 가져오면 체크한다.
(환경 구축·gh 로그인·GitHub Pages는 2026-07-20~21에 이미 완료.)

## 예전 PC에서 복사 (USB 또는 원드라이브)

- [ ] **고객 데이터** — `C:\projects\mg-clients-fc01` (안창민 86명)
- [ ] **고객 데이터** — `C:\projects\mg-clients-fc02` (김승은 180명)
- [ ] **고객 데이터** — `C:\projects\mg-clients-fc03` (이지영 4명)
  - 공개 저장소(myguardian-v2) 밖에 둔다. 절대 커밋 금지.
  - 이게 있어야: 고객관리 실사용, 보장분석 파이프라인(P1~P5) 착공.
- [ ] **네이버 API 키** — `pipeline\naver-keys.json`
  - `{"client_id": "...", "client_secret": "..."}` 형식.
  - 없으면 케어 발행의 `collect_news.py`(네이버 뉴스·백과 수집) 실행 불가.
- [ ] **대화 기록·메모리** — 예전 PC의 `.claude\projects\C--projects-myguardian-v2\`
  → 새 PC의 `C:\Users\crono\.claude\projects\C--projects-myguardian-v2\`
  - 선택 사항. 과거 세션 맥락을 잇고 싶을 때만.

## 가져온 뒤 확인

- [ ] `python scripts\verify_review.py` → 29건 통과 유지
- [ ] `python pipeline\collect_news.py` → 네이버 키로 수집 성공
- [ ] 고객관리 화면에서 mg-clients 폴더 연결 → 고객 목록 로드 확인
- [ ] 고객 저장소 3개 GitHub 비공개 push (gh 로그인 완료됨):
  ```
  cd C:\projects\mg-clients-fc01 && gh repo create mg-clients-fc01 --private --source=. --remote=origin --push
  cd C:\projects\mg-clients-fc02 && gh repo create mg-clients-fc02 --private --source=. --remote=origin --push
  cd C:\projects\mg-clients-fc03 && gh repo create mg-clients-fc03 --private --source=. --remote=origin --push
  ```
  `--private` 확인 필수.

## 사용자 직접 (이관과 별개, 급하지 않음)

- [ ] 마누스(v1) 상담 영상 원드라이브 백업 — 서비스 닫히기 전
- [ ] 청구·지급 알릴의무·서류 실무 검수 (현직 기준으로)
