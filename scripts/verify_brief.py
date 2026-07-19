"""브리핑 시스템 자동 검증.

같은 브라우저 컨텍스트에 발표자(present)·청중(view) 두 페이지를 열어 확인한다:
  1. 페이지 넘김이 청중 창에 반영되는가
  2. 포인터 좌표가 비율(0~1)로 전달·표시되는가
  3. 영상 play/pause/seek 동기화 (검증용 무음 클립을 MediaRecorder로 즉석 생성)
  4. 청중 창을 늦게 열어도 현재 페이지로 맞춰지는가
  5. 로컬 파일 동선(진입 → 파일 선택 → 발표 시작 → 청중 창 문서 전달)이 동작하는가
  6. 스크립트가 청중 화면 DOM에 절대 나타나지 않는가
  7. 전 페이지 콘솔 오류 0건
추가로 3해상도(1920/1180/390) 스크린샷을 scripts/shots/에 저장한다.

사용법: python scripts/verify_brief.py
사전 준비: pip install playwright && python -m playwright install chromium
"""

import base64
import functools
import json
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "scripts" / "shots"
FIXTURES = ROOT / "scripts" / "fixtures" / "brief"

PUBLIC_DOC = "lecture-2026-001"

VIEWPORTS = [
    ("desktop-1920", 1920, 1080),
    ("tablet-1180", 1180, 820),
    ("mobile-390", 390, 844),
]

RESULTS = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    print(("통과  " if ok else "실패  ") + name + (f" — {detail}" if detail else ""))


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def make_video_fixture(browser, base: str) -> None:
    """검증용 무음 색상 클립(webm)과 영상 페이지 문서를 즉석 생성한다."""
    FIXTURES.mkdir(parents=True, exist_ok=True)
    page = browser.new_page()
    page.goto(base + "/web/brief/view.html")  # 아무 페이지든 무방 (실행 컨텍스트용)
    b64 = page.evaluate(
        """async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 320; canvas.height = 180;
          const ctx = canvas.getContext('2d');
          let hue = 0;
          const iv = setInterval(() => {
            ctx.fillStyle = 'hsl(' + (hue += 9) + ', 55%, 52%)';
            ctx.fillRect(0, 0, 320, 180);
          }, 40);
          const rec = new MediaRecorder(canvas.captureStream(25), { mimeType: 'video/webm' });
          const chunks = [];
          rec.ondataavailable = (e) => chunks.push(e.data);
          const done = new Promise((r) => { rec.onstop = r; });
          rec.start();
          await new Promise((r) => setTimeout(r, 2000));
          rec.stop();
          await done;
          clearInterval(iv);
          const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
          let s = '';
          for (let i = 0; i < buf.length; i += 8192) {
            s += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
          }
          return btoa(s);
        }"""
    )
    page.close()
    (FIXTURES / "clip.webm").write_bytes(base64.b64decode(b64))
    doc = {
        "id": "verify-video",
        "제목": "영상 동기화 검증",
        "모드": "교육",
        "작성일": "2026-07-19",
        "작성자": "검증 스크립트",
        "페이지": [
            {
                "번호": 1,
                "유형": "영상",
                "제목": "영상 동기화 검증",
                "영상": "scripts/fixtures/brief/clip.webm",
                "캡션": "검증용 무음 색상 클립",
                "스크립트": "검증 전용 스크립트 문장",
            }
        ],
    }
    (FIXTURES / "video-test.json").write_text(
        json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8"
    )


