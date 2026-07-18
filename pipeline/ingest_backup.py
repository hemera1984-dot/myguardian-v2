"""v1 백업 입주 스크립트.

원본 백업(zip 해제본)에서 사례·사전 데이터를 data/로 옮긴다.
원칙: 레코드는 무변형 복사(추출만). 이 스크립트가 하는 일은
파일 배치, 건수 검증, 통계 파일(data/stats.json) 생성뿐이다.

사용법: python pipeline/ingest_backup.py <백업해제경로>
  <백업해제경로> 하위에 다음이 있어야 한다:
    hub-backup-20260718/hub-export-data/cases.json   (사례 726건)
    data-export/export_output/25_medicalTerms.json   (용어 418건)
    data-export/export_output/26_diseases.json       (질병 275건)
"""

import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load(path: Path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def unwrap(obj):
    """내보내기 래퍼({total, data:[...]})든 순수 배열이든 레코드 배열을 꺼낸다. 레코드는 손대지 않는다."""
    if isinstance(obj, list):
        return obj
    if isinstance(obj, dict):
        for key in ("data", "rows", "cases"):
            if isinstance(obj.get(key), list):
                return obj[key]
    raise ValueError("레코드 배열을 찾을 수 없음")


def save(path: Path, records: list, source_name: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "출처백업": source_name,
        "입주일": date.today().isoformat(),
        "총건수": len(records),
        "data": records,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    print(f"입주: {path.relative_to(ROOT)} ({len(records)}건)")


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    backup = Path(sys.argv[1])

    cases = unwrap(load(backup / "hub-backup-20260718" / "hub-export-data" / "cases.json"))
    terms = unwrap(load(backup / "data-export" / "export_output" / "25_medicalTerms.json"))
    diseases = unwrap(load(backup / "data-export" / "export_output" / "26_diseases.json"))

    # 검증: 필수 필드와 기대 건수
    assert len(cases) == 726, f"사례 건수 불일치: {len(cases)}"
    missing_no = [c["id"] for c in cases if not c.get("case_number")]
    assert not missing_no, f"사건번호 없는 사례 {len(missing_no)}건 — 입주 불가(헌법)"
    assert len(terms) == 418, f"용어 건수 불일치: {len(terms)}"
    assert len(diseases) == 275, f"질병 건수 불일치: {len(diseases)}"

    save(ROOT / "data" / "cases" / "cases.json", cases, "hub-backup-20260718")
    save(ROOT / "data" / "dictionary" / "terms.json", terms, "insurance_guardian_data_export_20260718")
    save(ROOT / "data" / "dictionary" / "diseases.json", diseases, "insurance_guardian_data_export_20260718")

    stats = {
        "생성일": date.today().isoformat(),
        "사례": len(cases),
        "사례_출처별": count_by(cases, "source_type"),
        "용어": len(terms),
        "질병": len(diseases),
    }
    with open(ROOT / "data" / "stats.json", "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=1)
    print(f"통계: data/stats.json {stats}")


def count_by(records: list, field: str) -> dict:
    out: dict = {}
    for r in records:
        key = r.get(field) or "미기재"
        out[key] = out.get(key, 0) + 1
    return dict(sorted(out.items(), key=lambda x: -x[1]))


if __name__ == "__main__":
    main()
