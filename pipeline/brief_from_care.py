"""케어센터 발행호 → 브리핑 문서 변환 공정.

케어센터 발행물(data/care/issues/<id>.json)을 브리핑 문서(data/brief/<브리핑id>.json)로
변환한다. 내용 생성 없이 추출·재배치만 한다:

- 표지: 발행호 커버 + 대표 기사 제목. 스크립트 = 발행호 요약(실데이터)
- 차례: 꼭지 목록 그대로
- 기사마다: 이미지 페이지(기사 삽화 + 제목·부제, 스크립트 = 기사 요약)
  + 본문 페이지(소제목 단위로 분할, 마지막 페이지 스크립트 = 한마디)
- 원본의 번호형 문단("1. …", 40자 이하)은 원문에서 소제목 역할이므로 소제목으로 승격

사용법: python pipeline/brief_from_care.py <발행호id> <브리핑id> <모드> <작성일>
예:     python pipeline/brief_from_care.py weekly-11 lecture-2026-001 강의 2026-07-19
검증:   생성 직후 data/schema/brief-doc.schema.json으로 스키마 검증까지 수행한다.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

PAGE_CHAR_LIMIT = 800  # 본문 페이지당 문자 수 상한 (청중 화면 한 화면 가독 기준)
NUMBERED_HEADING = re.compile(r"^[0-9]+\.\s?\S")


def is_heading(block: dict) -> bool:
    if block["t"] == "h":
        return True
    return bool(NUMBERED_HEADING.match(block["x"])) and len(block["x"]) <= 40


def split_sections(body: list) -> list:
    """본문 블록을 (소제목, 문단들) 구간으로 나눈다."""
    sections = []
    title, paras = None, []
    for block in body:
        if is_heading(block):
            if paras:
                sections.append((title, paras))
            title, paras = re.sub(r"^[0-9]+\.\s?", "", block["x"]), []
        else:
            paras.append(block["x"])
    if paras:
        sections.append((title, paras))
    return sections


def paginate(title: str, paras: list) -> list:
    """한 구간을 문자 수 상한에 맞춰 페이지들로 나눈다."""
    pages, chunk, size = [], [], 0
    for p in paras:
        if chunk and size + len(p) > PAGE_CHAR_LIMIT:
            pages.append((title, chunk))
            chunk, size = [], 0
        chunk.append(p)
        size += len(p)
    if chunk:
        pages.append((title, chunk))
    return pages


def main() -> None:
    if len(sys.argv) != 5:
        sys.exit("사용법: python pipeline/brief_from_care.py <발행호id> <브리핑id> <모드> <작성일>")
    issue_id, brief_id, mode, made_date = sys.argv[1:5]

    with open(ROOT / "data" / "care" / "issues.json", encoding="utf-8") as f:
        meta = next(i for i in json.load(f) if i["id"] == issue_id)
    with open(ROOT / "data" / "care" / "issues" / f"{issue_id}.json", encoding="utf-8") as f:
        issue = json.load(f)

    publisher = meta.get("발행인", "안창민")
    channel_label = f"{meta['채널']} {publisher} 제{meta['호수']}호"
    pages = []

    def add(page: dict) -> None:
        page["번호"] = len(pages) + 1
        pages.append(page)

    # 표지
    cover = {
        "유형": "표지",
        "킥커": f"{channel_label} · {meta.get('주차라벨') or meta['발행일']}",
        "제목": meta["제목"],
        "부제": f"발행 {publisher} FC · {meta['발행일']}",
    }
    if meta.get("커버이미지"):
        cover["이미지"] = meta["커버이미지"]
    if meta.get("요약"):
        cover["스크립트"] = meta["요약"]
    add(cover)

    # 차례
    toc = meta.get("꼭지") or [
        {"번호": a["번호"], "카테고리": a.get("카테고리", ""), "제목": a["제목"], "부제": a.get("부제", "")}
        for a in issue["기사"]
    ]
    add({
        "유형": "본문",
        "킥커": channel_label,
        "제목": "차례",
        "본문": [
            {"t": "li", "x": f"[{t.get('카테고리', '')}] {t['제목']} — {t.get('부제', '')}".strip(" —")}
            for t in toc
        ],
    })

    # 기사
    for art in issue["기사"]:
        intro = {
            "유형": "이미지" if art.get("이미지") else "본문",
            "킥커": art.get("카테고리", ""),
            "제목": art["제목"],
            "부제": art.get("부제", ""),
        }
        if art.get("이미지"):
            intro["이미지"] = art["이미지"]
        if art.get("요약"):
            intro["스크립트"] = "\n\n".join(art["요약"])
        add(intro)

        body_pages = []
        for title, paras in split_sections(art.get("본문", [])):
            body_pages.extend(paginate(title or art["제목"], paras))
        for i, (title, paras) in enumerate(body_pages):
            page = {
                "유형": "본문",
                "킥커": art.get("카테고리", ""),
                "제목": title,
                "본문": [{"t": "p", "x": p} for p in paras],
            }
            if i == len(body_pages) - 1 and art.get("한마디"):
                page["스크립트"] = art["한마디"][0]
            add(page)

    doc = {
        "id": brief_id,
        "제목": f"{channel_label} — {meta['제목']}",
        "모드": mode,
        "작성일": made_date,
        "작성자": f"{publisher} FC",
        "요약": meta.get("요약"),
        "출처": f"care:{issue_id}",
        "페이지": pages,
    }

    # 스키마 검증
    import jsonschema

    with open(ROOT / "data" / "schema" / "brief-doc.schema.json", encoding="utf-8") as f:
        jsonschema.validate(doc, json.load(f))

    out = ROOT / "data" / "brief" / f"{brief_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"생성: {out} (페이지 {len(pages)}장, 스키마 검증 통과)")


if __name__ == "__main__":
    main()
