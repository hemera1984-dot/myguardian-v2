// 인증·승인 서버 자체 검증 — node --env-file=.env.test server/test.js
//
// 구글 토큰이 필요한 경로는 실토큰 없이 검증할 수 없으므로, 여기서는 그 뒤의
// 인가 규칙(차단·범위 제한)과 저장소 로직을 확인한다. 차단이 뚫리면 실패한다.

import assert from "node:assert";
import { rmSync } from "node:fs";
import {
  openDb, seedGrades, upsertAccount, findByGoogleSub, createSession, accountForToken,
  listPending, approve, suspend, isDescendantOf, getAccount, deleteSessionsFor,
  setApprover, listMembers
} from "./db.js";
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

db.close();
rmSync(FILE, { force: true });
rmSync(FILE + "-wal", { force: true });
rmSync(FILE + "-shm", { force: true });
console.log(`\n결과: ${passed}/${passed} 통과`);
