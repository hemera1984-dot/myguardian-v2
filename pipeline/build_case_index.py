"""사례 서비스 색인 생성기.

원본(data/cases/cases.json, 726건)은 무변형 보존층으로 두고,
동일 사건·동일 원문 중복을 그룹화한 서비스 색인(data/cases/index.json)을 만든다.
화면·검색·통계는 색인을 쓴다. (Codex 검수 치명1 대응)

- 그룹 키: (case_number, case_source_url) 복합키
- 대표 레코드: 그룹에서 요약이 가장 긴 레코드 (내용 병합·변형 없음 — 선택만)
- 대표에 원본건수·원본id목록을 부가해 추적 가능성 유지
- 중복 판정 보고서(data/cases/dedup-report.json)와 통계(data/stats.json) 재생성

사용법: python pipeline/build_case_index.py
"""

import json
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    with open(ROOT / "data" / "cases" / "cases.json", encoding="utf-8") as f:
        source = json.load(f)
    rows = source["data"]

    groups: dict = {}
    order: list = []
    for r in rows:
        key = (r.get("case_number") or "", r.get("case_source_url") or "")
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(r)

    index = []
    dup_report = []
    for key in order:
        members = groups[key]
        rep = max(members, key=lambda r: len(r.get("summary") or ""))
        entry = dict(rep)  # 대표 레코드 무변형 복사
        entry["원본건수"] = len(members)
        entry["원본id목록"] = [m["id"] for m in members]
        index.append(entry)
        if len(members) > 1:
            dup_report.append({
                "case_number": key[0],
                "case_source_url": key[1],
                "건수": len(members),
                "대표id": rep["id"],
                "원본id": [m["id"] for m in members],
            })

    # 검증 반영 (원본 무변형 — 색인의 등급만 조정)
    for ver_name in ("fss-verification.json", "scourt-verification.json"):
        ver_path = ROOT / "data" / "cases" / ver_name
        if not ver_path.exists():
            continue
        with open(ver_path, encoding="utf-8") as f:
            ver = {v["id"]: v for v in json.load(f)["결과"]}
        for e in index:
            v = ver.get(e["id"])
            if v:
                e["verification_grade"] = v["판정"]
                e["검증메모"] = v["사유"]
    for e in index:
        has_url = e.get("case_source_url") or e.get("source_url")
        if not has_url and e.get("verification_grade") == "검증완료":
            e["verification_grade"] = "미검증-참고용"
            e["검증메모"] = "원문 URL 없음"

    with open(ROOT / "data" / "cases" / "index.json", "w", encoding="utf-8") as f:
        json.dump({
            "생성일": date.today().isoformat(),
            "기준": "(case_number, case_source_url) 복합키 그룹화, 대표=최장 요약",
            "원본건수": len(rows),
            "고유건수": len(index),
            "data": index,
        }, f, ensure_ascii=False, indent=1)

    with open(ROOT / "data" / "cases" / "dedup-report.json", "w", encoding="utf-8") as f:
        json.dump({
            "생성일": date.today().isoformat(),
            "중복그룹": len(dup_report),
            "초과레코드": sum(d["건수"] - 1 for d in dup_report),
            "그룹": dup_report,
        }, f, ensure_ascii=False, indent=1)

    # 통계 재생성 — 서비스 색인 기준
    by_source: dict = {}
    for e in index:
        k = e.get("source_type") or "미기재"
        by_source[k] = by_source.get(k, 0) + 1
    stats_path = ROOT / "data" / "stats.json"
    with open(stats_path, encoding="utf-8") as f:
        stats = json.load(f)
    stats["생성일"] = date.today().isoformat()
    stats["사례"] = len(index)
    stats["사례_원본레코드"] = len(rows)
    stats["사례_출처별"] = dict(sorted(by_source.items(), key=lambda x: -x[1]))
    with open(stats_path, "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=1)

    print(f"색인 생성: 원본 {len(rows)}건 → 고유 {len(index)}건 (중복 그룹 {len(dup_report)}개)")


if __name__ == "__main__":
    main()
