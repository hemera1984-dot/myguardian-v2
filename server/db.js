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
  return db;
}

// 직급표 시딩 — 이름·구조를 코드에 박지 않는다. can_approve가 팀원승인 플래그다.
export function seedGrades(db, grades) {
  const stmt = db.prepare(
    `INSERT INTO grades (code, name, rank, can_approve) VALUES (?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET name = excluded.name, rank = excluded.rank,
       can_approve = excluded.can_approve`
  );
  for (const g of grades) {
    stmt.run(g.code, g.name, g.rank, g["팀원승인"] ? 1 : 0);
  }
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
    `SELECT id, email, name, status, grade, parent_id, is_admin, approved_at
     FROM accounts WHERE status <> '대기' ORDER BY id`
  ).all();
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