def watch_console(page, errors: list, label: str) -> None:
    page.on("console", lambda m: errors.append(f"[{label}] {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"[{label}] {e}"))


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")  # Windows 콘솔 cp949 대응
    SHOTS.mkdir(parents=True, exist_ok=True)
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    base = f"http://127.0.0.1:{server.server_address[1]}"
    threading.Thread(target=server.serve_forever, daemon=True).start()
    errors: list = []

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
            make_video_fixture(browser, base)
            ctx = browser.new_context(viewport={"width": 1600, "height": 1000})

            # --- 검증 1·2·4·6: 공개 문서로 발표자·청중 동기화 ---
            present = ctx.new_page()
            watch_console(present, errors, "present")
            present.goto(f"{base}/web/brief/present.html?doc={PUBLIC_DOC}", wait_until="networkidle")
            present.wait_for_selector("#count")

            view = ctx.new_page()
            watch_console(view, errors, "view")
            view.goto(f"{base}/web/brief/view.html?doc={PUBLIC_DOC}", wait_until="networkidle")
            view.wait_for_selector(".pg-cover-title")

            # 1. 페이지 넘김 동기화
            present.keyboard.press("ArrowRight")
            view.wait_for_selector(".pg-title")
            check(
                "페이지 넘김 → 청중 창 반영",
                view.locator(".pg-title").inner_text() == "차례",
                "2페이지(차례) 표시",
            )

            # 2. 포인터 비율 좌표 전달
            box = present.evaluate(
                "() => { const r = document.getElementById('stage').getBoundingClientRect();"
                " return { l: r.left, t: r.top, w: r.width, h: r.height }; }"
            )
            present.mouse.move(box["l"] + box["w"] * 0.4, box["t"] + box["h"] * 0.6)
            view.wait_for_selector(".pointer-dot.on", timeout=3000)
            px = float(view.evaluate("() => parseFloat(document.getElementById('pointer').style.left)"))
            py = float(view.evaluate("() => parseFloat(document.getElementById('pointer').style.top)"))
            check(
                "포인터 비율 좌표 전달·표시",
                abs(px - 40.0) < 1.5 and abs(py - 60.0) < 1.5,
                f"수신 좌표 {px:.1f}% / {py:.1f}% (기대 40/60)",
            )

            # 6. 스크립트 비노출 (2페이지엔 없으므로 스크립트 있는 8페이지로 확인)
            present.evaluate("() => {}")
            for _ in range(6):
                present.keyboard.press("ArrowRight")
            view.wait_for_function(
                "() => document.querySelector('.pg-title') && document.querySelector('.pg-title').textContent.includes('반토막')"
            )
            script_text = present.locator("#script-body").inner_text()[:24]
            check(
                "스크립트 청중 화면 비노출",
                script_text not in view.content(),
                "발표자 스크립트 문자열이 청중 DOM에 없음",
            )

            # 4. 늦게 연 청중 창 상태 동기화 (현재 8페이지)
            late = ctx.new_page()
            watch_console(late, errors, "late-view")
            late.goto(f"{base}/web/brief/view.html?doc={PUBLIC_DOC}", wait_until="networkidle")
            late.wait_for_function(
                "() => document.querySelector('.pg-title') && document.querySelector('.pg-title').textContent.includes('반토막')",
                timeout=3000,
            )
            check("늦게 연 청중 창 → 현재 페이지 동기화", True, "8페이지로 즉시 맞춤")
            late.close()

            # --- 검증 3: 영상 동기화 (검증용 문서) ---
            vp = ctx.new_page()
            watch_console(vp, errors, "present-video")
            vp.goto(f"{base}/web/brief/present.html?src=scripts/fixtures/brief/video-test.json", wait_until="networkidle")
            vp.wait_for_selector("#stage video")
            vv = ctx.new_page()
            watch_console(vv, errors, "view-video")
            vv.goto(f"{base}/web/brief/view.html?src=scripts/fixtures/brief/video-test.json", wait_until="networkidle")
            vv.wait_for_selector("#stage video")

            vp.evaluate("() => document.querySelector('#stage video').play()")
            vv.wait_for_function("() => !document.querySelector('#stage video').paused", timeout=3000)
            check("영상 play 동기화", True)
            vp.evaluate("() => document.querySelector('#stage video').pause()")
            vv.wait_for_function("() => document.querySelector('#stage video').paused", timeout=3000)
            check("영상 pause 동기화", True)
            vp.evaluate("() => { document.querySelector('#stage video').currentTime = 1.2; }")
            vp.wait_for_timeout(400)
            t_present = vp.evaluate("() => document.querySelector('#stage video').currentTime")
            t_view = vv.evaluate("() => document.querySelector('#stage video').currentTime")
            check(
                "영상 seek 동기화",
                abs(t_present - t_view) < 0.6,
                f"발표자 {t_present:.2f}s / 청중 {t_view:.2f}s",
            )
            vp.close()
            vv.close()

            # --- 검증 5: 로컬 파일 동선 (진입 → 발표 → 청중 창 문서 전달) ---
            entry = ctx.new_page()
            watch_console(entry, errors, "entry")
            entry.goto(f"{base}/web/brief/index.html", wait_until="networkidle")
            entry.locator(".mode-grid .action-card[data-mode='상담']").click()
            entry.set_input_files("#file-input", str(ROOT / "data" / "brief" / f"{PUBLIC_DOC}.json"))
            entry.wait_for_selector("#local-start")
            entry.locator("#local-start").click()
            entry.wait_for_selector("#count")
            check("로컬 파일 열기 → 발표 시작", "22" in entry.locator("#count").inner_text())
            with ctx.expect_page() as popup_info:
                entry.locator("#open-view").click()
            popup = popup_info.value
            watch_console(popup, errors, "local-view")
            popup.wait_for_selector(".pg-cover-title", timeout=3000)
            check(
                "로컬 문서 청중 창 전달(hello→doc→state)",
                popup.locator(".pg-cover-title").inner_text() != "",
            )
            popup.close()
            entry.close()
            present.close()
            view.close()

            # --- 검증 7: 콘솔 오류 ---
            check("콘솔 오류 0건", not errors, "; ".join(errors[:4]))

            # --- 3해상도 스크린샷 ---
            targets = [
                ("brief-index", "web/brief/index.html"),
                ("brief-present", f"web/brief/present.html?doc={PUBLIC_DOC}"),
                ("brief-view", f"web/brief/view.html?doc={PUBLIC_DOC}"),
            ]
            for slug, path in targets:
                for name, w, h in VIEWPORTS:
                    shot = browser.new_page(viewport={"width": w, "height": h})
                    shot.goto(f"{base}/{path}", wait_until="networkidle")
                    shot.wait_for_timeout(400)
                    out = SHOTS / f"{slug}-{name}.png"
                    shot.screenshot(path=str(out), full_page=(slug == "brief-index"))
                    print(f"저장: {out}")
                    shot.close()

            browser.close()
    finally:
        server.shutdown()

    failed = [r for r in RESULTS if not r[1]]
    print(f"\n결과: {len(RESULTS) - len(failed)}/{len(RESULTS)} 통과")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
