"""표지 포브스 틀 + 삽화 슬롯 검증 렌더.

사용법: python scripts/shot_artwork.py
결과: .omd/.cache/artwork/ 에 지면(390)·서재(390)·데스크 이미지 슬롯(1280) 저장.
"""

import functools
import json
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".omd" / ".cache" / "artwork"

DRAFT = {
    "id": "weekly-99",
    "채널": "주간",
    "호수": 99,
    "발행일": "2026-08-03",
    "주차라벨": "2026년 8월 1주차",
    "발행인": "안창민",
    "커버이미지": "",
    "편집장의말": [],
    "기사": [
        {"번호": 1, "카테고리": "HOT ISSUE", "제목": "보유세 개편, 무엇이 달라지나",
         "부제": "다주택자 과세 구간 조정", "요약": ["정부가 보유세 체계를 손본다."],
         "한마디": [],
         "본문": [{"t": "h", "x": "보유세 개편, 무엇이 달라지나"},
                  {"t": "p", "x": "정부가 보유세 체계를 손보겠다고 밝혔습니다. "
                              "과세 구간과 공정시장가액비율이 함께 논의되고 있습니다."}],
         "이미지": "", "방향": ""},
        {"번호": 2, "카테고리": "LIFESTYLE", "제목": "환절기 건강 점검",
         "부제": "", "요약": [], "한마디": [], "본문": [], "이미지": "", "방향": ""},
        {"번호": 3, "카테고리": "INSIGHT", "제목": "상속 준비의 순서",
         "부제": "", "요약": [], "한마디": [], "본문": [], "이미지": "", "방향": ""},
    ],
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", 8126), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:8126"
    log = []

    with sync_playwright() as p:
        browser = p.chromium.launch()

        # ── 지면 표지 — 커버이미지가 있는 호(weekly-12)와 없는 호(weekly-13)
        for issue_id in ("weekly-12", "weekly-13"):
            for w, h in ((390, 844), (1280, 900)):
                page = browser.new_page(viewport={"width": w, "height": h})
                page.goto(f"{base}/web/care/issue.html?id={issue_id}", wait_until="networkidle")
                page.wait_for_selector(".bh .masthead", timeout=15000)
                page.wait_for_timeout(600)
                page.screenshot(path=str(OUT / f"issue-{issue_id}-{w}.png"))
                if w == 390:
                    m = page.evaluate(
                        """() => {
                            const d = document.querySelector('.masthead__deck');
                            const t = document.querySelector('.masthead__title');
                            return {
                                overflow: document.documentElement.scrollWidth
                                    > document.documentElement.clientWidth,
                                photo: !!document.querySelector('.masthead__photo'),
                                shapes: !!document.querySelector('.masthead__circle'),
                                also: document.querySelectorAll('.masthead__also li').length,
                                deckPx: d ? getComputedStyle(d).fontSize : null,
                                titlePx: t ? getComputedStyle(t).fontSize : null,
                                foot: !!document.querySelector('.masthead__foot')
                            };
                        }"""
                    )
                    log.append(f"[지면 {issue_id} 390] {json.dumps(m, ensure_ascii=False)}")
                page.close()

        # ── 서재 표지 카드
        for w, h in ((390, 844), (1280, 900)):
            page = browser.new_page(viewport={"width": w, "height": h})
            page.goto(f"{base}/web/care/index.html", wait_until="networkidle")
            page.wait_for_selector(".shelf__item", timeout=15000)
            page.evaluate(
                "async () => { const step = innerHeight;"
                " for (let y = 0; y < document.body.scrollHeight; y += step) {"
                "   scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); }"
                " scrollTo(0, 0); }"
            )
            page.wait_for_timeout(800)
            page.screenshot(path=str(OUT / f"library-{w}.png"), full_page=True)
            if w == 390:
                log.append("[서재 390] " + json.dumps(page.evaluate(
                    """() => ({
                        items: document.querySelectorAll('.shelf__item').length,
                        svg: document.querySelectorAll('.shelf__cover .shelf-svg').length,
                        photos: document.querySelectorAll('.shelf__cover image').length,
                        overflow: document.documentElement.scrollWidth
                            > document.documentElement.clientWidth
                    })"""
                ), ensure_ascii=False))
            page.close()

        # ── 데스크 이미지 슬롯 — 초안을 심어 두고 편집 화면을 연다
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.goto(f"{base}/web/care/desk.html", wait_until="networkidle")
        page.evaluate(
            "d => localStorage.setItem('mg_care_draft_' + d.id, JSON.stringify(d))", DRAFT
        )
        page.goto(f"{base}/web/care/desk.html", wait_until="networkidle")
        page.wait_for_selector(f'button[data-edit="{DRAFT["id"]}"]', timeout=15000)
        page.click(f'button[data-edit="{DRAFT["id"]}"]')
        page.wait_for_selector(".img-slot", timeout=15000)
        page.click("[data-col-toggle=\"0\"]")  # 칼럼을 펼쳐야 칼럼 이미지 슬롯이 보인다
        page.wait_for_timeout(500)
        page.screenshot(path=str(OUT / "desk-slot-1280.png"), full_page=True)
        log.append("[데스크 1280] " + json.dumps(page.evaluate(
            """() => ({
                slots: document.querySelectorAll('.img-slot').length,
                buttons: [...document.querySelectorAll('[data-artwork]')].map(b => b.textContent),
                prompt: [...document.querySelectorAll('[data-imgai]')].map(b => b.textContent)
            })"""
        ), ensure_ascii=False))

        # 미인증 상태에서 삽화 만들기 — 안내가 떠야 한다
        page.click('[data-artwork="cover"]')
        page.wait_for_timeout(500)
        log.append("[미인증 안내] " + json.dumps(page.evaluate(
            "() => { const b = document.querySelector('[data-prompt=\\'cover\\']');"
            " return b && !b.hidden ? b.textContent : 'no-note'; }"
        ), ensure_ascii=False))
        page.screenshot(path=str(OUT / "desk-slot-1280-note.png"))
        page.close()
        browser.close()

    (OUT / "check.txt").write_text("\n".join(log), encoding="utf-8")
    print("\n".join(log))
    print("saved:", OUT)


if __name__ == "__main__":
    sys.exit(main())
