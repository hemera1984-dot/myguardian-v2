// 인증·승인 서버 자체 검증 — node --env-file=.env.test server/test.js
//
// 구글 토큰이 필요한 경로는 실토큰 없이 검증할 수 없으므로, 여기서는 그 뒤의
// 인가 규칙(차단·범위 제한)과 저장소 로직을 확인한다. 차단이 뚫리면 실패한다.

import assert from "node:assert";
import { rmSync } from "node:fs";
import {
  openDb, seedGrades, upsertAccount, findByGoogleSub, createSession, accountForToken,
  listPending, approve, suspend, isDescendantOf, getAccount, deleteSessionsFor,
  setApprover, listMembers, getDoc, setDoc,
  listClients, listClientStamps, putClient, deleteClient, clientCounts
} from "./db.js";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { artworkSvg } from "./artwork.js";

const FILE = "./test-auth.db";
rmSync(FILE, { force: true });
rmSync(FILE + "-wal", { force: true });
rmSync(FILE + "-shm", { force: true });

const db = openDb(FILE);
seedGrades(db, [
  { code: "SSL", name: "팀장", rank: 3 },
  { code: "GSL", name: "부팀장", rank: 4 },
  { code: "FC", name: "팀원", rank: 5 }
]);

const BOOTSTRAP = ["boss@example.com"];
let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log("통과  " + name);
}

check("최초 로그인 계정은 대기 상태 — 승인 없이는 아무것도 열리지 않는다", () => {
  const a = upsertAccount(db, { sub: "g-fc1", email: "fc1@example.com", name: "김승은" }, BOOTSTRAP);
  assert.equal(a.status, "대기");
  assert.equal(a.is_admin, 0);
});

check("부트스트랩 이메일은 첫 로그인에 총관리자로 승인 — 승인자 부재 상태를 푼다", () => {
  const boss = upsertAccount(db, { sub: "g-boss", email: "boss@example.com", name: "안창민" }, BOOTSTRAP);
  assert.equal(boss.status, "승인");
  assert.equal(boss.is_admin, 1);
});

check("재로그인은 새 계정을 만들지 않고 기존 계정을 유지한다", () => {
  const before = findByGoogleSub(db, "g-fc1");
  const again = upsertAccount(db, { sub: "g-fc1", email: "fc1@example.com", name: "김승은" }, BOOTSTRAP);
  assert.equal(again.id, before.id);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM accounts").get().c, 2);
});

check("세션 토큰으로 계정을 찾고, 만료된 세션은 통과시키지 않는다", () => {
  const boss = findByGoogleSub(db, "g-boss");
  const s = createSession(db, boss.id);
  assert.equal(accountForToken(db, s.token).id, boss.id);
  assert.equal(accountForToken(db, "없는토큰"), null);

  db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?")
    .run(new Date(Date.now() - 1000).toISOString(), s.token);
  assert.equal(accountForToken(db, s.token), null, "만료 세션이 통과되면 안 된다");
});

check("승인 대기 목록에 대기 계정만 오른다", () => {
  const pending = listPending(db);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].email, "fc1@example.com");
});

check("승인하면 직급·상위자가 붙고 대기 목록에서 빠진다", () => {
  const boss = findByGoogleSub(db, "g-boss");
  const fc1 = findByGoogleSub(db, "g-fc1");
  approve(db, { targetId: fc1.id, grade: "SSL", parentId: boss.id, approverId: boss.id });
  const after = getAccount(db, fc1.id);
  assert.equal(after.status, "승인");
  assert.equal(after.grade, "SSL");
  assert.equal(after.parent_id, boss.id);
  assert.equal(listPending(db).length, 0);
});

check("하위 트리 판정 — 승인 범위 제한의 근거", () => {
  const boss = findByGoogleSub(db, "g-boss");
  const lead = findByGoogleSub(db, "g-fc1"); // SSL, boss 아래
  const member = upsertAccount(db, { sub: "g-fc2", email: "fc2@example.com", name: "최연" }, BOOTSTRAP);
  approve(db, { targetId: member.id, grade: "FC", parentId: lead.id, approverId: boss.id });

  assert.equal(isDescendantOf(db, member.id, lead.id), true, "팀원은 팀장의 하위여야 한다");
  assert.equal(isDescendantOf(db, member.id, boss.id), true, "손자도 하위 트리에 든다");
  assert.equal(isDescendantOf(db, lead.id, member.id), false, "역방향은 하위가 아니다");
  assert.equal(isDescendantOf(db, boss.id, boss.id), false, "자기 자신은 하위가 아니다");
});

