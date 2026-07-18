"""법원 판례 원문 검증 배치 (law.go.kr, Playwright 렌더링).

색인의 source_type '대법원' 사례에 대해 원문 페이지를 렌더링해
정규화된 사건번호가 실제로 존재하는지 대조한다.

- 접근 + 사건번호 일치 → 검증완료 (식별자 일치 확인)
- 접근되나 번호 미확인 → 부분검증
- 접근 실패 / URL 없음 → 미검증-참고용

결과는 data/cases/scourt-verification.json에 누적 저장 (재실행 시 이어서).
사용법: python pipeline/verify_scourt.py [1회 처리 건수=120]
"""

import json
import re
import sys
from datetime import date
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "cases" / "scourt-verification.json"


def norm_number(case_number: str) -> str | None:
    """이관 표기(부산지방법원-2010-구합-2365)에서 실제 사건번호(2010구합2365)를 뽑는다."""
    s = (case_number or "").replace("-", "").replace(" ", "")
    m = re.search(r"(\d{2,4}[가-힣]{1,3}\d{1,7})", s)
    return m.group(1) if m else None


def main() -> None:
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 120

    with open(ROOT / "data" / "cases" / "index.json", encoding="utf-8") as f:
        index = json.load(f)["data"]
    targets = [c for c in index if c.get("source_type") == "대법원"]

    prev = {"결과": []}
    if OUT.exists():
        with open(OUT, encoding="utf-8") as f:
            prev = json.load(f)
    done_ids = {r["id"] for r in prev["결과"]}
    todo = [c for c in targets if c["id"] not in done_ids][:limit]

    if not todo:
        print(f"완료 상태: {len(prev['결과'])}/{len(targets)}건 검증됨, 남은 작업 없음")
        return

    results = prev["결과"]
    with sync_playwright() as p:
        browser = p.chromium.launch()
        pg = browser.new_page()
        for i, c in enumerate(todo, 1):
            url = c.get("case_source_url") or c.get("source_url")
            num = norm_number(c.get("case_number"))
            entry = {"id": c["id"], "표시번호": c.get("case_number")}
            if not url:
                entry["판정"] = "미검증-참고용"
                entry["사유"] = "원문 URL 없음"
            elif not num:
                entry["판정"] = "부분검증"
                entry["사유"] = "사건번호 형식을 정규화할 수 없음"
            else:
                try:
                    pg.goto(url, wait_until="networkidle", timeout=30000)
                    pg.wait_for_timeout(700)
                    text = pg.locator("body").inner_text().replace(" ", "")
                    if num in text:
                        entry["판정"] = "검증완료"
                        entry["사유"] = "원문 접근·사건번호 일치"
                    else:
                        entry["판정"] = "부분검증"
                        entry["사유"] = "원문 접근되나 사건번호 미확인"
                except Exception:
                    entry["판정"] = "미검증-참고용"
                    entry["사유"] = "원문 접근 실패"
            results.append(entry)
            if i % 20 == 0:
                print(f"  진행 {i}/{len(todo)} (누적 {len(results)}/{len(targets)})")
        browser.close()

    counts: dict = {}
    for r in results:
        counts[r["판정"]] = counts.get(r["판정"], 0) + 1
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({
            "검증일": date.today().isoformat(),
            "기준": "law.go.kr 렌더링 후 정규화 사건번호 대조",
            "누적": len(results),
            "대상": len(targets),
            "분포": counts,
            "결과": results,
        }, f, ensure_ascii=False, indent=1)
    print(f"저장: {len(results)}/{len(targets)}건, 분포 {counts}")


if __name__ == "__main__":
    main()
