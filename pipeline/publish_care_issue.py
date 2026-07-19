"""케어센터 발행 공정 — 초안 검증 후 발행 전환.

사용법: python pipeline/publish_care_issue.py --id weekly-12

검증 항목을 전부 통과해야 발행된다. 하나라도 실패하면 목록을 출력하고 중단한다.
발행 전환은 issues.json의 상태를 '발행'으로 바꾸고 꼭지·요약을 본문에서 동기화한다.
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ISSUES = ROOT / "data" / "care" / "issues.json"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--id", required=True)
    args = parser.parse_args()

    data = json.loads(ISSUES.read_text(encoding="utf-8"))
    issues = data if isinstance(data, list) else data.get("data", [])
    entry = next((i for i in issues if i.get("id") == args.id), None)

    errors = []
    if entry is None:
        print(f"중단: issues.json에 {args.id} 가 없습니다.")
        sys.exit(1)
    if entry.get("상태") != "초안":
        print(f"중단: {args.id} 는 초안 상태가 아닙니다 (현재: {entry.get('상태', '발행')}).")
        sys.exit(1)

    body_path = ROOT / entry.get("본문파일", "")
    if not body_path.exists():
        print(f"중단: 본문 파일이 없습니다 — {body_path}")
        sys.exit(1)
    body = json.loads(body_path.read_text(encoding="utf-8"))

    # 호 메타 검증
    if not (entry.get("제목") or "").strip():
        errors.append("호 제목이 비어 있습니다 (issues.json의 제목)")

    # 기사 검증
    articles = body.get("기사", [])
    if not articles:
        errors.append("기사가 없습니다")
    for a in articles:
        tag = f"기사 {a.get('번호')}"
        if not (a.get("제목") or "").strip():
            errors.append(f"{tag}: 제목 없음")
        if not (a.get("부제") or "").strip():
            errors.append(f"{tag}: 부제 없음")
        if not a.get("본문"):
            errors.append(f"{tag}: 본문 없음")
        if not a.get("요약"):
            errors.append(f"{tag}: 요약 없음")
        img = a.get("이미지")
        if img and not (ROOT / img).exists():
            errors.append(f"{tag}: 이미지 파일 없음 — {img}")

    if not body.get("편집장의말"):
        errors.append("편집장의 말이 비어 있습니다")

    cover = entry.get("커버이미지")
    if cover and not (ROOT / cover).exists():
        errors.append(f"커버이미지 파일 없음 — {cover}")

    if errors:
        print(f"발행 불가 — {len(errors)}건:")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)

    # 발행 전환: 꼭지·요약을 본문에서 동기화하고 상태 변경
    entry["꼭지"] = [{
        "번호": a["번호"],
        "카테고리": a.get("카테고리") or "",
        "제목": a["제목"],
        "부제": a.get("부제") or "",
    } for a in articles]
    entry["요약"] = " · ".join(a["제목"] for a in articles)
    entry["상태"] = "발행"

    if isinstance(data, list):
        ISSUES.write_text(json.dumps(issues, ensure_ascii=False, indent=1), encoding="utf-8")
    else:
        data["data"] = issues
        ISSUES.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"발행 완료: {entry['채널']} {entry.get('발행인', '안창민')} {entry['호수']}호 — {entry['제목']}")
    print("다음: commit·push 후 발행 데스크에서 카톡 문구를 복사해 발송하세요.")


if __name__ == "__main__":
    main()
