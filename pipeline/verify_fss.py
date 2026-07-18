"""금감원 분쟁조정사례 원문 검증 배치.

배경(Codex 검수 치명2): 금감원 원문 페이지는 분쟁조정사례(민원 사례 소개)로
공식 조정번호가 존재하지 않는다. 표시 번호(금감원-분쟁조정-N)는 이관 순번이다.
따라서 번호 대체가 아니라 원문 접근·제목 대조로 검증 상태를 판정한다.

- 원문 접근 + 제목 일치 → 부분검증 (공식 식별자 부재로 검증완료 불가)
- 접근 불가 또는 제목 불일치 → 미검증-참고용
결과는 data/cases/fss-verification.json에 저장하고,
build_case_index.py가 색인 생성 시 이를 반영한다 (원본 무변형).

사용법: python pipeline/verify_fss.py
"""

import json
import re
import time
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def norm(s: str) -> str:
    return re.sub(r"\s+", "", s or "")


def fetch(url: str) -> str | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.read().decode("utf-8", errors="ignore")
    except Exception:
        return None


def main() -> None:
    with open(ROOT / "data" / "cases" / "index.json", encoding="utf-8") as f:
        index = json.load(f)["data"]
    fss = [c for c in index if c.get("source_type") == "금감원"]

    results = []
    ok = fail = 0
    for i, c in enumerate(fss, 1):
        url = c.get("case_source_url") or c.get("source_url")
        entry = {"id": c["id"], "표시번호": c.get("case_number"), "url": url}
        if not url:
            entry["판정"] = "미검증-참고용"
            entry["사유"] = "원문 URL 없음"
            fail += 1
        else:
            html = fetch(url)
            if html is None:
                entry["판정"] = "미검증-참고용"
                entry["사유"] = "원문 접근 실패"
                fail += 1
            elif norm(c.get("title")) [:20] in norm(html):
                entry["판정"] = "부분검증"
                entry["사유"] = "원문 접근·제목 일치 (공식 조정번호 부재로 검증완료 불가)"
                ok += 1
            else:
                entry["판정"] = "미검증-참고용"
                entry["사유"] = "원문에서 제목 확인 불가"
                fail += 1
            time.sleep(0.25)
        results.append(entry)
        if i % 20 == 0:
            print(f"  진행 {i}/{len(fss)}")

    out = {
        "검증일": date.today().isoformat(),
        "기준": "원문 접근 + 제목 앞 20자 대조. 금감원 사례는 공식 조정번호가 없어 최고 등급은 부분검증",
        "부분검증": ok,
        "미검증": fail,
        "결과": results,
    }
    with open(ROOT / "data" / "cases" / "fss-verification.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"검증 완료: 금감원 {len(fss)}건 → 부분검증 {ok} / 미검증-참고용 {fail}")


if __name__ == "__main__":
    main()
