"""마누스 웹(insurguard.life)에서 v1 케어센터 발행물을 백업·입주하는 수집기.

주간 안창민 11호 + 월간 안창민 4호를 잡지 구조 그대로 가져온다:
- 기사별 요약 / 안창민 FC의 한마디 / 전문(소제목 포함)을 분리 보존
- 표지·기사 이미지 다운로드 (CloudFront)
- 월간의 편집장의 말 보존

산출물:
- data/care/issues/<id>.json      (기사 구조 데이터)
- data/care/issues/<id>/*.jpg     (표지·기사 이미지)
- data/care/issues.json           (호 메타 목록)

원칙: 문장은 원문 그대로(추출만). 화면 장식 토큰만 걷어낸다.
사용법: python pipeline/scrape_care.py
"""

import json
import re
import urllib.request
from datetime import date, timedelta
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "care" / "issues"

WEEKLY_IDS = [2, 30001, 60001, 90001, 120001, 150001, 180001, 210001, 240001, 270001, 300001]
MONTHLY_IDS = [150001, 180001, 210001, 240001]

NOISE = {
    "서재", "서재로", "스와이프", "전문 읽기", "목차", "CONTENTS", "EDITOR'S NOTE",
    "WEEKLY NEWSPAPER", "MONTHLY MAGAZINE", "SHINHAN LIFE", "이번 주 뉴스",
    "安", "요약", "안창민 FC", "안창민 FC · 신한라이프", "안창민",
}
NOISE_RE = [
    re.compile(r"^\d+\s*/\s*\d+$"),
    re.compile(r"^VOL\.\s*\d+$"),
    re.compile(r"^\d{2}\s*/\s*\d{2}$"),
    re.compile(r"^(WEEKLY|MONTHLY) AHN"),
    re.compile(r"^편집장"),
    re.compile(r"통권\s*제?\d+호"),
    re.compile(r"^(주간|월간) 안창민 \d{4}"),
    re.compile(r"^신한라이프 .*(지점|전문)"),
    re.compile(r"^JULY|^JUNE|^MAY|^APRIL"),
]
STOP_LINES = {"다음 기사", "이전 기사"}
COMMENT_MARK = "안창민 FC의 한마디"


def first_monday(year: int, month: int) -> date:
    d = date(year, month, 1)
    return d + timedelta(days=(7 - d.weekday()) % 7)


def parse_pub_date(label: str) -> str:
    m = re.search(r"(\d{4})년\s*(\d+)월\s*(\d+)주차", label)
    if m:
        y, mo, wk = int(m.group(1)), int(m.group(2)), int(m.group(3))
        return (first_monday(y, mo) + timedelta(weeks=wk - 1)).isoformat()
    m = re.search(r"(\d{4})년\s*(\d+)월호", label)
    if m:
        return first_monday(int(m.group(1)), int(m.group(2))).isoformat()
    return ""


def clean_lines(text: str) -> list[str]:
    out = []
    for raw in text.splitlines():
        line = raw.strip()
        if line in STOP_LINES:
            break
        if not line or line in NOISE:
            continue
        if any(rx.search(line) for rx in NOISE_RE):
            continue
        out.append(line)
    return out


def is_subheading(line: str) -> bool:
    if len(line) > 32 or "." in line:
        return False
    return not re.search(r"(다|요|죠|까|니다)[.!?]?$", line)


def parse_toc(buttons: list[str]) -> list[dict]:
    toc = []
    for label in buttons:
        parts = [p.strip() for p in label.split("\n") if p.strip()]
        if len(parts) >= 3 and re.fullmatch(r"\d{2}", parts[0]):
            toc.append({
                "번호": int(parts[0]),
                "카테고리": parts[1],
                "제목": parts[2],
                "부제": parts[3] if len(parts) > 3 else "",
            })
    return toc


def parse_article(full_text: str, entry: dict) -> dict:
    """전문 뷰 텍스트를 요약 / 한마디 / 본문(소제목 포함)으로 분해한다. 문장은 그대로 둔다."""
    skip = {entry["제목"], entry["부제"], entry["카테고리"]}
    lines = [ln for ln in clean_lines(full_text) if ln not in skip]

    summary: list[str] = []
    comment: list[str] = []
    body: list[dict] = []
    mode = "요약"
    for line in lines:
        if line == COMMENT_MARK:
            mode = "한마디"
            continue
        if mode in ("요약", "한마디") and is_subheading(line):
            mode = "본문"
            body.append({"t": "h", "x": line})
            continue
        if mode == "요약":
            summary.append(line)
        elif mode == "한마디":
            comment.append(line)
        else:
            body.append({"t": "h" if is_subheading(line) else "p", "x": line})

    return {**entry, "요약": summary, "한마디": comment, "본문": body}


