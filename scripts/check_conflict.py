# 두 기기 동시 저장 검사 — 같은 고객을 두 창(폰·PC 역할)에서 열어 두고 차례로 기록을 남긴다.
# 늦게 저장한 쪽이 먼저 쓴 기록을 지우지 않아야 한다(서버 409 → 최신본 위에 다시 저장).
# 홈 「오늘」의 기록 단추는 409면 최신본으로 바꾸고 다시 누르게 한다.
# 준비: node scripts/dev-server.mjs  +  정적 서버 8081(web)   실행: python scripts/check_conflict.py
import json, os, tempfile, urllib.request
from playwright.sync_api import sync_playwright

tok = json.load(open(os.path.join(tempfile.gettempdir(), "mg-dev", "tokens.json")))["boss"]
API, WEB, CODE = "http://localhost:8787", "http://localhost:8081", "C-2026-001"

def server_records():
    req = urllib.request.Request(API + "/clients", headers={"Authorization": "Bearer " + tok})
    rows = json.load(urllib.request.urlopen(req))["고객"]
    return [r["내용"] for r in next(x for x in rows if x["고객코드"] == CODE)["profile"].get("기록", [])]

def open_customer(b):
    ctx = b.new_context(viewport={"width": 1280, "height": 900})
    ctx.add_init_script("localStorage.setItem('mg_session', %s)" % json.dumps(tok))
    pg = ctx.new_page()
    pg.goto(f"{WEB}/customers/?code={CODE}")
    pg.wait_for_selector("#rec-note", timeout=15000)
    return pg

def write(pg, text):
    pg.fill("#rec-note", text)
    pg.click("#rec-save")
    pg.wait_for_timeout(1500)

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome")
    before = server_records()
    phone, pc = open_customer(b), open_customer(b)         # 둘 다 같은 판을 들고 있다
    write(phone, "폰에서 남긴 기록")
    write(pc, "PC에서 남긴 기록")                           # 낡은 판으로 저장 → 409 → 최신본 위에 다시
    after = server_records()
    assert "폰에서 남긴 기록" in after and "PC에서 남긴 기록" in after, after
    assert len(after) == len(before) + 2, (before, after)
    note = pc.inner_text("#rec-msg")
    assert "다른 기기" in note, note
    print("고객관리 통과 —", note)

    # 홈: 화면을 연 뒤 다른 기기가 고치면, 기록 단추는 덮지 않고 최신본으로 바꾼다
    home = b.new_context(viewport={"width": 1280, "height": 900})
    home.add_init_script("localStorage.setItem('mg_session', %s)" % json.dumps(tok))
    hp = home.new_page(); hp.goto(WEB + "/"); hp.wait_for_timeout(2500)
    code2 = hp.locator('#h-call [data-code]').first.get_attribute("data-code")   # 연락 줄 첫 고객
    rows = json.load(urllib.request.urlopen(urllib.request.Request(API + "/clients", headers={"Authorization": "Bearer " + tok})))["고객"]
    rec = next(x for x in rows if x["고객코드"] == code2)
    rec["profile"].setdefault("기록", []).insert(0, {"일자": "2026-10-10", "방법": "전화", "내용": "다른 기기에서 먼저"})
    rec["기준시각"] = rec.pop("갱신시각")
    urllib.request.urlopen(urllib.request.Request(API + "/clients", data=json.dumps([rec]).encode(), method="PUT",
        headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"}))
    hp.locator(f'#h-call [data-code="{code2}"] [data-act="note"]').first.click()
    hp.fill("#hd-note", "홈에서 남김")
    hp.locator(".h-drawer button", has_text="저장").click(); hp.wait_for_timeout(1500)
    msg = hp.inner_text("#h-toast-msg")
    assert "다른 기기" in msg, msg
    rows = json.load(urllib.request.urlopen(urllib.request.Request(API + "/clients", headers={"Authorization": "Bearer " + tok})))["고객"]
    kept = [r["내용"] for r in next(x for x in rows if x["고객코드"] == code2)["profile"].get("기록", [])]
    assert "다른 기기에서 먼저" in kept and "홈에서 남김" not in kept, kept
    print("홈 통과 —", msg)
    b.close()
