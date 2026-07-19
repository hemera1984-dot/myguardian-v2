"""검수 재현 스위트 — 고객관리 이관·삭제와 케어 발행 검증기를 자동 재검증한다.

사용법: python scripts/verify_review.py
사전 준비: pip install playwright jsonschema && python -m playwright install chromium

Codex 4·5차 검수의 재현 방법을 그대로 코드화했다:
- 모형 File System Access 핸들(OPFS)로 이관의 차단·검증·확정·취소·변조 경로 재현
- 발행 검증기는 임시 사본에서 유효·무효(자료형·패턴·경계값) 자료로 실행 (실데이터 무변형)
- cp949 기본 콘솔 조건(-X utf8 없이 서브프로세스) 재현
"""

import functools
import json
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
TMP = Path(tempfile.mkdtemp(prefix="mg-verify-"))

results = []


def check(name, ok, detail=""):
    results.append((name, ok))
    print(("통과" if ok else "실패"), "-", name, ("| " + str(detail)[:140] if detail else ""))


# ══ 1부. 발행 검증기 (임시 사본 — 실데이터 오염 없음) ══

def setup_pubtest():
    (TMP / "pipeline").mkdir(parents=True, exist_ok=True)
    (TMP / "data" / "care" / "issues").mkdir(parents=True, exist_ok=True)
    (TMP / "data" / "schema").mkdir(parents=True, exist_ok=True)
    shutil.copy(ROOT / "pipeline" / "publish_care_issue.py", TMP / "pipeline")
    shutil.copy(ROOT / "pipeline" / "collect_news.py", TMP / "pipeline")
    shutil.copy(ROOT / "data" / "schema" / "care-body.schema.json", TMP / "data" / "schema")


def write_issue(meta_extra, body):
    issues = [dict({
        "id": "weekly-90", "채널": "주간", "호수": 90, "제목": "테스트 호",
        "발행일": "2026-07-20", "본문파일": "data/care/issues/weekly-90.json", "상태": "초안",
    }, **meta_extra)]
    (TMP / "data" / "care" / "issues.json").write_text(json.dumps(issues, ensure_ascii=False), encoding="utf-8")
    (TMP / "data" / "care" / "issues" / "weekly-90.json").write_text(json.dumps(body, ensure_ascii=False), encoding="utf-8")


def run_publish(issue_id="weekly-90"):
    # -X utf8 없이 실행 — Windows 기본 콘솔(cp949) 조건 재현
    return subprocess.run([sys.executable, str(TMP / "pipeline" / "publish_care_issue.py"), "--id", issue_id],
                          capture_output=True, cwd=str(TMP))


def art(n, cat="시사", **over):
    base = {"번호": n, "카테고리": cat, "제목": f"기사 {n} 제목", "부제": f"부제 {n}", "요약": ["요약 한 줄"],
            "한마디": ["한마디"], "본문": [{"t": "h", "x": "소제목"}, {"t": "p", "x": "문단"}], "이미지": None}
    base.update(over)
    return base


def full_body(**over):
    body = {"id": "weekly-90", "편집장의말": ["편집장의 말"],
            "기사": [art(1), art(2, "경제"), art(3, "교양"), art(4, "보험")]}
    body.update(over)
    return body


def expect_reject(name, body, needle=""):
    write_issue({}, body)
    r = run_publish()
    out = r.stdout.decode("utf-8", "replace")
    crashed = b"Traceback" in r.stderr
    ok = r.returncode == 1 and not crashed and "발행 불가" in out and (needle in out if needle else True)
    check(name, ok, ("예외 발생" if crashed else out.splitlines()[0] if out else ""))


setup_pubtest()

# 유효 자료 → 발행 성공
write_issue({}, full_body())
r = run_publish()
after = json.loads((TMP / "data" / "care" / "issues.json").read_text(encoding="utf-8"))[0]
check("유효 본문 발행 성공 + 꼭지 동기화", r.returncode == 0 and after.get("상태") == "발행" and len(after.get("꼭지", [])) == 4)
check("cp949 콘솔 완료 문구 정상", b"Traceback" not in r.stderr and "발행 완료" in r.stdout.decode("utf-8", "replace"))