check("상위 사슬이 순환해도 하위 트리 판정이 멈춘다", () => {
  const lead = findByGoogleSub(db, "g-fc1");
  const member = findByGoogleSub(db, "g-fc2");
  db.prepare("UPDATE accounts SET parent_id = ? WHERE id = ?").run(member.id, lead.id); // 순환 주입
  assert.equal(isDescendantOf(db, member.id, 99999), false);
  db.prepare("UPDATE accounts SET parent_id = ? WHERE id = ?")
    .run(findByGoogleSub(db, "g-boss").id, lead.id); // 원복
});

check("정지하면 상태가 바뀌고 기존 세션이 즉시 끊긴다", () => {
  const member = findByGoogleSub(db, "g-fc2");
  const s = createSession(db, member.id);
  assert.ok(accountForToken(db, s.token));
  suspend(db, member.id);
  assert.equal(getAccount(db, member.id).status, "정지");
  assert.equal(accountForToken(db, s.token), null, "정지 후에도 세션이 살아 있으면 안 된다");
});

check("승인 권한은 직급이 아니라 계정에 붙는다 — 총관리자가 주고 뺀다", () => {
  const lead = findByGoogleSub(db, "g-fc1"); // SSL(팀장)이지만 기본은 권한 없음
  assert.equal(getAccount(db, lead.id).can_approve, 0, "직급만으로 권한이 생기면 안 된다");
  setApprover(db, lead.id, true);
  assert.equal(getAccount(db, lead.id).can_approve, 1);
  assert.ok(listMembers(db).some((m) => m.id === lead.id && m.can_approve === 1));
  setApprover(db, lead.id, false);
  assert.equal(getAccount(db, lead.id).can_approve, 0, "회수되어야 한다");
});

check("세션 일괄 삭제 — 퇴사·회수 시 접근 차단", () => {
  const boss = findByGoogleSub(db, "g-boss");
  createSession(db, boss.id);
  createSession(db, boss.id);
  deleteSessionsFor(db, boss.id);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sessions WHERE account_id = ?").get(boss.id).c, 0);
});

check("삽화 조립 — 팔레트 밖 색·이상 좌표는 튕겨낸다", () => {
  const svg = artworkSvg({
    배경: "javascript:x", 의도: "",
    도형: [
      { 형: "원", x: 10, y: 10, w: 40, h: 40, 색: '"><script>', 회전: 0 },
      { 형: "사각", x: "말도 안 되는 값", y: 9999, w: -50, h: 30, 색: "파랑", 회전: 999 },
      { 형: "삼각", x: 60, y: 50, w: 30, h: 40, 색: "노랑", 회전: -20 }
    ]
  }, "칼럼");
  assert.ok(!/script|javascript/i.test(svg), "AI 출력이 마크업으로 새면 안 된다");
  assert.ok(svg.includes('width="1600" height="900"'), "칼럼은 16:9 판형");
  assert.ok(svg.includes('fill="#111111"'), "모르는 색은 잉크로 떨어진다");
  assert.equal((svg.match(/<circle|<rect|<polygon/g) || []).length, 4, "배경 1 + 도형 3");
  assert.ok(artworkSvg({ 배경: "빨강" }, "표지").includes('width="1200" height="1600"'), "표지는 3:4 판형");
});

check("조직도는 서버에 남는다 — 고친 사람만 보이던 localStorage를 대신한다", () => {
  assert.equal(getDoc(db, "org"), null, "아직 저장한 적이 없으면 비어 있다");
  const boss = findByGoogleSub(db, "g-boss");
  const org = { 구성원: [{ 코드: "fc01", 이름: "안창민", 직급: "GSL", 상위: null, 계정: boss.id, 이메일: boss.email }] };
  setDoc(db, "org", JSON.stringify(org), boss.id);
  assert.deepEqual(JSON.parse(getDoc(db, "org")), org);
  // 같은 열쇠로 다시 쓰면 덮어쓴다 (줄이 쌓이지 않는다)
  org["구성원"][0]["직급"] = "SSL";
  setDoc(db, "org", JSON.stringify(org), boss.id);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM app_docs").get().c, 1);
  assert.equal(JSON.parse(getDoc(db, "org"))["구성원"][0]["직급"], "SSL");
});

