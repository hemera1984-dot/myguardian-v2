"""케어센터 발행 공정 — 초안 검증 후 발행 전환.

사용법: python pipeline/publish_care_issue.py --id weekly-12

검증 항목을 전부 통과해야 발행된다. 하나라도 실패하면 목록을 출력하고 중단한다.
본문 구조는 data/schema/care-body.schema.json을 jsonschema로 실검증하고 (수동 검증과의
불일치 원천 차단 — Codex 5차), 스키마가 못 보는 정합(id 일치·채널별 기사 수·번호 연속유일·
파일 실존)만 코드로 보탠다.
발행 전환은 임시 파일에 쓴 뒤 원자적으로 교체한다 — 절반만 쓰인 issues.json을 남기지 않는다.
"""

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

try:
    import jsonschema
except ImportError:
    print("jsonschema 라이브러리가 필요합니다: pip install jsonschema")
    sys.exit(1)

# Windows 기본 콘솔(cp949)에서도 한글·특수문자 출력이 깨지지 않게 한다 (Codex 4차 중요 4)
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
ISSUES = ROOT / "data" / "care" / "issues.json"

ARTICLE_COUNT = {"주간": 4, "월간": 3}


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


def schema_errors(body):
    """care-body.schema.json 실검증 — 위반 목록을 사람이 읽을 수 있는 형태로"""
    schema = json.loads((ROOT / "data" / "schema" / "care-body.schema.json").read_text(encoding="utf-8"))
    validator = jsonschema.Draft202012Validator(schema)
    out = []
    for err in sorted(validator.iter_errors(body), key=lambda e: list(e.absolute_path)):
        path = "/".join(str(p) for p in err.absolute_path) or "(루트)"
        out.append(f"본문 규격 위반 [{path}]: {err.message}")
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--id", required=True)
    args = parser.parse_args()

    data = json.loads(ISSUES.read_text(encoding="utf-8"))
    issues = data if isinstance(data, list) else data.get("data", [])
    entry = next((i for i in issues if i.get("id") == args.id), None)

    if entry is None:
        print(f"중단: issues.json에 {args.id} 가 없습니다.")
        sys.exit(1)
    if entry.get("상태") != "초안":
        print(f"중단: {args.id} 는 초안 상태가 아닙니다 (현재: {entry.get('상태', '발행')}).")
        sys.exit(1)

    body_path = ROOT / entry.get("본문파일", "")
    if not body_path.exists():
        print(f"중단: 본문 파일이 없습니다 - {body_path}")
        sys.exit(1)
    body = json.loads(body_path.read_text(encoding="utf-8"))

    # 1) 스키마 실검증 — 자료형·필수 필드·패턴은 전부 여기서 걸린다
    errors = schema_errors(body)

    # 2) 스키마가 못 보는 정합 검사 — 자료형이 보장된 경우에만 수행 (오류 시 충돌 방지)
    if not (entry.get("제목") or "").strip():
        errors.append("호 제목이 비어 있습니다 (issues.json의 제목)")
    if body.get("id") != entry.get("id"):
        errors.append(f"본문 id({body.get('id')})와 메타 id({entry.get('id')})가 다릅니다")

    articles = body.get("기사") if isinstance(body.get("기사"), list) else []
    dict_articles = [a for a in articles if isinstance(a, dict)]
    if not errors and dict_articles:
        expected = ARTICLE_COUNT.get(entry.get("채널"))
        if expected and len(dict_articles) != expected:
            errors.append(f"기사 수가 {len(dict_articles)}개 - {entry['채널']}은 {expected}개여야 합니다")
        numbers = [a.get("번호") for a in dict_articles]
        if sorted(n for n in numbers if isinstance(n, int) and not isinstance(n, bool)) != list(range(1, len(dict_articles) + 1)):
            errors.append(f"기사 번호가 1~{len(dict_articles)} 연속·유일이 아닙니다: {numbers}")
        for a in dict_articles:
            img = a.get("이미지")
            if isinstance(img, str) and img and not (ROOT / img).exists():
                errors.append(f"기사 {a.get('번호')}: 이미지 파일 없음 - {img}")

    cover = entry.get("커버이미지")
    if cover and not (ROOT / cover).exists():
        errors.append(f"커버이미지 파일 없음 - {cover}")

    if errors:
        print(f"발행 불가 - {len(errors)}건:")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)

    # 발행 전환: 꼭지·요약을 본문에서 동기화하고 상태 변경 (원자적 쓰기)
    entry["꼭지"] = [{
        "번호": a["번호"],
        "카테고리": a.get("카테고리") or "",
        "제목": a["제목"],
        "부제": a.get("부제") or "",
    } for a in articles]
    entry["요약"] = " · ".join(a["제목"] for a in articles)
    entry["상태"] = "발행"

    payload = issues if isinstance(data, list) else {**data, "data": issues}
    atomic_write(ISSUES, json.dumps(payload, ensure_ascii=False, indent=1))

    print(f"발행 완료: {entry['채널']} {entry.get('발행인', '안창민')} {entry['호수']}호 - {entry['제목']}")
    print("다음: commit·push 후 발행 데스크에서 카톡 문구를 복사해 발송하세요.")


if __name__ == "__main__":
    main()
