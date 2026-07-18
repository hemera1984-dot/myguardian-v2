"""화면 검증 스크린샷 스크립트.

사용법: python scripts/screenshot.py [페이지경로...]
예: python scripts/screenshot.py web/index.html web/cases/index.html
결과: scripts/shots/ 에 데스크톱(1920px)·태블릿(1180px)·모바일(390px) 전체 페이지 스크린샷 저장
동작: 저장소 루트를 로컬 HTTP로 서빙한 뒤 촬영한다 (fetch 기반 화면 대응).
사전 준비: pip install playwright && python -m playwright install chromium
"""

import functools
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "scripts" / "shots"

VIEWPORTS = [
    ("desktop-1920", 1920, 1080),
    ("tablet-1180", 1180, 820),
    ("mobile-390", 390, 844),
]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main() -> None:
    pages = sys.argv[1:] or ["web/index.html"]
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for page_path in pages:
                rel = page_path.replace("\\", "/")
                url = f"http://127.0.0.1:{port}/{rel}"
                slug = rel.replace("/", "_").removesuffix(".html")
                for name, width, height in VIEWPORTS:
                    page = browser.new_page(viewport={"width": width, "height": height})
                    page.goto(url, wait_until="networkidle")
                    out = OUT_DIR / f"{slug}-{name}.png"
                    page.screenshot(path=str(out), full_page=True)
                    print(f"저장: {out}")
                    page.close()
            browser.close()
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
