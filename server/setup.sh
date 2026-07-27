#!/usr/bin/env bash
# 마이가디언 인증 서버 설치 — Ubuntu 24.04 기준. root로 실행한다.
#
#   bash setup.sh api.insurguard.life admin@example.com
#
# 하는 일: Node 설치 → 저장소 내려받기 → .env 작성 → systemd 등록 → Caddy로 HTTPS 자동 설정.
# 서버를 옮길 때도 이 스크립트를 새 서버에서 그대로 돌리고 DB 파일만 복사하면 된다.

set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
APP_DIR=/opt/myguardian
DATA_DIR=/var/lib/myguardian
REPO=https://github.com/hemera1984-dot/myguardian-v2.git

if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then
  echo "사용법: bash setup.sh <도메인> <인증서 알림 이메일>"
  echo "예시:   bash setup.sh api.insurguard.life hemera1984@gmail.com"
  exit 1
fi

echo "== 1/6 시스템 패키지 =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates debian-keyring debian-archive-keyring apt-transport-https

echo "== 2/6 Node.js 22 =="
# 내장 sqlite를 쓰므로 22 이상이 필요하다 (npm 패키지는 설치하지 않는다)
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
node -v

echo "== 3/6 앱 내려받기 =="
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone --depth 1 "$REPO" "$APP_DIR"
fi

id myguardian >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin myguardian
mkdir -p "$DATA_DIR"
chown -R myguardian:myguardian "$DATA_DIR"

echo "== 4/6 설정 파일 =="
# 이미 있으면 덮어쓰지 않는다 (재실행해도 설정이 날아가지 않게)
if [ ! -f "$APP_DIR/server/.env" ]; then
  cat > "$APP_DIR/server/.env" <<EOF
PORT=8787
DB_FILE=$DATA_DIR/myguardian.db
GOOGLE_CLIENT_ID=370923160679-3h1hn1flheb4d01bq1amtutr992kldj1.apps.googleusercontent.com
ALLOWED_ORIGINS=https://app.insurguard.life,https://hemera1984-dot.github.io,http://localhost:8080
BOOTSTRAP_ADMINS=hemera1984@gmail.com
MEDIA_DIR=$DATA_DIR/media
MEDIA_BASE=https://$DOMAIN/media
EOF
  # 서비스가 myguardian 계정으로 도므로 소유권을 넘긴다 (root 소유면 읽지 못해 부팅 실패)
  chown myguardian:myguardian "$APP_DIR/server/.env"
  chmod 600 "$APP_DIR/server/.env"
  echo "  .env 생성됨 — 승인 도메인이 바뀌면 이 파일을 고치고 재시작한다"
else
  echo "  기존 .env 유지"
fi

echo "== 5/6 서비스 등록 =="
cat > /etc/systemd/system/myguardian.service <<EOF
[Unit]
Description=마이가디언 인증 서버
After=network.target

[Service]
ExecStart=/usr/bin/node --env-file=$APP_DIR/server/.env $APP_DIR/server/server.js
WorkingDirectory=$APP_DIR/server
Restart=always
RestartSec=3
User=myguardian
# 서버가 건드릴 수 있는 곳을 데이터 폴더로 제한한다
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now myguardian
sleep 2
systemctl is-active --quiet myguardian && echo "  인증 서버 실행 중" || { journalctl -u myguardian -n 20 --no-pager; exit 1; }

echo "== 6/6 HTTPS (Caddy) =="
# Caddy는 도메인만 적어주면 인증서를 알아서 발급·갱신한다
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	# 지면 사진은 파일로 바로 내보낸다 (앱을 거치지 않는다)
	handle_path /media/* {
		root * $DATA_DIR/media
		file_server
	}
	handle {
		reverse_proxy 127.0.0.1:8787
	}
}
EOF

caddy fmt --overwrite /etc/caddy/Caddyfile >/dev/null 2>&1 || true
systemctl reload caddy 2>/dev/null || systemctl restart caddy
sleep 3

echo
echo "설치 완료"
echo "  인증 서버: $(systemctl is-active myguardian)"
echo "  웹서버:    $(systemctl is-active caddy)"
echo "  DB 파일:   $DATA_DIR/myguardian.db  (백업 대상)"
echo
echo "확인: curl -i https://$DOMAIN/me   → 401이 나오면 정상"
echo "로그: journalctl -u myguardian -f"
