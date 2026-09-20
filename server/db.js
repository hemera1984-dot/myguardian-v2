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

    -- 조직도 — 전에는 브라우저(localStorage)에만 있어서 고쳐도 나만 보였다.
    -- 자리마다 계정 번호·이메일이 붙으므로 저장소가 아니라 여기 둔다(공개 저장소 금지).
    CREATE TABLE IF NOT EXISTS app_docs (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );

    -- 고객 레코드 — 서버는 내용을 모른다(헌법: 종단간 암호화).
    -- 여기 있는 것은 암호문과 그것을 여는 두 벌의 감싼 열쇠뿐이다.
    -- 열쇠_fc = 담당 FC의 열쇠로 감싼 데이터열쇠. 평상시 이것으로 연다.
    -- 열쇠_비상 = 지점 비상 공개키로 감싼 같은 데이터열쇠. 분실·퇴사 때만 쓴다.
    -- 서버는 둘 다 풀지 못한다 — 감싸고 푸는 일은 전부 기기에서 일어난다.
    CREATE TABLE IF NOT EXISTS clients (
      고객코드    TEXT NOT NULL,
      소유계정    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      암호문      TEXT NOT NULL,
      열쇠_fc     TEXT NOT NULL,
      열쇠_비상   TEXT NOT NULL,
      비상키지문  TEXT NOT NULL DEFAULT '',
      갱신시각    TEXT NOT NULL,
      PRIMARY KEY (소유계정, 고객코드)
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
    CREATE INDEX IF NOT EXISTS idx_clients_owner ON clients(소유계정);
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

// 조직도처럼 통째로 오가는 문서 하나. 조각으로 쪼개 봐야 화면이 통째로 쓰고 읽는다.
export function getDoc(db, key) {
  const r = db.prepare("SELECT value FROM app_docs WHERE key = ?").get(key);
  return r ? r.value : null;
}
export function setDoc(db, key, value, byId) {
  db.prepare(
    `INSERT INTO app_docs (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).run(key, value, new Date().toISOString(), byId ?? null);
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

// ── 고객 레코드 (암호문만 오간다)
// 서버는 암호문·감싼 열쇠를 그대로 보관하고 돌려줄 뿐 아무것도 해석하지 않는다.

export function listClients(db, ownerId) {
  return db.prepare(
    "SELECT 고객코드, 암호문, 열쇠_fc, 열쇠_비상, 비상키지문, 갱신시각"
    + " FROM clients WHERE 소유계정 = ? ORDER BY 갱신시각 DESC"
  ).all(ownerId);
}

// 목록만 — 내용 없이 무엇이 언제 바뀌었는지. 기기가 받아갈 것을 고를 때 쓴다.
export function listClientStamps(db, ownerId) {
  return db.prepare(
    "SELECT 고객코드, 갱신시각 FROM clients WHERE 소유계정 = ? ORDER BY 고객코드"
  ).all(ownerId);
}

export function putClient(db, ownerId, rec) {
  db.prepare(
    "INSERT INTO clients (고객코드, 소유계정, 암호문, 열쇠_fc, 열쇠_비상, 비상키지문, 갱신시각)"
    + " VALUES (?, ?, ?, ?, ?, ?, ?)"
    + " ON CONFLICT(소유계정, 고객코드) DO UPDATE SET"
    + " 암호문 = excluded.암호문, 열쇠_fc = excluded.열쇠_fc,"
    + " 열쇠_비상 = excluded.열쇠_비상, 비상키지문 = excluded.비상키지문,"
    + " 갱신시각 = excluded.갱신시각"
  ).run(rec.고객코드, ownerId, rec.암호문, rec.열쇠_fc, rec.열쇠_비상,
        rec.비상키지문 || "", new Date().toISOString());
}

export function deleteClient(db, ownerId, code) {
  return db.prepare("DELETE FROM clients WHERE 소유계정 = ? AND 고객코드 = ?")
    .run(ownerId, code).changes;
}

// 총관리자가 평상시 볼 수 있는 전부 — 어느 FC가 몇 명을 관리 중인가(헌법).
export function clientCounts(db) {
  return db.prepare(
    "SELECT a.id AS 계정, COALESCE(NULLIF(a.display_name,''), a.name) AS 이름,"
    + " COUNT(c.고객코드) AS 건수, MAX(c.갱신시각) AS 최근갱신"
    + " FROM accounts a LEFT JOIN clients c ON c.소유계정 = a.id"
    + " WHERE a.status = '승인' GROUP BY a.id ORDER BY 건수 DESC"
  ).all();
}
