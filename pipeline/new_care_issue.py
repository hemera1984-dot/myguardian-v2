"""케어센터 발행 공정 — 새 호 뼈대 생성 (상태: 초안).

사용법:
  python pipeline/new_care_issue.py --channel 주간
  python pipeline/new_care_issue.py --channel 월간 --date 2026-08-03
  python pipeline/new_care_issue.py --channel 주간 --publisher 김승은 --slug kse

동작: 호수 자동 채번, 발행일(다음 월요일/첫째 월요일)·주차라벨 계산,
본문 뼈대 JSON과 이미지 폴더 생성, issues.json에 초안으로 등록.
초안은 발행 데스크에만 표시되며, publish_care_issue.py 검증 통과 후 발행된다.
"""

import argparse
import json
import os
import re
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

# Windows 기본 콘솔(cp949)에서도 출력이 깨지지 않게 한다
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def atomic_write(path, text):
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


ROOT = Path(__file__).resolve().parent.parent
ISSUES = ROOT / "data" / "care" / "issues.json"
BODY_DIR = ROOT / "data" / "care" / "issues"

WEEKLY_CATEGORIES = ["시사", "경제", "교양", "보험"]
MONTHLY_ARTICLES = 3


def next_monday(today):
    if today.isoweekday() == 1:  # isoweekday: 월=1
        return today
    return today + timedelta(days=(8 - today.isoweekday()) % 7)


def first_monday_on_or_after(today):
    d = date(today.year, today.month, 1)
    d += timedelta(days=(8 - d.isoweekday()) % 7)
    if d < today:
        y, m = (today.year + 1, 1) if today.month == 12 else (today.year, today.month + 1)
        d = date(y, m, 1)
        d += timedelta(days=(8 - d.isoweekday()) % 7)
    return d


def week_label(d, channel):
    if channel == "월간":
        return f"{d.year}년 {d.month}월호"
    nth = (d.day - 1) // 7 + 1
    return f"{d.year}년 {d.month}월 {nth}주차"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--channel", required=True, choices=["주간", "월간"])
    parser.add_argument("--publisher", default="안창민")
    parser.add_argument("--slug", default="", help="팀원 발행 시 id에 끼울 영문 식별자 (예: kse)")
    parser.add_argument("--date", default="", help="발행일 직접 지정 (YYYY-MM-DD)")
    args = parser.parse_args()

    if args.publisher != "안창민" and not re.fullmatch(r"[a-z0-9]+", args.slug or ""):
        print("팀원 발행은 --slug (영문 소문자·숫자)가 필요합니다. 예: --slug kse")
        sys.exit(1)

    prefix = "weekly" if args.channel == "주간" else "monthly"
    id_prefix = f"{prefix}-{args.slug}-" if args.slug else f"{prefix}-"

    data = json.loads(ISSUES.read_text(encoding="utf-8"))
    issues = data if isinstance(data, list) else data.get("data", [])

    # 채번: 같은 채널·발행인의 최대 호수 + 1
    same = [i for i in issues if i.get("채널") == args.channel
            and (i.get("발행인") or "안창민") == args.publisher]
    number = max([i.get("호수", 0) for i in same], default=0) + 1
    issue_id = f"{id_prefix}{number:02d}"
    if any(i.get("id") == issue_id for i in issues):
        print(f"중단: id {issue_id} 가 이미 존재합니다.")
        sys.exit(1)

    if args.date:
        pub_date = date.fromisoformat(args.date)
    else:
        today = date.today()
        pub_date = next_monday(today) if args.channel == "주간" else first_monday_on_or_after(today)

    # 본문 뼈대 — 발행 세션(집필)이 채운다
    if args.channel == "주간":
        articles = [{
            "번호": n + 1, "카테고리": cat, "제목": "", "부제": "",
            "요약": [], "한마디": [], "본문": [], "이미지": None,
        } for n, cat in enumerate(WEEKLY_CATEGORIES)]
    else:
        articles = [{
            "번호": n + 1, "카테고리": "", "제목": "", "부제": "",
            "요약": [], "한마디": [], "본문": [], "이미지": None,
        } for n in range(MONTHLY_ARTICLES)]

    body = {"id": issue_id, "편집장의말": [], "기사": articles}
    body_path = BODY_DIR / f"{issue_id}.json"
    if body_path.exists():
        print(f"중단: {body_path} 가 이미 존재합니다.")
        sys.exit(1)
    atomic_write(body_path, json.dumps(body, ensure_ascii=False, indent=1))
    (BODY_DIR / issue_id).mkdir(exist_ok=True)

    entry = {
        "id": issue_id,
        "채널": args.channel,
        "호수": number,
        "제목": "",
        "주차라벨": week_label(pub_date, args.channel),
        "발행일": pub_date.isoformat(),
        "요약": None,
        "꼭지": [],
        "커버이미지": None,
        "본문파일": f"data/care/issues/{issue_id}.json",
        "상태": "초안",
    }
    if args.publisher != "안창민":
        entry["발행인"] = args.publisher
    issues.insert(0, entry)
    payload = issues if isinstance(data, list) else {**data, "data": issues}
    atomic_write(ISSUES, json.dumps(payload, ensure_ascii=False, indent=1))

    print(f"초안 생성: {args.channel} {args.publisher} {number}호 ({issue_id})")
    print(f"발행 예정일: {pub_date.isoformat()} ({entry['주차라벨']})")
    print(f"본문 뼈대: {body_path}")
    print("다음: 발행 세션에서 기사를 집필하고, 완성되면")
    print(f"  python pipeline/publish_care_issue.py --id {issue_id}")


if __name__ == "__main__":
    main()
