"""화면 검증 스크린샷 스크립트.

사용법: python scripts/screenshot.py [페이지경로...]
예: python scripts/screenshot.py web/index.html web/claims/index.html
결과: scripts/shots/ 에 데스크톱(1920px)·모바일(390px) 전체 페이지 스크린샷 저장
사전 준비: pip install playwright && python -m playwright install chromium
"""

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "scripts" / "shots"

VIEWPORTS = [
    ("desktop-1920", 1920, 1080),
    ("mobile-390", 390, 844),
]


def main() -> None:
    pages = sys.argv[1:] or ["web/index.html"]
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        for page_path in pages:
            url = (ROOT / page_path).resolve().as_uri()
            slug = page_path.replace("\\", "_").replace("/", "_").removesuffix(".html")
            for name, width, height in VIEWPORTS:
                page = browser.new_page(viewport={"width": width, "height": height})
                page.goto(url, wait_until="networkidle")
                out = OUT_DIR / f"{slug}-{name}.png"
                page.screenshot(path=str(out), full_page=True)
                print(f"저장: {out}")
                page.close()
        browser.close()


if __name__ == "__main__":
    main()
