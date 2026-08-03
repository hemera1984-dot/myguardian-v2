"""발행 전 사실검증 화면 검증 렌더.

사용법: python scripts/shot_verify.py
결과: .omd/.cache/verify/ 에 검증 진행 중 화면과 결과 보고 화면 스크린샷 저장.

실제 검증 응답(scripts/fixtures/verify-sample.json)을 localStorage에 심어
데스크 발행 구획을 그대로 그린다. 서버 호출은 하지 않는다.

fixtures/ 는 저장소에 올리지 않으므로(gitignore) 파일이 없으면
POST /ai/verify 응답을 그대로 그 경로에 저장한 뒤 실행한다.
"""

import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".omd" / ".cache" / "verify"
SAMPLE = ROOT / "scripts" / "fixtures" / "verify-sample.json"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main() -> None:
    if not SAMPLE.exists():
        raise SystemExit(f"검증 응답 파일이 없습니다: {SAMPLE}\n"
                         "POST /ai/verify 응답을 그대로 이 경로에 저장한 뒤 다시 실행하세요.")
    OUT.mkdir(parents=True, exist_ok=True)
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", 8127), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:8127"

    sample = json.loads(SAMPLE.read_text(encoding="utf-8"))
    body = json.loads((ROOT / "data/care/issues/monthly-04.json").read_text(encoding="utf-8"))
    art = body["기사"][0]
    draft = {
        "id": "monthly-04", "채널": "월간", "호수": "4", "발행일": "2026-07-02",
        "주차라벨": "", "발행인": "안창민", "커버이미지": "",
        "편집장의말": body.get("편집장의말", []),
        "기사": [{
            "번호": 1, "카테고리": art.get("카테고리", ""), "제목": art.get("제목", ""),
            "부제": art.get("부제", ""), "요약": art.get("요약", []),
            "한마디": art.get("한마디", []), "본문": art.get("본문", []),
            "이미지": "", "방향": "",
        }],
    }
    report = {
        "id": "monthly-04",
        "시각": "2026. 8. 3. 오후 2:41:07",
        "검증": sample["검증"],
        "요약": sample["요약"],
        "출처": sample.get("출처", [])[:6],
        "오류": "",
        "이전본문": [art.get("본문", [])],
    }

    seed = (
        "localStorage.setItem('mg_care_draft_monthly-04', %s);"
        "localStorage.setItem('mg_care_verify_monthly-04', %s);"
        % (json.dumps(json.dumps(draft, ensure_ascii=False)),
           json.dumps(json.dumps(report, ensure_ascii=False)))
    )

    with sync_playwright() as p:
        browser = p.chromium.launch()
        for label, width in (("1920", 1920), ("1180", 1180), ("390", 390)):
            page = browser.new_page(viewport={"width": width, "height": 1000})
            page.goto(f"{base}/web/care/desk.html", wait_until="domcontentloaded")
            page.evaluate(seed)
            page.goto(f"{base}/web/care/desk.html", wait_until="networkidle")
            page.wait_for_selector("#view-list", timeout=15000)
            page.click("#ch-tabs button[data-ch='월간']")
            page.click("button[data-edit='monthly-04']")
            page.wait_for_selector("#verify-report:not([hidden])", timeout=15000)

            # 1) 검증 진행 중 화면
            page.evaluate(
                "document.getElementById('verify-report').hidden = true;"
                "var b = document.getElementById('btn-publish');"
                "b.disabled = true; b.textContent = '사실 확인 중…';"
                "var p = document.getElementById('publish-msg');"
                "p.hidden = false; p.classList.remove('bad');"
                "p.textContent = '사실을 확인하고 있습니다… 40초 경과. 웹 검색 결과를 기다리는 중입니다.';"
            )
            page.wait_for_timeout(250)
            page.locator(".section:has(#btn-publish)").scroll_into_view_if_needed()
            page.wait_for_timeout(200)
            page.locator(".section:has(#btn-publish)").screenshot(
                path=str(OUT / f"progress-{label}.png"))

            # 2) 결과 보고 화면
            page.evaluate(
                "document.getElementById('verify-report').hidden = false;"
                "var b = document.getElementById('btn-publish');"
                "b.disabled = false; b.textContent = '발행하기';"
                "var p = document.getElementById('publish-msg');"
                "p.hidden = false; p.innerHTML = '발행되었습니다. "
                "<a href=\"issue.html?id=monthly-04\" target=\"_blank\" rel=\"noopener\">지면 열기</a>';"
            )
            page.wait_for_timeout(250)
            page.locator(".section:has(#btn-publish)").screenshot(
                path=str(OUT / f"report-{label}.png"))

            # 3) 경고(유지) 구획 레이아웃 확인용 — 실데이터에 유지 항목이 없어
            #    저장된 보고의 조치를 화면에서만 바꿔 다시 그린다. 발행물에는 쓰지 않는다.
            page.evaluate(
                "var k='mg_care_verify_monthly-04';"
                "var r=JSON.parse(localStorage.getItem(k));"
                "r['검증'][0]['조치']='유지'; r['검증'][3]['조치']='유지';"
                "r['검증'][3]['확신도']='낮음';"
                "localStorage.setItem(k, JSON.stringify(r));"
            )
            page.reload(wait_until="networkidle")
            page.click("#ch-tabs button[data-ch='월간']")
            page.click("button[data-edit='monthly-04']")
            page.wait_for_selector(".v-list.warn", timeout=15000)
            page.locator(".section:has(#btn-publish)").screenshot(
                path=str(OUT / f"report-warn-{label}.png"))
            page.close()
        browser.close()

    server.shutdown()
    print("saved:", OUT)
    for f in sorted(OUT.glob("*.png")):
        print(" -", f.name, f.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
