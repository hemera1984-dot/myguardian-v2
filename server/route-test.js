// 경로 시험 — test.js는 DB 함수만 본다. 여기서는 빈 DB에 계정 넷을 심고 서버를 띄워 실제 요청으로 권한·입력 검사를 두드린다.
// 2026-09-27 전체 검증에서 고친 것들(CORS PUT·깨진 주소·잠금·발행 소유·직급·크기 초과)을 지킨다.
// 실행: server 폴더에서 node route-test.js
import assert from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { pathToFileURL, fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const HERE = join(tmpdir(), "mg-route-test").split(String.fromCharCode(92)).join("/");
rmSync(HERE, { recursive: true, force: true });
mkdirSync(HERE, { recursive: true });
Object.assign(process.env, {
  PORT: "8797", DB_FILE: HERE + "/t.db", GOOGLE_CLIENT_ID: "t.apps.googleusercontent.com",
  ALLOWED_ORIGINS: "https://app.insurguard.life", BOOTSTRAP_ADMINS: "boss@x.com",
  MEDIA_DIR: HERE + "/media", CARE_DIR: HERE + "/care", BRIEF_DIR: HERE + "/brief",
  MEDIA_BASE: "https://api.insurguard.life/media", BRANCH_API: "http://127.0.0.1:9", MG_DATA_KEY: "a".repeat(64)
});
const ROOT = dirname(fileURLToPath(import.meta.url)).split(String.fromCharCode(92)).join("/") + "/";
const d = await import(pathToFileURL(ROOT + "db.js").href);
const db = d.openDb(process.env.DB_FILE);
d.seedGrades(db, [{ code: "BM", name: "지점장", rank: 1 }, { code: "SSL", name: "팀장", rank: 3 }, { code: "FC", name: "팀원", rank: 5 }]);
const boss = d.upsertAccount(db, { sub: "g0", email: "boss@x.com", name: "안창민" }, ["boss@x.com"]);
const lead = d.upsertAccount(db, { sub: "g1", email: "lead@x.com", name: "팀장" }, []);
const fc = d.upsertAccount(db, { sub: "g2", email: "fc@x.com", name: "팀원" }, []);
const fc2 = d.upsertAccount(db, { sub: "g3", email: "fc2@x.com", name: "남팀원" }, []);
d.approve(db, { targetId: lead.id, grade: "SSL", parentId: boss.id, approverId: boss.id });
d.approve(db, { targetId: fc.id, grade: "FC", parentId: lead.id, approverId: boss.id });
d.approve(db, { targetId: fc2.id, grade: "FC", parentId: boss.id, approverId: boss.id });
d.setApprover(db, lead.id, true);
const T = { boss: d.createSession(db, boss.id).token, lead: d.createSession(db, lead.id).token,
  fc: d.createSession(db, fc.id).token, fc2: d.createSession(db, fc2.id).token };
db.close();
await import(pathToFileURL(ROOT + "server.js").href);
await new Promise((r) => setTimeout(r, 300));

const B = "http://127.0.0.1:8797";
const call = (who, method, path, body, extra = {}) => fetch(B + path, {
  method, headers: { Authorization: "Bearer " + T[who], "Content-Type": "application/json", ...extra },
  body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body))
});
let n = 0;
async function check(name, fn) { await fn(); n++; console.log("통과 ", name); }

