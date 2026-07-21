"""보험사 청구 안내 페이지 변경 감시 (B층 cron).

data/claims/insurers.json의 감시=자동 회사들을 돌며 청구 안내 페이지 내용의
지문(해시)을 저장·비교해 **변경만 감지**한다. 서류를 파싱하지 않으므로 사이트
형식이 달라도 깨지지 않는다. 변경이 감지되면 사람(안창민 FC)이 링크를 열어 확인한다.

사용법:
  python pipeline/monitor_insurers.py            # 자동 감시 대상 전체 점검
  python pipeline/monitor_insurers.py --code L04 # 특정 회사만
  python pipeline/monitor_insurers.py --list      # 대상 목록만 출력(점검 안 함)

산출물: data/claims/monitor-state.json (지문·확인일·상태. 다음 달 비교 기준 — 저장소에 커밋)
상태값: 신규(첫 확인) / 정상(그대로) / 변경(달라짐 — 사람 확인 필요) / 접속실패(수동 확인)

원칙: 자동 수집이 아니라 변경 감지 + 사람 확인. 감시=수동/제외는 자동 점검하지 않고
목록에만 남긴다. headless 렌더링(playwright)으로 SPA 공개 페이지도 읽는다.
"""

import argparse
import hashlib
import json
import re
import sys
from datetime import date
from pathlib import Path

from playwright.sync_api import sync_playwright

# Windows 기본 콘솔(cp949)에서도 출력이 깨지지 않게 한다
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
LIST_PATH = ROOT / "data" / "claims" / "insurers.json"
STATE_PATH = ROOT / "data" / "claims" / "monitor-state.json"

NAV_TIMEOUT_MS = 30000
SETTLE_MS = 2500  # SPA 렌더링 대기


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def fingerprint(text):
    """가시 텍스트를 공백 정규화 후 해시한다. 동적 잡음(세션·시각)은 사람 확인으로 흡수."""
    norm = re.sub(r"\s+", " ", (text or "").strip())
    return hashlib.sha256(norm.encode("utf-8")).hexdigest(), len(norm)


def fetch_text(page, url):
    page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
    try:
        page.wait_for_load_state("networkidle", timeout=NAV_TIMEOUT_MS)
    except Exception:
        pass  # networkidle 미도달(광고·폴링)해도 본문은 이미 있는 경우가 많다
    page.wait_for_timeout(SETTLE_MS)
    return page.evaluate("() => document.body ? document.body.innerText : ''")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--code", help="특정 회사 코드만 점검 (예: L04)")
    ap.add_argument("--list", action="store_true", help="대상 목록만 출력")
    args = ap.parse_args()

    data = load_json(LIST_PATH, None)
    if not data or "회사" not in data:
        print("insurers.json을 읽을 수 없습니다:", LIST_PATH)
        sys.exit(1)

    companies = data["회사"]
    auto = [c for c in companies if c.get("감시") == "자동" and c.get("청구안내URL")]
    manual = [c for c in companies if c.get("감시") == "수동"]
    if args.code:
        auto = [c for c in auto if c["코드"] == args.code]

    if args.list:
        print(f"자동 감시 {len(auto)}곳 / 수동 확인 {len(manual)}곳")
        for c in auto:
            print(f"  [{c['코드']}] {c['이름']}  {c['청구안내URL']}")
        return

    prev_state = load_json(STATE_PATH, {"항목": []})
    prev = {x["코드"]: x for x in prev_state.get("항목", [])}
    today = date.today().isoformat()

    changed, new, failed, ok = [], [], [], []
    items = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(user_agent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
        ))
        page = ctx.new_page()
        for c in auto:
            code, name, url = c["코드"], c["이름"], c["청구안내URL"]
            row = {"코드": code, "이름": name, "url": url, "확인일": today}
            try:
                text = fetch_text(page, url)
                h, n = fingerprint(text)
                if n < 40:
                    # 본문이 거의 비었으면 렌더 실패로 본다 (차단·리다이렉트 의심)
                    raise RuntimeError(f"본문 과소({n}자) — 렌더 실패 의심")
                row["해시"] = h
                row["길이"] = n
                before = prev.get(code)
                if not before or "해시" not in before:
                    row["상태"] = "신규"
                    new.append(row)
                elif before["해시"] != h:
                    row["상태"] = "변경"
                    row["이전확인일"] = before.get("확인일", "")
                    changed.append(row)
                else:
                    row["상태"] = "정상"
                    row["확인일"] = today
                    ok.append(row)
            except Exception as e:
                row["상태"] = "접속실패"
                row["오류"] = str(e)[:120]
                # 지문은 이전 값 보존 (실패로 baseline을 잃지 않는다)
                if prev.get(code, {}).get("해시"):
                    row["해시"] = prev[code]["해시"]
                    row["길이"] = prev[code].get("길이", 0)
                failed.append(row)
            print(f"[{row['상태']}] {code} {name}")
            items.append(row)
        browser.close()

    # --code 등으로 이번에 점검하지 않은 자동 회사는 이전 지문을 보존한다
    # (부분 실행이 전체 state를 덮어쓰지 않도록)
    processed = {r["코드"] for r in items}
    all_auto = [c for c in companies if c.get("감시") == "자동" and c.get("청구안내URL")]
    for c in all_auto:
        if c["코드"] not in processed and prev.get(c["코드"]):
            items.append(prev[c["코드"]])
            processed.add(c["코드"])

    # 수동 회사도 상태 파일에 기록 — 화면이 전체 현황을 보여줄 수 있게
    for c in manual:
        items.append({"코드": c["코드"], "이름": c["이름"], "url": c.get("청구안내URL"),
                      "상태": "수동확인", "확인일": prev.get(c["코드"], {}).get("확인일", "")})

    # 요약은 최종 항목 전체에서 집계 (부분 실행에도 전체 현황이 맞도록)
    def cnt(st):
        return len([x for x in items if x.get("상태") == st])

    out = {
        "갱신일": today,
        "요약": {"변경": cnt("변경"), "신규": cnt("신규"), "접속실패": cnt("접속실패"),
                 "정상": cnt("정상"), "수동확인": cnt("수동확인")},
        "항목": items,
    }
    STATE_PATH.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    print("\n=== 요약 ===")
    print(f"변경 {len(changed)} · 신규 {len(new)} · 정상 {len(ok)} · 접속실패 {len(failed)} · 수동 {len(manual)}")
    if changed:
        print("\n[변경 감지 — 확인 필요]")
        for r in changed:
            print(f"  {r['이름']}: {r['url']}")
    if failed:
        print("\n[접속 실패 — 수동 확인]")
        for r in failed:
            print(f"  {r['이름']}: {r.get('오류', '')}")
    print(f"\n저장: {STATE_PATH.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
