# 마이가디언 인증·승인 서버 (2차 공사 STEP 1)

구글 계정으로 로그인하고, 승인된 계정에만 데이터를 여는 서버다.
외부 패키지를 쓰지 않는다 — Node 22 이상의 내장 http·sqlite·crypto·fetch만 쓴다.
서버에서 `npm install`을 하지 않으므로 배포가 단순하다.

## 원칙

차단은 서버가 한다. 브라우저에서 화면을 숨기는 것은 차단이 아니다.
승인되지 않은 계정에는 서버가 데이터를 주지 않는다.

계정 상태는 셋이다.

| 상태 | 언제 | 열리는 것 |
|---|---|---|
| 대기 | 구글 로그인 직후 (기본값) | 내 계정 정보(/me)뿐 |
| 승인 | 관리자가 직급을 부여함 | 자기 데이터 |
| 정지 | 퇴사·회수 | 없음. 기존 세션도 즉시 끊긴다 |

## 승인 권한

- **총관리자**: 전 범위 승인·직급 변경·정지, 관리자 임명·회수.
- **팀원승인 플래그가 있는 직급**(현재 지점장·부지점장·팀장): 자기 하위 트리로만 승인 가능.
- 직급 이름과 플래그는 `server.js`의 `GRADES` 배열에서 바꾼다. 코드에 직급명을 박지 않는다.

승인 권한이 있어도 하위 팀원의 고객을 볼 수는 없다 (열람 범위 B안 유지).

## 첫 총관리자 만들기

승인해 줄 사람이 아직 없으므로 `BOOTSTRAP_ADMINS`에 적은 이메일은 첫 로그인에
자동으로 총관리자로 승인된다. 자리가 잡히면 이 값을 비워도 된다.

## 실행

```bash
cp server/.env.example server/.env   # 값 채우기
node --env-file=server/.env server/server.js
```

검증:

```bash
node server/test.js
```

## 경로

| 메서드 | 경로 | 권한 | 하는 일 |
|---|---|---|---|
| POST | /auth/google | 없음 | 구글 ID 토큰 검증 → 세션 발급. 신규는 대기 계정 생성 |
| POST | /auth/logout | 세션 | 세션 폐기 |
| GET | /me | 세션 | 내 계정 상태·직급·승인권한·직급표 |
| GET | /admin/pending | 승인권한 | 승인 대기 목록 + 구성원 목록 |
| POST | /admin/approve | 승인권한 | 승인 + 직급·상위자 부여 |
| POST | /admin/suspend | 승인권한 | 정지 (하위 트리만, 총관리자는 전원) |
| POST | /admin/set-admin | 총관리자 | 관리자 임명·회수 |

구글 ID 토큰은 구글의 tokeninfo 엔드포인트로 검증한다. JWT 검증을 직접 구현하지 않는다
(alg 혼동 등 사고가 잦다). 검증 후 `aud`가 우리 클라이언트 ID인지 반드시 확인해
다른 앱의 토큰을 막는다.

## 배포 (NCP Micro Server)

1. Node 22 이상 설치
2. 저장소를 내려받고 `server/.env` 작성
3. systemd 서비스로 등록해 상시 실행 (예시)

```ini
[Unit]
Description=마이가디언 인증 서버
After=network.target

[Service]
ExecStart=/usr/bin/node --env-file=/opt/myguardian/server/.env /opt/myguardian/server/server.js
Restart=always
User=myguardian

[Install]
WantedBy=multi-user.target
```

4. 앞단에 HTTPS 리버스 프록시를 둔다. GitHub Pages가 https라 서버도 https여야 한다.
   도메인이 있어야 무료 인증서를 받을 수 있다 (IP 주소로는 발급되지 않는다).
5. `ALLOWED_ORIGINS`에 실제 사이트 주소를 넣는다.

## 백업

`DB_FILE` 하나만 백업하면 계정·승인 상태가 모두 보존된다.
WAL 모드이므로 `.db`, `.db-wal`, `.db-shm`을 함께 복사하거나 서비스를 멈추고 복사한다.

## 다음 단계

STEP 2(고객 데이터)는 신한라이프의 고객정보 외부 클라우드 보관 규정 확인이 통과된
뒤에 진행한다. 이 서버(STEP 1)는 개인정보를 다루지 않으므로 먼저 올릴 수 있다.
