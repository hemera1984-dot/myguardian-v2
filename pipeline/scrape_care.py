"""마누스 웹(insurguard.life)에서 v1 케어센터 발행물을 백업·입주하는 수집기.

주간 안창민 11호 + 월간 안창민 4호의 전문을 긁어
data/care/issues/<id>.html 조각과 data/care/issues.json 메타를 생성한다.

원칙: 콘텐츠는 원문 그대로 보존(추출만). 화면 장식 토큰만 걷어낸다.
사용법: python pipeline/scrape_care.py
"""

import json
import re
from datetime import date, timedelta
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "care" / "issues"

WEEKLY_IDS = [2, 30001, 60001, 90001, 120001, 150001, 180001, 210001, 240001, 270001, 300001]
MONTHLY_IDS = [150001, 180001, 210001, 240001]

# 화면 장식·내비게이션 토큰 (본문에서 제거)
NOISE = {
    "서재", "서재로", "스와이프", "전문 읽기", "목차", "CONTENTS", "EDITOR'S NOTE",
    "WEEKLY NEWSPAPER", "MONTHLY MAGAZINE", "SHINHAN LIFE", "이번 주 뉴스",
    "安", "요약", "안창민 FC · 신한라이프",
}
NOISE_RE = [
    re.compile(r"^\d+\s*/\s*\d+$"),      # 페이지 표시 (1 / 6)
    re.compile(r"^VOL\.\s*\d+$"),
    re.compile(r"^\d{2}\s*/\s*\d{2}$"),  # 기사 표시 (01 / 04)
    re.compile(r"^(WEEKLY|MONTHLY) AHN"),
    re.compile(r"^편집장"),
    re.compile(r"통권\s*제?\d+호"),
    re.compile(r"^(주간|월간) 안창민 \d{4}"),
    re.compile(r"^신한라이프 .*(지점|전문)"),
]
# 이 줄부터는 다음 기사 안내 — 본문 종료
STOP_LINES = {"다음 기사", "이전 기사"}


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
    """전문 안의 소제목 판별: 짧고, 종결어미·마침표 없이 끝나는 줄."""
    if len(line) > 32 or "." in line:
        return False
    return not re.search(r"(다|요|죠|까|니다)[.!?]?$", line)


def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def parse_toc(buttons: list[str]) -> list[dict]:
    """목차 버튼 라벨('01\\n카테고리\\n제목\\n\\n부제')에서 꼭지 목록을 뽑는다."""
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


def article_html(full_text: str, toc_entry: dict) -> str:
    """전문 뷰 텍스트를 HTML 조각으로 변환. 제목·부제 중복 줄은 걷어낸다."""
    lines = clean_lines(full_text)
    title, subtitle = toc_entry["제목"], toc_entry["부제"]
    body: list[str] = []
    for line in lines:
        if line in (title, subtitle, toc_entry["카테고리"], "안창민 FC"):
            continue
        body.append(line)
    html = [f'<h2>{esc(toc_entry["카테고리"])} · {esc(title)}</h2>']
    if subtitle:
        html.append(f"<p><strong>{esc(subtitle)}</strong></p>")
    for para in body:
        if para in ("안창민 FC의 한마디", "편집장의 말") or is_subheading(para):
            html.append(f"<h3>{esc(para)}</h3>")
        else:
            html.append(f"<p>{esc(para)}</p>")
    return "\n".join(html)


def scrape_issue(pg, channel: str, vol: int, url: str) -> dict:
    pg.goto(url, wait_until="networkidle", timeout=60000)
    pg.wait_for_timeout(2000)
    deck_text = pg.locator("body").inner_text()

    label_m = re.search(r"\d{4}년\s*\d+월\s*(?:\d+주차|호)", deck_text)
    label = label_m.group(0) if label_m else ""
    buttons = pg.evaluate("() => [...document.querySelectorAll('button')].map(b => b.innerText)")
    toc = parse_toc(buttons)

    n_articles = pg.locator("button", has_text="전문 읽기").count()
    fragments: list[str] = []

    # 월간의 편집장의 말은 표지 덱에만 있으므로 덱에서 캡처
    if channel == "월간" and "편집장의 말" in deck_text:
        seg = deck_text.split("편집장의 말", 1)[1].split("CONTENTS", 1)[0]
        paras = [ln for ln in clean_lines(seg) if ln not in ("“", "”", "安")]
        fragments.append("<h3>편집장의 말</h3>\n" + "\n".join(f"<p>{esc(p)}</p>" for p in paras))

    for i in range(n_articles):
        pg.goto(url, wait_until="networkidle", timeout=60000)
        pg.wait_for_timeout(1500)
        pg.locator("button", has_text="전문 읽기").nth(i).click()
        pg.wait_for_timeout(1500)
        full = pg.locator("body").inner_text()
        entry = toc[i] if i < len(toc) else {"번호": i + 1, "카테고리": "", "제목": f"{i + 1}번 기사", "부제": ""}
        fragments.append(article_html(full, entry))

    issue_id = ("weekly" if channel == "주간" else "monthly") + f"-{vol:02d}"
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUT_DIR / f"{issue_id}.html", "w", encoding="utf-8") as f:
        f.write("\n<hr>\n".join(fragments) + "\n")

    meta = {
        "id": issue_id,
        "채널": channel,
        "호수": vol,
        "제목": toc[0]["제목"] if toc else label,
        "주차라벨": label,
        "발행일": parse_pub_date(label),
        "요약": " · ".join(t["제목"] for t in toc),
        "꼭지": toc,
        "본문파일": f"data/care/issues/{issue_id}.html",
        "원문링크": url,
    }
    print(f"수집: {issue_id} [{label}] 꼭지 {len(toc)}개, 전문 {n_articles}건")
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