await check("CORS 사전 요청에 PUT이 있다", async () => {
  const r = await fetch(B + "/clients", { method: "OPTIONS", headers: { Origin: "https://app.insurguard.life", "Access-Control-Request-Method": "PUT" } });
  assert.match(r.headers.get("access-control-allow-methods"), /PUT/);
});
await check("깨진 주소 한 줄에 서버가 죽지 않는다", async () => {
  const raw = await new Promise((ok) => {
    const s = connect(8797, "127.0.0.1", () => s.write("GET //[ HTTP/1.1\r\nHost: x\r\n\r\n"));
    let buf = ""; s.on("data", (c) => { buf += c; s.end(); }); s.on("close", () => ok(buf)); s.on("error", () => ok(buf));
  });
  assert.match(raw, /400/);
  assert.equal((await call("fc", "GET", "/me")).status, 200, "그 뒤에도 살아 있다");
});
await check("본문이 null이어도 500이 아니다", async () => {
  const r = await call("boss", "PUT", "/admin/viewpw", "null");
  assert.equal(r.status, 400);
});
await check("신규 고객 — 같은 코드면 409와 겹친 코드", async () => {
  assert.equal((await call("fc", "PUT", "/clients", { "신규": true, "레코드": [{ "고객코드": "C-2026-001", profile: {} }] })).status, 200);
  const r = await call("fc", "PUT", "/clients", { "신규": true, "레코드": [{ "고객코드": "C-2026-001", profile: {} }] });
  assert.equal(r.status, 409);
  assert.deepEqual((await r.json())["겹침"], ["C-2026-001"]);
  assert.equal((await call("fc", "PUT", "/clients", [{ "고객코드": "C-2026-001", profile: {} }])).status, 200, "고치기는 그대로 덮는다");
});
await check("열람 비밀번호 — 쉬어 가며 틀려도 다섯 번째부터 잠긴다", async () => {
  assert.equal((await call("boss", "PUT", "/admin/viewpw", { "비밀번호": "진짜비번12345" })).status, 200);
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await call("boss", "PUT", "/admin/viewpw", { "비밀번호": "새것12345678", "지금것": "틀림" + i })).status);
  assert.deepEqual(codes.slice(0, 4), [403, 403, 403, 403]);
  assert.ok(codes.slice(5).every((c) => c === 429), codes.join(","));
});
await check("정지는 승인권자만 — 승인권 없는 상위자는 403", async () => {
  // fc2는 승인권이 없다. 자기 하위가 없으니 권한 검사가 먼저 걸려야 한다.
  assert.equal((await call("fc2", "POST", "/admin/suspend", { "대상": fc.id })).status, 403);
});
await check("이름 고치기 — 팀장은 총관리자·남의 트리를 못 고친다", async () => {
  assert.equal((await call("lead", "POST", "/admin/set-name", { "대상": boss.id, "이름": "아무개" })).status, 403);
  assert.equal((await call("lead", "POST", "/admin/set-name", { "대상": fc2.id, "이름": "아무개" })).status, 403);
  assert.equal((await call("lead", "POST", "/admin/set-name", { "대상": fc.id, "이름": "김팀원" })).status, 200);
});
await check("직급 — 팀장은 자기보다 높은 BM을 못 준다", async () => {
  assert.equal((await call("lead", "POST", "/admin/set-grade", { "대상": fc.id, "직급": "BM" })).status, 403);
  assert.equal((await call("lead", "POST", "/admin/set-grade", { "대상": fc.id, "직급": "FC" })).status, 200);
});
const 호 = (id, 발행인, 이미지 = "") => ({
  "목록항목": { id, "채널": "주간", "호수": 1, "제목": "t", "발행일": "2026-09-27", "발행인": 발행인, "커버이미지": 이미지 },
  "본문": { id, "기사": [{ "제목": "t", "본문": [], "이미지": "" }] }
});
await check("발행 — 외부 이미지는 거절, 우리 미디어는 통과", async () => {
  assert.equal((await call("fc", "POST", "/care/publish", 호("weekly-90", "팀원", "https://news.example/x.jpg"))).status, 400);
  assert.equal((await call("fc", "POST", "/care/publish", 호("weekly-90", "안창민", "https://api.insurguard.life/media/20260927-abc.png"))).status, 200);
  const 목록 = await (await call("fc", "GET", "/care/issues")).json();
  const 내것 = 목록.find((i) => i.id === "weekly-90");
  assert.equal(내것["발행인"], "김팀원", "승인권 없는 사람은 자기 이름으로 발행된다");
  assert.ok(!("올린계정" in 내것), "목록에 계정 번호가 새지 않는다");
});
await check("발행 — 남의 호는 덮어쓰기를 보내도 못 덮는다, 편집장은 덮는다", async () => {
  const 덮기 = (who) => { const b = 호("weekly-90", "x"); b["목록항목"]["덮어쓰기"] = true; return call(who, "POST", "/care/publish", b); };
  assert.equal((await 덮기("fc2")).status, 403);
  assert.equal((await 덮기("fc")).status, 200, "내 호는 덮는다");
  assert.equal((await 덮기("boss")).status, 200, "편집장은 덮는다");
});
await check("기사가 배열이 아니면 400", async () => {
  const b = 호("weekly-91", "x"); b["본문"]["기사"] = "문자열";
  assert.equal((await call("fc", "POST", "/care/publish", b)).status, 400);
});
await check("사진 올리기 — 크기를 넘으면 끊지 않고 413", async () => {
  const raw = await new Promise((ok) => {
    const CRLF = String.fromCharCode(13, 10);
    const sk = connect(8797, "127.0.0.1", () => sk.write(["POST /media/upload HTTP/1.1", "Host: x", "Authorization: Bearer " + T.fc, "Content-Type: image/png", "Content-Length: " + (50 * 1048576), "", "0123456789"].join(CRLF)));
    let buf = ""; sk.on("data", (c) => { buf += c; sk.destroy(); ok(buf); }); sk.on("error", () => ok(buf));
    setTimeout(() => { sk.destroy(); ok(buf); }, 3000);
  });
  assert.match(raw, /^HTTP\/1\.1 413/, raw.slice(0, 80));
});
await check("강의 자료 지우기 — 깨진 %인코딩은 400", async () => {
  assert.equal((await call("fc", "DELETE", "/brief/library/%E0")).status, 400);
});
console.log(`\n결과: ${n} 통과`);
process.exit(0);