# 무효 자료 — Codex 5차 재현 케이스 전부 "발행 불가" 목록으로 끝나야 한다 (예외 금지)
expect_reject("번호 불리언 차단", full_body(기사=[art(1, 번호=True), art(2), art(3), art(4)]))
expect_reject("카테고리 누락 차단", full_body(기사=[{k: v for k, v in art(1).items() if k != "카테고리"}, art(2), art(3), art(4)]))
expect_reject("카테고리 숫자 차단", full_body(기사=[art(1, 카테고리=3), art(2), art(3), art(4)]))
expect_reject("한마디 0 차단", full_body(기사=[art(1, 한마디=0), art(2), art(3), art(4)]))
expect_reject("id 패턴 위반 차단", dict(full_body(), id="weekly-90x"))
expect_reject("기사 항목 문자열 차단", full_body(기사=["문자열", art(2), art(3), art(4)]))
expect_reject("번호 문자열 혼합 차단", full_body(기사=[art(1, 번호="1"), art(2), art(3), art(4)]))
expect_reject("본문 문자열 차단", full_body(기사=[art(1, 본문="문자열"), art(2), art(3), art(4)]))
expect_reject("편집장의말 문자열 차단", full_body(편집장의말="문자열"))
expect_reject("본문-메타 id 불일치 차단", dict(full_body(), id="weekly-91"))
expect_reject("주간 기사 3개 차단", full_body(기사=[art(1), art(2), art(3)]), "개여야")
expect_reject("기사 번호 중복 차단", full_body(기사=[art(1), art(1), art(3), art(4)]), "연속·유일")

# Codex 6차 재현 — 공백 콘텐츠·id 00·최상위 배열
expect_reject("공백만인 콘텐츠 차단", {"id": "weekly-90", "편집장의말": ["   "], "기사": [
    art(1, 카테고리="  ", 제목="  ", 부제=" ", 요약=["  "], 한마디=["  "], 본문=[{"t": "p", "x": "   "}]),
    art(2), art(3), art(4)]})
expect_reject("본문 id weekly-00 차단", dict(full_body(), id="weekly-00"))
expect_reject("최상위 배열 본문 차단", [full_body()])

# 실데이터의 빈 초안은 여전히 차단 (읽기만)
r = subprocess.run([sys.executable, str(ROOT / "pipeline" / "publish_care_issue.py"), "--id", "weekly-12"],
                   capture_output=True, cwd=str(ROOT))
check("실데이터 빈 초안 차단 유지", r.returncode == 1 and b"Traceback" not in r.stderr)

# 키 없음 안내가 NAVER API HUB를 가리킨다
r = subprocess.run([sys.executable, str(TMP / "pipeline" / "collect_news.py")], capture_output=True, cwd=str(TMP))
out = r.stdout.decode("utf-8", "replace")
check("키 안내가 NAVER API HUB", r.returncode == 1 and "console.ncloud.com" in out and "호환되지 않습니다" in out)

# ══ 2부. 화면 검증 (Playwright + OPFS 모형 FSA) ══

from playwright.sync_api import sync_playwright

handler = functools.partial(SimpleHTTPRequestHandler, directory=str(ROOT))
handler.log_message = lambda *a: None
server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()

INIT = """
window.__pick = [];
window.showDirectoryPicker = async function () { return window.__pick.shift(); };
window.__setup = async function () {
  const root = await navigator.storage.getDirectory();
  for (const n of ['src', 'dst', 'other']) { try { await root.removeEntry(n, {recursive:true}); } catch (e) {} }
  const src = await root.getDirectoryHandle('src', {create:true});
  const dst = await root.getDirectoryHandle('dst', {create:true});
  const other = await root.getDirectoryHandle('other', {create:true});
  const od = await other.getDirectoryHandle('stuff', {create:true});
  let w = await (await od.getFileHandle('x.txt', {create:true})).createWritable();
  await w.write('x'); await w.close();
  // 연결 저장소 안 8단계 깊이 폴더 — 깊은 자기 트리 우회 재현용
  let deep = src;
  for (let i = 0; i < 9; i++) deep = await deep.getDirectoryHandle('d' + i, {create:true});
  window.__deep = deep;
  for (const code of ['C-2026-001', 'C-2026-002', 'C-2026-003']) {
    const d = await src.getDirectoryHandle(code, {create:true});
    w = await (await d.getFileHandle('profile.json', {create:true})).createWritable();
    await w.write(JSON.stringify({'고객코드':code,'카테고리':'referral','customerName':'테스트'+code.slice(-1)}));
    await w.close();
    const sub = await d.getDirectoryHandle('docs', {create:true});
    w = await (await sub.getFileHandle('note.txt', {create:true})).createWritable();
    await w.write('하위 파일 내용'); await w.close();
  }
  window.__src = src; window.__dst = dst; window.__other = other;
};
"""

errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1180, "height": 950})
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errors.append("cust: " + str(e)))
    pg.add_init_script(INIT)
    pg.goto(f"http://127.0.0.1:{port}/web/customers/index.html", wait_until="networkidle")
    pg.evaluate("__setup()")
    pg.evaluate("window.__pick.push(window.__src)")
    pg.click("#btn-connect")
    pg.wait_for_selector(".case-row")

    def select(code):
        pg.click(f'.case-row[data-code="{code}"]')
        pg.wait_for_selector("#cust-move")

    # 자기 트리 차단: 고객 폴더 자체 + 8단계 깊은 하위 (5차 중요 2 재현)
    select("C-2026-001")
    pg.evaluate("(async () => { window.__pick.push(await window.__src.getDirectoryHandle('C-2026-001')); })()")
    pg.click("#cust-move")
    pg.wait_for_timeout(500)
    check("자기 폴더 이관 차단", "연결된 저장소 안" in pg.locator("#mgmt-msg").inner_text())
    pg.evaluate("window.__pick.push(window.__deep)")
    pg.click("#cust-move")
    pg.wait_for_timeout(700)
    check("8단계 깊은 자기 트리 차단", "연결된 저장소 안" in pg.locator("#mgmt-msg").inner_text())

    # 비저장소 대상 차단
    pg.evaluate("window.__pick.push(window.__other)")
    pg.click("#cust-move")
    pg.wait_for_timeout(500)
    check("비저장소 대상 차단", "고객 저장소로 보이지 않습니다" in pg.locator("#mgmt-msg").inner_text())

    # 이관 = 사본 생성·검증까지 — 원본은 어떤 경로로도 자동 삭제되지 않는다 (Codex 6차 치명 1 재설계)
    pg.evaluate("window.__pick.push(window.__dst)")
    pg.click("#cust-move")
    pg.wait_for_timeout(1500)
    move_msg = pg.locator("#mgmt-msg").inner_text()
    state = pg.evaluate("""(async () => {
      const out = {};
      try { await window.__src.getDirectoryHandle('C-2026-001'); out.srcKept = true; } catch (e) { out.srcKept = false; }
      try {
        const d = await window.__dst.getDirectoryHandle('C-2026-001');
        const f = await (await (await d.getDirectoryHandle('docs')).getFileHandle('note.txt')).getFile();
        out.content = await f.text();
      } catch (e) { out.content = null; }
      return out; })()""")
    check("이관 = 사본 생성·검증, 원본 보존", state["srcKept"] and state["content"] == "하위 파일 내용"
          and "사본 검증 완료" in move_msg and "원본은 보존" in move_msg, str(state))
    # 자동 삭제 요소가 화면에 없어야 한다
    check("자동 원본 삭제 UI 부재", pg.locator("#cust-move-yes").count() == 0)

    # 원본 정리는 별도의 삭제 절차로 — 2단계 확인 후 제거
    pg.click("#cust-del")
    pg.wait_for_selector("#cust-del-yes")
    pg.click("#cust-del-yes")
    pg.wait_for_timeout(600)
    src_gone = pg.evaluate("""(async () => {
      try { await window.__src.getDirectoryHandle('C-2026-001'); return false; } catch (e) { return true; } })()""")
    copy_kept = pg.evaluate("""(async () => {
      try { await window.__dst.getDirectoryHandle('C-2026-001'); return true; } catch (e) { return false; } })()""")
    check("별도 삭제 절차로 원본 정리 (사본 무관)", src_gone and copy_kept)

    # 프로필 사진 속성 주입 무력화 + 수치 즉시 표시 + 모바일 배경
    pg2 = ctx.new_page()
    pg2.on("pageerror", lambda e: errors.append("home: " + str(e)))
    pg2.add_init_script("""localStorage.setItem('mg_profile', JSON.stringify({
      '이름': '안창민', '직함': 'FC', '지점': '신한라이프 하랑지점', '연락처': '', '전문분야': '',
      '사진': 'bad" onerror="document.body.dataset.profileXss=\\'executed\\''
    }));""")
    pg2.goto(f"http://127.0.0.1:{port}/web/index.html", wait_until="networkidle")
    pg2.wait_for_timeout(400)
    check("사진 속성 주입 무력화", pg2.evaluate("document.body.dataset.profileXss || null") is None
          and "placeholder" in pg2.evaluate("document.getElementById('p-photo').className"))
    check("자료 수치 즉시 정확", pg2.locator("#stat-cases").inner_text() == "383")
    pg3 = ctx.new_page()
    pg3.set_viewport_size({"width": 390, "height": 844})
    pg3.goto(f"http://127.0.0.1:{port}/web/index.html", wait_until="networkidle")
    check("모바일 배경 scroll", "scroll" in pg3.evaluate("getComputedStyle(document.body).backgroundAttachment"))

    check("페이지 오류 없음", not errors, "; ".join(errors[:3]))
    b.close()
server.shutdown()
shutil.rmtree(TMP, ignore_errors=True)

fails = [n for n, ok in results if not ok]
print()
print(f"총 {len(results)}건 중 실패 {len(fails)}건" + (": " + ", ".join(fails) if fails else ""))
sys.exit(1 if fails else 0)
