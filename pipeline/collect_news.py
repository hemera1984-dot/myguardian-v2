"""케어센터 발행 공정 — 네이버 검색 수집 (NAVER API HUB).

사용법:
  python pipeline/collect_news.py                       # 카테고리별 후보 일괄 수집 → 데스크 표시용
  python pipeline/collect_news.py --query "국민연금 개편"  # 가제 키워드 검색 (집필 세션용, 뉴스+백과)
  python pipeline/collect_news.py --query "..." --source encyc

일괄 수집 결과: data/care/desk/candidates.json (발행 데스크 화면이 읽는다. 저장소에는 커밋하지 않는다)
--query 결과: 표준 출력(JSON) — 집필 세션이 근거 수집에 사용한다

네이버 API 키 준비 (최초 1회):
  1. https://console.ncloud.com 의 NAVER API HUB에서 Application 등록 (뉴스 등 NAVER 검색 API 선택)
  2. pipeline/naver-keys.json 파일을 만들어 저장한다 (gitignore 대상):
     {"client_id": "발급받은 Client ID", "client_secret": "발급받은 Client Secret"}
  또는 환경변수 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 로 지정한다.

주의: 구 개발자센터(openapi.naver.com) 키와 호환되지 않는다. 검색 API는 NAVER API HUB로 이전됐다.
"""

import argparse
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime
from email.utils import parsedate_to_datetime
from pathlib import Path

# Windows 기본 콘솔(cp949)에서도 출력이 깨지지 않게 한다
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# 키 발급처는 NAVER API HUB 하나뿐이다 — 안내 문구를 한곳에서 관리 (Codex 4차 중요 7)
KEY_GUIDE = [
    "네이버 API 키가 없습니다.",
    "발급: https://console.ncloud.com 의 NAVER API HUB → Application 등록 → NAVER 검색(뉴스 등) 선택",
    '저장: pipeline/naver-keys.json 에 {"client_id": "...", "client_secret": "..."}',
    "주의: 구 개발자센터(developers.naver.com) 키는 새 규격과 호환되지 않습니다.",
]

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "care" / "desk"
KEY_FILE = ROOT / "pipeline" / "naver-keys.json"

# 주간 안창민 4개 꼭지에 대응하는 검색어 묶음
QUERIES = {
    "시사": ["정부 정책", "국회 법안", "사회 이슈"],
    "경제": ["금리 전망", "부동산 시장", "상속 증여세"],
    "교양": ["인공지능 기술", "과학 발견", "문화 트렌드"],
    "보험": ["보험 제도", "건강보험", "국민연금"],
}

# NAVER API HUB (네이버 클라우드) — 구 openapi.naver.com에서 이전된 검색 API
API_BASE = "https://naverapihub.apigw.ntruss.com/search/v1/"
SOURCES = {"news": "뉴스", "encyc": "백과사전"}


def load_keys():
    cid = os.environ.get("NAVER_CLIENT_ID")
    secret = os.environ.get("NAVER_CLIENT_SECRET")
    if cid and secret:
        return cid, secret
    if KEY_FILE.exists():
        data = json.loads(KEY_FILE.read_text(encoding="utf-8"))
        if data.get("client_id") and data.get("client_secret"):
            return data["client_id"], data["client_secret"]
    for line in KEY_GUIDE:
        print(line)
    sys.exit(1)


def strip_tags(text):
    return html.unescape(re.sub(r"<[^>]+>", "", text or "")).strip()


def search(cid, secret, query, display, source="news"):
    params = {"query": query, "display": display, "format": "json"}
    if source == "news":
        params["sort"] = "date"  # 백과사전은 정확도순이 낫다
    url = API_BASE + source + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "X-NCP-APIGW-API-KEY-ID": cid,
        "X-NCP-APIGW-API-KEY": secret,
    })
    with urllib.request.urlopen(req, timeout=15) as res:
        return json.loads(res.read().decode("utf-8")).get("items", [])


def to_item(raw):
    try:
        pub = parsedate_to_datetime(raw.get("pubDate", "")).strftime("%Y-%m-%d %H:%M")
    except Exception:
        pub = ""
    return {
        "제목": strip_tags(raw.get("title")),
        "요약": strip_tags(raw.get("description")),
        "링크": raw.get("originallink") or raw.get("link") or "",
        "발행일시": pub,
    }


def query_mode(cid, secret, query, display, source):
    """가제 키워드 검색 — 집필 세션이 근거로 쓴다. 결과는 표준 출력 JSON."""
    sources = list(SOURCES) if source == "all" else [source]
    out = {"검색어": query, "출처별": {}}
    for s in sources:
        try:
            items = [to_item(x) for x in search(cid, secret, query, display, s)]
        except Exception as e:
            items = []
            print(f"경고: {SOURCES[s]} 검색 실패 — {e}", file=sys.stderr)
        out["출처별"][SOURCES[s]] = items
    print(json.dumps(out, ensure_ascii=False, indent=1))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--display", type=int, default=8, help="검색어당 수집 건수 (기본 8)")
    parser.add_argument("--query", default="", help="가제 키워드 검색 모드 — 결과를 표준 출력으로")
    parser.add_argument("--source", default="all", choices=["news", "encyc", "all"],
                        help="--query 모드의 검색 출처 (기본 all)")
    args = parser.parse_args()

    cid, secret = load_keys()

    if args.query:
        query_mode(cid, secret, args.query, args.display, args.source)
        return

    by_category = {}
    seen_links = set()

    for category, queries in QUERIES.items():
        items = []
        for q in queries:
            try:
                found = search(cid, secret, q, args.display)
            except Exception as e:
                print(f"경고: '{q}' 검색 실패 — {e}")
                continue
            for it in found:
                link = it.get("originallink") or it.get("link") or ""
                if not link or link in seen_links:
                    continue
                seen_links.add(link)
                try:
                    pub = parsedate_to_datetime(it.get("pubDate", "")).strftime("%Y-%m-%d %H:%M")
                except Exception:
                    pub = ""
                items.append({
                    "제목": strip_tags(it.get("title")),
                    "요약": strip_tags(it.get("description")),
                    "링크": link,
                    "발행일시": pub,
                    "검색어": q,
                })
        # 최신순 정렬 후 카테고리당 상한
        items.sort(key=lambda x: x["발행일시"], reverse=True)
        by_category[category] = items[:15]
        print(f"{category}: {len(by_category[category])}건 수집")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = {
        "수집일시": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "카테고리별": by_category,
    }
    out_path = OUT_DIR / "candidates.json"
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"저장: {out_path}")
    print("발행 데스크(care/desk.html)에서 후보를 선택하세요.")


if __name__ == "__main__":
    main()