// ── 고객 레코드 — 소유 격리와 암호 (2026-08-31 잠금문구 폐지 뒤 추가)
// 검수에서 「새 암호·권한 경로를 검증하는 테스트가 없다」는 지적을 받아 넣었다.

const KEY = randomBytes(32);
function 감싸기(obj) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", KEY, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return [iv.toString("base64"), ct.toString("base64"), c.getAuthTag().toString("base64")].join(".");
}
function 풀기(str) {
  const [iv, ct, tag] = String(str).split(".");
  const d = createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8"));
}

check("고객은 소유 계정 밖으로 새지 않는다", () => {
  const a = findByGoogleSub(db, "g-boss");
  const b = findByGoogleSub(db, "g-fc1");
  putClient(db, a.id, { "고객코드": "C-2026-001", "암호문": 감싸기({ 이름: "가" }), "열쇠_fc": "", "열쇠_비상": "", "비상키지문": "" });
  putClient(db, b.id, { "고객코드": "C-2026-001", "암호문": 감싸기({ 이름: "나" }), "열쇠_fc": "", "열쇠_비상": "", "비상키지문": "" });
  assert.equal(listClients(db, a.id).length, 1);
  assert.equal(listClients(db, b.id).length, 1);
  // 같은 고객코드라도 사람마다 따로 산다 — 남의 것을 덮지 않는다
  assert.equal(풀기(listClients(db, a.id)[0].암호문).이름, "가");
  assert.equal(풀기(listClients(db, b.id)[0].암호문).이름, "나");
  // 삭제도 자기 것만
  assert.equal(deleteClient(db, a.id, "C-2026-001"), 1);
  assert.equal(listClients(db, b.id).length, 1, "남의 것은 그대로 있어야 한다");
  assert.equal(listClientStamps(db, b.id).length, 1);
});

check("암호문이 한 글자라도 바뀌면 풀리지 않는다 (인증 태그)", () => {
  const 봉투 = 감싸기({ 이름: "다", 연락처: "010-0000-0000" });
  assert.equal(풀기(봉투).이름, "다");
  assert.ok(!봉투.includes("010-0000-0000"), "봉투에 평문이 남으면 안 된다");
  const 부분 = 봉투.split(".");
  const 상한 = Buffer.from(부분[1], "base64");
  상한[0] ^= 1;
  부분[1] = 상한.toString("base64");
  assert.throws(() => 풀기(부분.join(".")), "손댄 암호문은 반드시 실패해야 한다");
});

check("다른 열쇠로는 열리지 않는다", () => {
  const 봉투 = 감싸기({ 이름: "라" });
  const 남의열쇠 = randomBytes(32);
  assert.throws(() => {
    const [iv, ct, tag] = 봉투.split(".");
    const d = createDecipheriv("aes-256-gcm", 남의열쇠, Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]);
  });
});

check("열람 비밀번호는 해시로만 남고 틀린 값은 걸러진다", () => {
  const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };   // 시험은 가볍게
  const 해시 = (pw, salt) => scryptSync(String(pw), salt, 32, SCRYPT).toString("base64");
  const salt = randomBytes(16).toString("base64");
  const 보관 = JSON.stringify({ salt, hash: 해시("바른비밀번호", salt), 방식: SCRYPT });
  const boss = findByGoogleSub(db, "g-boss");
  setDoc(db, "열람비번", 보관, boss.id);
  const v = JSON.parse(getDoc(db, "열람비번"));
  assert.ok(!getDoc(db, "열람비번").includes("바른비밀번호"), "원문이 남으면 안 된다");
  const 맞나 = (pw) => {
    const a = Buffer.from(해시(pw, v.salt), "base64");
    const b = Buffer.from(v.hash, "base64");
    return a.length === b.length && timingSafeEqual(a, b);
  };
  assert.ok(맞나("바른비밀번호"));
  assert.ok(!맞나("틀린비밀번호"));
  assert.ok(!맞나(""));
});

check("총관리자 화면의 건수 집계는 내용을 담지 않는다", () => {
  const rows = clientCounts(db);
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ["건수", "계정", "이름", "최근갱신"].sort());
  }
});

db.close();
rmSync(FILE, { force: true });
rmSync(FILE + "-wal", { force: true });
rmSync(FILE + "-shm", { force: true });
console.log(`\n결과: ${passed}/${passed} 통과`);
