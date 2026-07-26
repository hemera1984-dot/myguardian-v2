// 마이가디언 인증·승인 서버 (2차 공사 STEP 1)
//
// 원칙: 차단은 서버가 한다. 승인되지 않은 계정에는 데이터를 주지 않는다.
// 브라우저가 "로그인했다"고 주장하는 값은 신뢰하지 않는다 — 구글이 발급한 토큰을
// 구글에게 다시 물어 검증한 뒤에만 세션을 만든다.
//
// 외부 패키지를 쓰지 않는다 (Node 22+ 내장 http·sqlite·crypto·fetch).
// 서버에서 npm install 할 일이 없어 배포가 단순하다.

import { createServer } from "node:http";
import {
  openDb, seedGrades, upsertAccount, createSession, accountForToken, deleteSession,
  listGrades, listPending, listMembers, getAccount, approve, suspend, setAdmin,
  isDescendantOf
} from "./db.js";

const PORT = Number(process.env.PORT || 8787);
const DB_FILE = process.env.DB_FILE || "./myguardian.db";
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const BOOTSTRAP = (process.env.BOOTSTRAP_ADMINS || "").split(",")
  .map((s) => s.trim().toLowerCase()).filter(Boolean);

if (!CLIENT_ID) {
  console.error("GOOGLE_CLIENT_ID가 없습니다. .env를 확인하세요.");
  process.exit(1);
}

// 직급표 — 이름·구조를 코드에 박지 않는다는 원칙에 따라 여기서 주입하고 DB에 싣는다.
// 팀원승인: 이 직급이 자기 하위 트리의 대기 계정을 승인할 수 있는가.
const GRADES = [
  { code: "BM", name: "지점장", rank: 1, "팀원승인": true },
  { code: "ESL", name: "부지점장", rank: 2, "팀원승인": true },
  { code: "SSL", name: "팀장", rank: 3, "팀원승인": true },
  { code: "GSL", name: "부팀장", rank: 4, "팀원승인": false },
  { code: "FC", name: "팀원", rank: 5, "팀원승인": false }
];

const db = openDb(DB_FILE);
seedGrades(db, GRADES);

// ---------- HTTP 도우미 ----------

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("본문이 너무 큽니다.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("JSON 형식 오류")); }
    });
    req.on("error", reject);
  });
}