def download_image(url: str, dest_stem: Path) -> str | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            ctype = resp.headers.get("Content-Type", "")
            ext = {"image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}.get(ctype, ".jpg")
            dest = dest_stem.with_suffix(ext)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(resp.read())
        return str(dest.relative_to(ROOT)).replace("\\", "/")
    except Exception as e:
        print(f"  이미지 실패: {url[:60]} ({e})")
        return None


def scrape_issue(pg, channel: str, vol: int, url: str) -> dict:
    pg.goto(url, wait_until="networkidle", timeout=60000)
    pg.wait_for_timeout(2000)
    deck_text = pg.locator("body").inner_text()

    label_m = re.search(r"\d{4}년\s*\d+월\s*(?:\d+주차|호)", deck_text)
    label = label_m.group(0) if label_m else ""
    buttons = pg.evaluate("() => [...document.querySelectorAll('button')].map(b => b.innerText)")
    toc = parse_toc(buttons)

    issue_id = ("weekly" if channel == "주간" else "monthly") + f"-{vol:02d}"
    img_dir = OUT_DIR / issue_id

    # 이미지: 첫 장 = 표지, 이후 = 기사 삽화 순서
    img_urls = pg.evaluate("() => [...document.images].map(i => i.getAttribute('src')).filter(Boolean)")
    cover = download_image(img_urls[0], img_dir / "cover") if img_urls else None
    art_imgs: list[str | None] = []
    for i, src in enumerate(img_urls[1:len(toc) + 1]):
        art_imgs.append(download_image(src, img_dir / f"art-{i + 1}"))
    while len(art_imgs) < len(toc):
        art_imgs.append(None)

    # 월간 편집장의 말 (표지 덱에서 캡처)
    editors_note: list[str] = []
    if channel == "월간" and "편집장의 말" in deck_text:
        seg = deck_text.split("편집장의 말", 1)[1].split("CONTENTS", 1)[0]
        editors_note = [ln for ln in clean_lines(seg) if ln not in ("“", "”")]

    # 기사별 전문 수집
    articles: list[dict] = []
    n_articles = pg.locator("button", has_text="전문 읽기").count()
    for i in range(n_articles):
        pg.goto(url, wait_until="networkidle", timeout=60000)
        pg.wait_for_timeout(1500)
        pg.locator("button", has_text="전문 읽기").nth(i).click()
        pg.wait_for_timeout(1500)
        full = pg.locator("body").inner_text()
        entry = toc[i] if i < len(toc) else {"번호": i + 1, "카테고리": "", "제목": f"{i + 1}면 기사", "부제": ""}
        article = parse_article(full, entry)
        article["이미지"] = art_imgs[i] if i < len(art_imgs) else None
        articles.append(article)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    issue_data = {"id": issue_id, "편집장의말": editors_note, "기사": articles}
    with open(OUT_DIR / f"{issue_id}.json", "w", encoding="utf-8") as f:
        json.dump(issue_data, f, ensure_ascii=False, indent=1)

    meta = {
        "id": issue_id,
        "발행인": "안창민",
        "채널": channel,
        "호수": vol,
        "제목": toc[0]["제목"] if toc else label,
        "주차라벨": label,
        "발행일": parse_pub_date(label),
        "요약": " · ".join(t["제목"] for t in toc),
        "꼭지": toc,
        "커버이미지": cover,
        "본문파일": f"data/care/issues/{issue_id}.json",
        "원문링크": url,
    }
    n_imgs = sum(1 for x in [cover] + art_imgs if x)
    print(f"수집: {issue_id} [{label}] 기사 {len(articles)}건, 이미지 {n_imgs}장")
    return meta


def main() -> None:
    issues = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        pg = browser.new_page()
        for vol, sid in enumerate(WEEKLY_IDS, start=1):
            issues.append(scrape_issue(pg, "주간", vol, f"https://www.insurguard.life/weekly/{sid}"))
        for vol, sid in enumerate(MONTHLY_IDS, start=1):
            issues.append(scrape_issue(pg, "월간", vol, f"https://www.insurguard.life/magazine/{sid}"))
        browser.close()

    with open(ROOT / "data" / "care" / "issues.json", "w", encoding="utf-8") as f:
        json.dump(issues, f, ensure_ascii=False, indent=1)
    print(f"완료: {len(issues)}개 호 입주")


if __name__ == "__main__":
    main()
