"""브리핑 시스템 자동 검증.

같은 브라우저 컨텍스트에 발표자(present)·청중(view) 두 페이지를 열어 확인한다:
  1. 페이지 넘김이 청중 창에 반영되는가
  2. 포인터 좌표가 비율(0~1)로 전달·표시되는가
  3. 영상 play/pause/seek 동기화 (검증용 무음 클립을 MediaRecorder로 즉석 생성)
  4. 청중 창을 늦게 열어도 현재 페이지로 맞춰지는가
  5. 로컬 파일 동선(진입 → 파일 선택 → 발표 시작 → 청중 창 문서 전달)이 동작하는가
  6. 스크립트가 청중 화면 DOM에 절대 나타나지 않는가
  7. 전 페이지 콘솔 오류 0건
  8. 기형·위조 메시지(같은 origin 채널 위조)에 청중 창이 흔들리지 않는가
  9. 로컬 청중 창을 발표자보다 먼저 열어도 동기화되는가
  10. PDF 업로드(3페이지)가 페이지 동기화·스크립트 사이드카("---" 구간)와 함께 동작하는가
  11. HTML 업로드의 스크롤이 청중 창에 동기화되는가
  12. 스크립트를 PDF(페이지=구간)·HTML(hr 구분)로 올려도 페이지별로 연결되는가
  13. 라이브러리 탑재 자료가 재접속 후에도 목차에 남고, 모드가 분리되며, 목차에서 발표되는가
seek 검증은 발표자가 실제로 이동했는지(≥1.0s)를 전제로 단언한다 — 거짓 양성 방지.
업로드 픽스처(PDF·스크립트·HTML)는 실행 시 scripts/fixtures/brief/에 생성한다.
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


def make_pdf_fixture(path: Path, titles: list) -> None:
    """외부 도구 없이 최소 구조의 다페이지 PDF를 만든다 (Helvetica, ASCII 텍스트)."""
    n = len(titles)
    kids = " ".join(f"{4 + i * 2} 0 R" for i in range(n))
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {n} >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    for i, title in enumerate(titles):
        content_ref = 4 + i * 2 + 1
        objects.append(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content_ref} 0 R >>"
        )
        stream = f"BT /F1 36 Tf 72 700 Td ({title}) Tj ET"
        objects.append(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream")

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{obj}\nendobj\n".encode("latin-1")
    xref_pos = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF".encode()
    path.write_bytes(bytes(out))


def make_upload_fixtures() -> tuple:
    """PDF·스크립트·HTML 업로드 검증용 픽스처를 생성한다."""
    FIXTURES.mkdir(parents=True, exist_ok=True)
    pdf_path = FIXTURES / "slides.pdf"
    make_pdf_fixture(pdf_path, ["Page 1", "Page 2", "Page 3"])
    txt_path = FIXTURES / "script.txt"
    txt_path.write_text(
        "1구간: 첫 페이지 발표 멘트입니다.\n---\n2구간: 둘째 페이지 멘트.\n---\n3구간: 셋째 페이지 멘트.\n",
        encoding="utf-8",
    )
    html_path = FIXTURES / "doc.html"
    html_path.write_text(
        '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>스크롤 검증</title></head>'
        '<body style="margin:0"><h1>스크롤 검증 문서</h1>'
        '<div style="height:4000px;background:#f0f0f0"></div>'
        "<p>문서 끝</p></body></html>",
        encoding="utf-8",
    )
    script_pdf_path = FIXTURES / "script.pdf"
    make_pdf_fixture(script_pdf_path, ["Section 1 notes", "Section 2 notes", "Section 3 notes"])
    return pdf_path, txt_path, html_path, script_pdf_path


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
            pdf_path, txt_path, html_path, script_pdf_path = make_upload_fixtures()
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

            # 8. 기형·위조 메시지 내성 (Codex 검수 반영: 같은 origin 다른 탭의 채널 위조)
            err_before = len(errors)
            attacker = ctx.new_page()
            attacker.goto(f"{base}/web/brief/index.html", wait_until="networkidle")
            attacker.evaluate(
                "(ch) => { const c = new BroadcastChannel(ch);"
                " c.postMessage({ v: 1, type: 'page', page: {} });"
                " c.postMessage({ v: 1, type: 'page', page: 999 });"
                " c.postMessage({ v: 1, type: 'pointer', x: 5, y: -2, on: true });"
                " c.postMessage({ v: 1, type: 'doc', doc: { '제목': '위조 문서' } });"
                " c.postMessage({ v: 1, type: 'state', page: 'x' });"
                " c.close(); }",
                f"mg-brief-{PUBLIC_DOC}",
            )
            view.wait_for_timeout(500)
            attacker.close()
            pointer_pct = view.evaluate(
                "() => parseFloat(document.getElementById('pointer').style.left || '0')"
            )
            forged_title = "위조" in (view.title() or "")
            # page 999는 숫자라 유효 — 마지막 페이지로 클램프될 수 있으므로 예외 없음만 본다
            check(
                "기형·위조 메시지 내성",
                len(errors) == err_before and not forged_title and 0 <= pointer_pct <= 100,
                f"예외 0건, 위조 doc 무시, 포인터 {pointer_pct:.0f}% (범위 밖 폐기)",
            )
            present.close()
            view.close()

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
            # MediaRecorder webm은 길이 메타데이터가 없고 python http.server는 Range를
            # 지원하지 않아 탐색이 조용히 무시된다 — 두 창의 클립을 blob으로 다시 실어
            # 매체를 탐색 가능하게 만든 뒤, 발표자의 실제 이동을 전제로 동기화를 단언한다
            # (Codex 검수 반영: 두 창 모두 0초여도 통과하던 거짓 양성 제거)
            for pg in (vp, vv):
                pg.evaluate(
                    """async () => {
                      const v = document.querySelector('#stage video');
                      const blob = await (await fetch(v.src)).blob();
                      v.src = URL.createObjectURL(blob);
                      await new Promise((r) => { v.onloadeddata = r; });
                    }"""
                )
            vp.evaluate(
                """async () => {
                  const v = document.querySelector('#stage video');
                  const seekTo = (t) => new Promise((r) => { v.onseeked = r; v.currentTime = t; });
                  await seekTo(1e5);
                  await seekTo(0);
                }"""
            )
            vp.evaluate("() => { document.querySelector('#stage video').currentTime = 1.2; }")
            vp.wait_for_timeout(600)
            t_present = vp.evaluate("() => document.querySelector('#stage video').currentTime")
            t_view = vv.evaluate("() => document.querySelector('#stage video').currentTime")
            check(
                "영상 seek 동기화",
                t_present >= 1.0 and abs(t_present - t_view) < 0.6,
                f"발표자 {t_present:.2f}s / 청중 {t_view:.2f}s (전제: 발표자 실제 이동 ≥1.0s)",
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
                "로컬 자료 청중 창 표시(IndexedDB 직접 읽기)",
                popup.locator(".pg-cover-title").inner_text() != "",
            )
            popup.close()
            entry.close()

            # 9. 로컬 청중 창 선개설 → 발표자 시작 시 자료 수신 (Codex 검수 반영: hello 유실 영구 대기 해소)
            early = ctx.new_page()
            watch_console(early, errors, "early-view")
            early.goto(f"{base}/web/brief/view.html?local=1&ch={PUBLIC_DOC}", wait_until="networkidle")
            early.wait_for_timeout(300)
            lp = ctx.new_page()
            watch_console(lp, errors, "present-local")
            lp.goto(f"{base}/web/brief/index.html", wait_until="networkidle")
            lp.locator(".mode-grid .action-card[data-mode='상담']").click()
            lp.set_input_files("#file-input", str(ROOT / "data" / "brief" / f"{PUBLIC_DOC}.json"))
            lp.wait_for_selector("#local-start")
            lp.locator("#local-start").click()
            lp.wait_for_selector("#count")
            early.wait_for_selector(".pg-cover-title", timeout=6000)
            check("청중 창 선개설 → 발표자 시작 시 자료 수신", True, "IndexedDB 재시도 + hello 재송신")
            early.close()
            lp.close()

            # 10. PDF 업로드 + 스크립트 사이드카 + 페이지 동기화
            pe = ctx.new_page()
            watch_console(pe, errors, "present-pdf")
            pe.goto(f"{base}/web/brief/index.html", wait_until="networkidle")
            pe.locator(".mode-grid .action-card[data-mode='강의']").click()
            pe.set_input_files("#file-input", str(pdf_path))
            pe.set_input_files("#script-input", str(txt_path))
            pe.wait_for_selector("#local-start")
            pe.locator("#local-start").click()
            pe.wait_for_selector("#count")
            pe.wait_for_function("() => document.getElementById('count').textContent.includes('/ 3')", timeout=6000)
            script1 = "1구간" in pe.locator("#script-body").inner_text()
            with ctx.expect_page() as pv_info:
                pe.locator("#open-view").click()
            pv = pv_info.value
            watch_console(pv, errors, "view-pdf")
            pv.wait_for_selector("#stage canvas", timeout=8000)
            pe.keyboard.press("ArrowRight")
            pv.wait_for_function("() => document.getElementById('stage').dataset.page === '2'", timeout=4000)
            script2 = "2구간" in pe.locator("#script-body").inner_text()
            check(
                "PDF 업로드 3페이지 + 페이지 동기화 + 스크립트 사이드카",
                script1 and script2,
                "1/3 표시, 구간 1→2 전환, 청중 캔버스 렌더",
            )
            pv.close()
            pe.close()

            # 11. HTML 업로드 + 스크롤 동기화
            he = ctx.new_page()
            watch_console(he, errors, "present-html")
            he.goto(f"{base}/web/brief/index.html", wait_until="networkidle")
            he.locator(".mode-grid .action-card[data-mode='강의']").click()
            he.set_input_files("#file-input", str(html_path))
            he.wait_for_selector("#local-start")
            he.locator("#local-start").click()
            he.wait_for_selector("#stage iframe")
            with ctx.expect_page() as hv_info:
                he.locator("#open-view").click()
            hv = hv_info.value
            watch_console(hv, errors, "view-html")
            hv.wait_for_selector("#stage iframe", timeout=6000)
            hv.wait_for_timeout(400)
            he.evaluate("() => { const f = document.querySelector('#stage iframe'); f.contentWindow.scrollTo(0, 999999); }")
            hv.wait_for_function(
                "() => { const f = document.querySelector('#stage iframe');"
                " if (!f || !f.contentWindow) return false;"
                " const el = f.contentWindow.document.scrollingElement;"
                " return !!el && el.scrollTop > 500; }",
                timeout=4000,
            )
            check("HTML 업로드 + 스크롤 동기화", True, "발표자 스크롤 → 청중 창 반영")
            hv.close()
            he.close()

            # 12. PDF·HTML 스크립트 사이드카 (스크립트를 PDF로 올리면 페이지=구간, HTML은 hr 구분)
            se = ctx.new_page()
            watch_console(se, errors, "present-script-pdf")
            se.goto(f"{base}/web/brief/index.html", wait_until="networkidle")
            html_parse_ok = se.evaluate(
                "() => { const s = window.mgBrief.parseScriptHtml("
                "'<p>구간 하나</p><hr><p>구간 둘</p><hr><p>구간 셋</p>');"
                " return s.length === 3 && s[1].includes('구간 둘'); }"
            )
            se.locator(".mode-grid .action-card[data-mode='강의']").click()
            se.set_input_files("#file-input", str(pdf_path))
            se.set_input_files("#script-input", str(script_pdf_path))
            se.wait_for_function(
                "() => !document.getElementById('local-script-meta').textContent.includes('없음')",
                timeout=6000,
            )
            se.locator("#local-start").click()
            se.wait_for_selector("#count")
            sec1 = "Section 1" in se.locator("#script-body").inner_text()
            se.keyboard.press("ArrowRight")
            se.wait_for_function(
                "() => document.getElementById('script-body').textContent.includes('Section 2')",
                timeout=4000,
            )
            check(
                "PDF·HTML 스크립트 사이드카",
                html_parse_ok and sec1,
                "PDF 스크립트 페이지=구간 전환, HTML hr 구분 3구간 파싱",
            )
            se.close()

            # 13. 라이브러리 탑재 → 목차 지속 → 목차에서 발표
            le = ctx.new_page()
            watch_console(le, errors, "library")
            le.goto(f"{base}/web/brief/index.html", wait_until="networkidle")
            le.locator(".mode-grid .action-card[data-mode='교육']").click()
            le.wait_for_selector("#library-section:not([hidden])")
            le.set_input_files("#file-input", str(pdf_path))
            le.set_input_files("#script-input", str(txt_path))
            le.wait_for_selector("#local-summary:not([hidden])")
            le.locator("#local-save").click()
            le.wait_for_selector(".lib-item")
            # 재접속 지속 + 모드 분리(강의엔 안 보임)
            le.reload(wait_until="networkidle")
            le.locator(".mode-grid .action-card[data-mode='교육']").click()
            le.wait_for_selector(".lib-item")
            persisted = le.locator(".lib-item").count() == 1
            le.locator(".mode-grid .action-card[data-mode='강의']").click()
            le.wait_for_selector("#library-section:not([hidden])")
            le.wait_for_timeout(200)
            mode_split = le.locator(".lib-item").count() == 0
            le.locator(".mode-grid .action-card[data-mode='교육']").click()
            le.wait_for_selector(".lib-main")
            le.locator(".lib-main").first.click()
            le.wait_for_url("**/present.html?local=1", timeout=6000)
            le.wait_for_selector("#count", timeout=8000)
            check(
                "라이브러리 탑재·목차 지속·목차 발표",
                persisted and mode_split,
                "재접속 지속 + 교육/강의 모드 분리 + 목차 클릭→발표 이동",
            )
            le.close()

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