function bearer(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

// ---------- 구글 ID 토큰 검증 ----------
// 구글의 tokeninfo 엔드포인트로 검증한다. 서명·발급자·만료를 구글이 직접 확인해 주므로
// JWT 검증을 직접 구현하지 않는다(직접 구현은 alg 혼동 등 사고가 잦다).
// 반환된 aud가 우리 클라이언트 ID인지는 반드시 여기서 확인한다 — 다른 앱의 토큰 차단.

async function verifyGoogleToken(credential) {
  if (typeof credential !== "string" || credential.length < 20 || credential.length > 8192) {
    throw new Error("토큰 형식 오류");
  }
  const url = "https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential);
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error("구글 토큰 검증 실패");
  const info = await resp.json();

  if (info.aud !== CLIENT_ID) throw new Error("다른 앱의 토큰입니다.");
  if (info.iss !== "accounts.google.com" && info.iss !== "https://accounts.google.com") {
    throw new Error("발급자가 올바르지 않습니다.");
  }
  if (Number(info.exp) * 1000 < Date.now()) throw new Error("만료된 토큰입니다.");
  if (info.email_verified !== "true" && info.email_verified !== true) {
    throw new Error("이메일 미인증 계정입니다.");
  }
  if (!info.sub || !info.email) throw new Error("토큰에 계정 정보가 없습니다.");
  return { sub: info.sub, email: String(info.email).toLowerCase(), name: info.name || "" };
}

// ---------- 인가 ----------

function publicAccount(db, a) {
  return {
    id: a.id,
    이메일: a.email,
    이름: a.name,
    상태: a.status,
    직급: a.grade,
    상위: a.parent_id,
    총관리자: !!a.is_admin
  };
}

// 승인 권한: 총관리자이거나, 직급에 팀원승인 플래그가 있는 승인 계정.
function canApprove(db, me) {
  if (me.status !== "승인") return false;
  if (me.is_admin) return true;
  if (!me.grade) return false;
  const g = db.prepare("SELECT can_approve FROM grades WHERE code = ?").get(me.grade);
  return !!(g && g.can_approve);
}

// 총관리자는 전 범위. 팀장급은 자기 자신 또는 자기 하위 트리 아래로만 붙일 수 있다.
function canAssignUnder(db, me, parentId) {
  if (me.is_admin) return true;
  if (parentId == null) return false; // 최상위 배치는 총관리자만
  if (parentId === me.id) return true;
  return isDescendantOf(db, parentId, me.id);
}

// ---------- 라우트 ----------

async function route(req, res, url) {
  const path = url.pathname;

  if (req.method === "POST" && path === "/auth/google") {
    const body = await readJson(req);
    const info = await verifyGoogleToken(body.credential);
    const account = upsertAccount(db, info, BOOTSTRAP);
    if (account.status === "정지") {
      return send(res, 403, { error: "정지된 계정입니다. 관리자에게 문의하세요." });
    }
    const session = createSession(db, account.id);
    return send(res, 200, {
      토큰: session.token,
      만료: session.expires,
      계정: publicAccount(db, account)
    });
  }

  if (req.method === "POST" && path === "/auth/logout") {
    const t = bearer(req);
    if (t) deleteSession(db, t);
    return send(res, 200, { ok: true });
  }

  // 이 아래는 세션 필요
  const me = accountForToken(db, bearer(req));
  if (!me) return send(res, 401, { error: "로그인이 필요합니다." });
  if (me.status === "정지") return send(res, 403, { error: "정지된 계정입니다." });

  if (req.method === "GET" && path === "/me") {
    return send(res, 200, {
      계정: publicAccount(db, me),
      승인권한: canApprove(db, me),
      직급표: listGrades(db).map((g) => ({ 코드: g.code, 이름: g.name, 팀원승인: !!g.can_approve }))
    });
  }

  // 승인 대기 상태에서는 여기까지만 — 데이터 경로는 열지 않는다
  if (me.status !== "승인") return send(res, 403, { error: "승인 대기 중입니다." });

  if (req.method === "GET" && path === "/admin/pending") {
    if (!canApprove(db, me)) return send(res, 403, { error: "승인 권한이 없습니다." });
    return send(res, 200, { 대기: listPending(db), 구성원: listMembers(db) });
  }

  if (req.method === "POST" && path === "/admin/approve") {
    if (!canApprove(db, me)) return send(res, 403, { error: "승인 권한이 없습니다." });
    const { 대상, 직급, 상위 } = await readJson(req);
    const target = getAccount(db, Number(대상));
    if (!target) return send(res, 404, { error: "대상 계정을 찾을 수 없습니다." });
    if (target.status !== "대기") return send(res, 409, { error: "이미 처리된 계정입니다." });
    if (!listGrades(db).some((g) => g.code === 직급)) {
      return send(res, 400, { error: "직급 코드가 올바르지 않습니다." });
    }
    const parentId = 상위 == null ? null : Number(상위);
    if (parentId != null && !getAccount(db, parentId)) {
      return send(res, 400, { error: "상위자를 찾을 수 없습니다." });
    }
    if (!canAssignUnder(db, me, parentId)) {
      return send(res, 403, { error: "자기 하위 조직으로만 승인할 수 있습니다." });
    }
    approve(db, { targetId: target.id, grade: 직급, parentId, approverId: me.id });
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && path === "/admin/suspend") {
    const { 대상 } = await readJson(req);
    const target = getAccount(db, Number(대상));
    if (!target) return send(res, 404, { error: "대상 계정을 찾을 수 없습니다." });
    if (target.id === me.id) return send(res, 400, { error: "자기 계정은 정지할 수 없습니다." });
    // 총관리자는 전원, 팀장급은 자기 하위 트리만
    if (!me.is_admin && !isDescendantOf(db, target.id, me.id)) {
      return send(res, 403, { error: "권한 범위 밖의 계정입니다." });
    }
    if (target.is_admin && !me.is_admin) return send(res, 403, { error: "권한이 없습니다." });
    suspend(db, target.id);
    return send(res, 200, { ok: true });
  }

  // 관리자 임명·회수는 총관리자 전용 (기존 결정 유지)
  if (req.method === "POST" && path === "/admin/set-admin") {
    if (!me.is_admin) return send(res, 403, { error: "총관리자만 가능합니다." });
    const { 대상, 임명 } = await readJson(req);
    const target = getAccount(db, Number(대상));
    if (!target) return send(res, 404, { error: "대상 계정을 찾을 수 없습니다." });
    if (target.id === me.id) return send(res, 400, { error: "자기 권한은 바꿀 수 없습니다." });
    setAdmin(db, target.id, !!임명);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: "없는 경로입니다." });
}

const server = createServer((req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, "http://localhost");
  route(req, res, url).catch((err) => {
    const msg = err && err.message ? err.message : "처리 중 오류가 발생했습니다.";
    // 검증 실패는 사용자 입력 문제이므로 400, 나머지는 500
    send(res, /토큰|형식|JSON|앱의|발급자|만료|미인증/.test(msg) ? 400 : 500, { error: msg });
  });
});

server.listen(PORT, () => {
  console.log(`마이가디언 인증 서버 :${PORT} — DB ${DB_FILE}`);
  if (!ORIGINS.length) console.warn("ALLOWED_ORIGINS가 비어 있어 브라우저 호출이 차단됩니다.");
  if (!BOOTSTRAP.length) console.warn("BOOTSTRAP_ADMINS가 비어 있어 첫 총관리자를 만들 수 없습니다.");
});

export { server, db };
