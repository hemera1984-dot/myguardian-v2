// 계정·승인 저장소 — Node 내장 SQLite (외부 패키지 없음)
//
// 팀 20명 규모를 전제로 파일 한 개(SQLite)에 담는다. 관리형 DB를 따로 사려면
// 월 비용이 들고, 이 규모에서는 얻는 것이 없다.
// ponytail: 단일 파일 SQLite. 팀이 수백 명이 되거나 서버를 여러 대로 늘릴 때
//   관리형 DB로 옮긴다 (스키마는 그대로 이관 가능).

import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

const SESSION_DAYS = 14;

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS grades (
      code       TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      rank       INTEGER NOT NULL,
      can_approve INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      google_sub  TEXT NOT NULL UNIQUE,
      email       TEXT NOT NULL,
      name        TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT '대기',
      grade       TEXT REFERENCES grades(code),
      parent_id   INTEGER REFERENCES accounts(id),
      is_admin    INTEGER NOT NULL DEFAULT 0,
      can_approve INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      approved_at TEXT,
      approved_by INTEGER REFERENCES accounts(id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
  `);

  // 이미 만들어진 DB에 컬럼 추가 (있으면 그냥 실패하므로 삼킨다)
  try { db.exec("ALTER TABLE accounts ADD COLUMN can_approve INTEGER NOT NULL DEFAULT 0"); }
  catch (e) { /* 이미 있음 */ }

  // 구글 계정의 표시 이름이 실제 이름과 다른 사람이 있다(별명·오기·영문 표기).
  // 관리자가 고쳐 넣는 이름을 따로 둔다 — 다시 로그인해도 구글 값이 덮어쓰지 않는다.
  try { db.exec("ALTER TABLE accounts ADD COLUMN display_name TEXT"); }
  catch (e) { /* 이미 있음 */ }

  return db;
}

// 직급표 시딩 — 이름·구조를 코드에 박지 않는다. 승인 권한은 계정에 붙으므로 여기 없다.
export function seedGrades(db, grades) {
  const stmt = db.prepare(
    `INSERT INTO grades (code, name, rank) VALUES (?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET name = excluded.name, rank = excluded.rank`
  );
  for (const g of grades) stmt.run(g.code, g.name, g.rank);
}

const now = () => new Date().toISOString();

export function findByGoogleSub(db, sub) {
  return db.prepare("SELECT * FROM accounts WHERE google_sub = ?").get(sub) || null;
}

// 최초 로그인 시 대기 계정 생성. bootstrapAdmin 이메일이면 즉시 총관리자로 승인한다
// (승인해 줄 사람이 아직 없는 상태를 푸는 유일한 경로).
export function upsertAccount(db, { sub, email, name }, bootstrapAdmins) {
  const found = findByGoogleSub(db, sub);
  if (found) {
    db.prepare("UPDATE accounts SET email = ?, name = ? WHERE id = ?")
      .run(email, name || found.name, found.id);
    return findByGoogleSub(db, sub);
  }
  const isBootstrap = bootstrapAdmins.includes(email.toLowerCase());
  db.prepare(
    `INSERT INTO accounts (google_sub, email, name, status, is_admin, created_at, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sub, email, name || "",
    isBootstrap ? "승인" : "대기",
    isBootstrap ? 1 : 0,
    now(),
    isBootstrap ? now() : null
  );
  return findByGoogleSub(db, sub);
}

export function createSession(db, accountId) {
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 86400e3).toISOString();
  db.prepare("INSERT INTO sessions (token, account_id, expires_at) VALUES (?, ?, ?)")
    .run(token, accountId, expires);
  return { token, expires };
}

// 세션 → 계정. 만료된 세션은 즉시 지운다. 정지 계정은 세션이 있어도 통과시키지 않는다.
export function accountForToken(db, token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT a.*, s.expires_at FROM sessions s JOIN accounts a ON a.id = s.account_id
     WHERE s.token = ?`
  ).get(token);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  // 관리자가 고쳐 넣은 이름이 있으면 그것이 이 사람의 이름이다.
  // 발행인·올린이 표기가 전부 이 값을 쓰므로 여기서 한 번에 바꿔 둔다.
  if (row.display_name && String(row.display_name).trim()) {
    row.google_name = row.name;
    row.name = String(row.display_name).trim();
  }
  return row;
}

export function deleteSession(db, token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function deleteSessionsFor(db, accountId) {
  db.prepare("DELETE FROM sessions WHERE account_id = ?").run(accountId);
}

export function listGrades(db) {
  return db.prepare("SELECT * FROM grades ORDER BY rank").all();
}

export function listPending(db) {
  return db.prepare(
    "SELECT id, email, name, created_at FROM accounts WHERE status = '대기' ORDER BY created_at"
  ).all();
}

export function listMembers(db) {
  return db.prepare(
    `SELECT id, email, COALESCE(NULLIF(display_name, ''), name) AS name,
            name AS google_name, display_name,
            status, grade, parent_id, is_admin, can_approve, approved_at
     FROM accounts WHERE status <> '대기' ORDER BY id`
  ).all();
}

// 관리자가 고쳐 넣는 이름. 빈 값이면 구글 이름으로 되돌린다.
export function setDisplayName(db, targetId, name) {
  const v = String(name || "").trim();
  db.prepare("UPDATE accounts SET display_name = ? WHERE id = ?").run(v || null, targetId);
}

export function setApprover(db, targetId, canApprove) {
  db.prepare("UPDATE accounts SET can_approve = ? WHERE id = ?").run(canApprove ? 1 : 0, targetId);
}

export function getAccount(db, id) {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) || null;
}

export function approve(db, { targetId, grade, parentId, approverId }) {
  db.prepare(
    `UPDATE accounts SET status = '승인', grade = ?, parent_id = ?, approved_at = ?, approved_by = ?
     WHERE id = ?`
  ).run(grade, parentId ?? null, now(), approverId, targetId);
}

export function suspend(db, targetId) {
  db.prepare("UPDATE accounts SET status = '정지' WHERE id = ?").run(targetId);
  deleteSessionsFor(db, targetId);
}

export function setAdmin(db, targetId, isAdmin) {
  db.prepare("UPDATE accounts SET is_admin = ? WHERE id = ?").run(isAdmin ? 1 : 0, targetId);
}

// 상위자 사슬을 타고 올라가 ancestorId가 있는지 본다 (자기 하위 트리 판정).
// 데이터가 꼬여 순환이 생겨도 멈추도록 방문 집합을 둔다.
export function isDescendantOf(db, accountId, ancestorId) {
  const seen = new Set();
  let cur = getAccount(db, accountId);
  while (cur && cur.parent_id != null && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.parent_id === ancestorId) return true;
    cur = getAccount(db, cur.parent_id);
  }
  return false;
}
