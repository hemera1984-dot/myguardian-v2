"""케어 지면 바우하우스 검증 렌더.

사용법: python scripts/shot_issue_bh.py
결과: .omd/.cache/issue-bh/ 에 지면·서재·데스크 미리보기 스크린샷과 측정값(check.txt) 저장.
"""

import functools
import json
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".omd" / ".cache" / "issue-bh"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", 8124), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:8124"
    log = []

    with sync_playwright() as p:
        browser = p.chromium.launch()

        def issue_shots(issue_id, full=False):
            page = browser.new_page(viewport={"width": 390, "height": 844})
            page.goto(f"{base}/web/care/issue.html?id={issue_id}", wait_until="networkidle")
            page.wait_for_selector(".bh .masthead", timeout=15000)
            page.wait_for_timeout(700)
            page.screenshot(path=str(OUT / f"{issue_id}-390.png"))
            if full:
                page.screenshot(path=str(OUT / f"{issue_id}-390-full.png"), full_page=True)
            m = page.evaluate(
                """() => ({
                    scrollWidth: document.documentElement.scrollWidth,
                    clientWidth: document.documentElement.clientWidth,
                    bodyScroll: document.body.scrollWidth,
                    marks: document.querySelectorAll('mark.key-hit').length,
                    stats: document.querySelectorAll('.stat').length,
                    peak: document.querySelectorAll('.stat.peak').length,
                    spotlight: document.querySelectorAll('.spotlight').length,
                    turning: document.querySelectorAll('.turning-point').length,
                    tables: document.querySelectorAll('.comparison').length,
                    posters: document.querySelectorAll('.poster').length,
                    toc: document.querySelectorAll('.toc__item').length,
                    past: document.querySelectorAll('.past__item').length,
                    serif: [...document.querySelectorAll('.bh h1,.bh h2,.bh p')].filter(
                        n => /serif/i.test(getComputedStyle(n).fontFamily)).length
                })"""
            )
            log.append(f"[{issue_id}] {json.dumps(m, ensure_ascii=False)}")

            # 글자 크기 토글 3단
            sizes = []
            for _ in range(3):
                page.click("#font-toggle")
                sizes.append(
                    page.evaluate(
                        "() => { const n=document.querySelector('.body-paragraph') || document.querySelector('.summary-note');"
                        " return n ? [document.getElementById('font-toggle').textContent,"
                        " getComputedStyle(n).fontSize] : null; }"
                    )
                )
            log.append(f"[{issue_id}] 글자크기 토글: {json.dumps(sizes, ensure_ascii=False)}")
            page.screenshot(path=str(OUT / f"{issue_id}-390-fs3.png"))
            # 3번 눌러 이미 기본(가)으로 돌아온 상태다

            # 구획별 확인 컷 — 포스터·대형 수치·색면 문단·비교표·지난 호
            for name, sel in (
                ("poster", ".article-1 .poster"),
                ("lead", ".article-1 .lead"),
                ("peak", ".stat.peak"),
                ("spotlight", ".spotlight"),
                ("table", ".comparison"),
                ("turning", ".turning-point"),
                ("past", ".past"),
            ):
                if page.query_selector(sel):
                    page.eval_on_selector(
                        sel, "n => n.scrollIntoView({block:'start', behavior:'instant'})"
                    )
                    page.wait_for_timeout(400)
                    page.screenshot(path=str(OUT / f"{issue_id}-390-{name}.png"))

            # 진행바 + 목차 이동
            page.evaluate(
                "() => window.scrollTo({top: document.documentElement.scrollHeight,"
                " behavior: 'instant'})"
            )
            page.wait_for_timeout(900)
            log.append(
                f"[{issue_id}] 진행바 끝: "
                + page.evaluate("() => document.getElementById('mag-progress').style.width")
            )
            if m["toc"]:
                page.evaluate("() => window.scrollTo(0,0)")
                page.click(".toc__item:nth-child(2) .toc__link")
                page.wait_for_timeout(2600)
                log.append(
                    f"[{issue_id}] 목차 이동 → #a2 상단거리 "
                    + str(page.evaluate(
                        "() => { const a=document.getElementById('a2');"
                        " return a ? Math.round(a.getBoundingClientRect().top) : 'no-a2'; }"
                    ))
                )
                page.screenshot(path=str(OUT / f"{issue_id}-390-toc.png"))
            page.close()

        issue_shots("monthly-04", full=True)
        issue_shots("weekly-12")
        issue_shots("weekly-13")

        # 서재
        for w, h in ((390, 844), (1280, 900)):
            page = browser.new_page(viewport={"width": w, "height": h})
            page.goto(f"{base}/web/care/index.html", wait_until="networkidle")
            page.wait_for_selector(".shelf__item", timeout=15000)
            # 전체 페이지 촬영 전 lazy 이미지 로드 — 전체 페이지 촬영 전에 끝까지 훑는다
            page.evaluate(
                "async () => { const step = innerHeight;"
                " for (let y = 0; y < document.body.scrollHeight; y += step) {"
                "   scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); }"
                " scrollTo(0, 0); }"
            )
            page.wait_for_timeout(900)
            page.screenshot(path=str(OUT / f"library-{w}.png"), full_page=True)
            if w == 390:
                stat = page.evaluate(
                    """() => ({
                        scrollWidth: document.documentElement.scrollWidth,
                        clientWidth: document.documentElement.clientWidth,
                        items: document.querySelectorAll('.shelf__item').length,
                        svgCovers: document.querySelectorAll('.shelf__cover .shelf-svg').length,
                        imgCovers: document.querySelectorAll('.shelf__cover .shelf-img').length,
                        shelves: document.querySelectorAll('.shelf').length
                    })"""
                )
                log.append(f"[서재-390] {json.dumps(stat, ensure_ascii=False)}")
                page.click('.pill-tabs button[data-ch="월간"]')
                page.wait_for_timeout(400)
                page.screenshot(path=str(OUT / "library-390-monthly.png"), full_page=True)
                log.append(
                    "[서재-390 월간탭] 권수="
                    + str(page.evaluate("() => document.querySelectorAll('.shelf__item').length"))
                )
            page.close()

        # 발행 데스크 미리보기 — 지면과 같은 care.issueHtml을 쓰는지 확인
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.goto(f"{base}/web/care/desk.html", wait_until="networkidle")
        page.wait_for_timeout(800)
        ok = page.evaluate(
            """async () => {
                const meta = (await (await fetch('/data/care/issues.json')).json())
                    .find(i => i.id === 'monthly-04');
                const body = await (await fetch('/data/care/issues/monthly-04.json')).json();
                const box = document.getElementById('preview-body');
                if (!box || !window.care || !window.care.issueHtml) return 'no-preview-target';
                box.innerHTML = window.care.issueHtml(meta, body, [meta], null);
                document.getElementById('preview-back').hidden = false;
                return 'ok:' + box.querySelectorAll('.poster').length + '포스터';
            }"""
        )
        page.wait_for_timeout(700)
        page.screenshot(path=str(OUT / "desk-preview-1280.png"))
        log.append(f"[데스크 미리보기] {ok}")
        page.close()
        browser.close()

    (OUT / "check.txt").write_text("\n".join(log), encoding="utf-8")
    print("\n".join(log))
    print("saved:", OUT)


if __name__ == "__main__":
    sys.exit(main())
