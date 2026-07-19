"""케어센터 발행 공정 1단계 — 네이버 뉴스 후보 수집.

사용법: python pipeline/collect_news.py [--display 8]
결과:  data/care/desk/candidates.json (발행 데스크 화면이 읽는다. 저장소에는 커밋하지 않는다)

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
API = "https://naverapihub.apigw.ntruss.com/search/v1/news"


def load_keys():
    cid = os.environ.get("NAVER_CLIENT_ID")
    secret = os.environ.get("NAVER_CLIENT_SECRET")
    if cid and secret:
        return cid, secret
    if KEY_FILE.exists():
        data = json.loads(KEY_FILE.read_text(encoding="utf-8"))
        if data.get("client_id") and data.get("client_secret"):
            return data["client_id"], data["client_secret"]
    print("네이버 API 키가 없습니다.")
    print("발급: https://developers.naver.com → 애플리케이션 등록 → 검색 API")
    print('저장: pipeline/naver-keys.json 에 {"client_id": "...", "client_secret": "..."}')
    sys.exit(1)


def strip_tags(text):
    return html.unescape(re.sub(r"<[^>]+>", "", text or "")).strip()


def search(cid, secret, query, display):
    url = API + "?" + urllib.parse.urlencode({"query": query, "display": display, "sort": "date", "format": "json"})
    req = urllib.request.Request(url, headers={
        "X-NCP-APIGW-API-KEY-ID": cid,
        "X-NCP-APIGW-API-KEY": secret,
    })
    with urllib.request.urlopen(req, timeout=15) as res:
        return json.loads(res.read().decode("utf-8")).get("items", [])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--display", type=int, default=8, help="검색어당 수집 건수 (기본 8)")
    args = parser.parse_args()

    cid, secret = load_keys()
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
