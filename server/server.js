// 마이가디언 인증·승인 서버 (2차 공사 STEP 1)
//
// 원칙: 차단은 서버가 한다. 승인되지 않은 계정에는 데이터를 주지 않는다.
// 브라우저가 "로그인했다"고 주장하는 값은 신뢰하지 않는다 — 구글이 발급한 토큰을
// 구글에게 다시 물어 검증한 뒤에만 세션을 만든다.
//
// 외부 패키지를 쓰지 않는다 (Node 22+ 내장 http·sqlite·crypto·fetch).
// 서버에서 npm install 할 일이 없어 배포가 단순하다.

import { createServer } from "node:http";
import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  openDb, seedGrades, upsertAccount, createSession, accountForToken, deleteSession,
  listGrades, listPending, listMembers, getAccount, approve, suspend, setAdmin,
  setApprover, isDescendantOf
} from "./db.js";

const PORT = Number(process.env.PORT || 8787);
const DB_FILE = process.env.DB_FILE || "./myguardian.db";
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const BOOTSTRAP = (process.env.BOOTSTRAP_ADMINS || "").split(",")
  .map((s) => s.trim().toLowerCase()).filter(Boolean);
// 기사 제목 다듬기 중계 — API 키는 서버에만 두고 브라우저에 노출하지 않는다.
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const TITLE_MODEL = process.env.TITLE_MODEL || "claude-opus-5";

const MEDIA_DIR = process.env.MEDIA_DIR || "./media";
const MEDIA_BASE = process.env.MEDIA_BASE || "";  // 예: https://api.insurguard.life/media

// 케어센터 발행물 저장소 — 발행 버튼이 올린 호를 여기 둔다.
// 정적 저장소(data/care)는 그대로 두고, 서버 발행분만 이 디렉토리에 쌓인다.
// 서재·지면은 서버 목록을 우선 읽고 정적 목록과 병합한다.
const CARE_DIR = process.env.CARE_DIR || "./care";
const CARE_ISSUES_DIR = join(CARE_DIR, "issues");
const CARE_LIST = join(CARE_DIR, "issues.json");

// 지면 사진 업로드 — 받아들일 형식과 크기. 확장자는 서버가 정한다(파일명을 믿지 않는다).
const IMAGE_TYPES = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif"
};
const MAX_IMAGE = 12 * 1024 * 1024;

mkdirSync(MEDIA_DIR, { recursive: true });
mkdirSync(CARE_ISSUES_DIR, { recursive: true });

if (!CLIENT_ID) {
  console.error("GOOGLE_CLIENT_ID가 없습니다. .env를 확인하세요.");
  process.exit(1);
}

// 직급표 — 이름·구조를 코드에 박지 않는다는 원칙에 따라 여기서 주입하고 DB에 싣는다.
// 승인 권한은 직급이 아니라 계정에 붙는다(accounts.can_approve). 총관리자가 화면에서 준다.
const GRADES = [
  { code: "BM", name: "지점장", rank: 1 },
  { code: "ESL", name: "부지점장", rank: 2 },
  { code: "SSL", name: "팀장", rank: 3 },
  { code: "GSL", name: "부팀장", rank: 4 },
  { code: "FC", name: "팀원", rank: 5 }
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

// 사진은 원시 바이트로 받는다 — multipart를 직접 파싱하지 않는다(코드가 길고 사고가 잦다).
// 브라우저가 File 객체를 그대로 본문에 실으면 되고, 형식은 Content-Type으로 판단한다.
function readBytes(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("파일이 너무 큽니다.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ---------- 케어센터 발행물 저장 ----------

function readCareList() {
  try {
    const list = JSON.parse(readFileSync(CARE_LIST, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

// 임시 파일에 쓴 뒤 원자적으로 교체한다 — 절반만 쓰인 파일을 남기지 않는다 (pipeline과 같은 원칙)
function atomicWrite(file, text) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, text);
  renameSync(tmp, file);
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

// 승인 권한: 총관리자이거나, 총관리자가 승인 권한을 준 승인 계정.
function canApprove(db, me) {
  if (me.status !== "승인") return false;
  return !!(me.is_admin || me.can_approve);
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

  // 케어센터 발행물 읽기 — 공개 경로. 독자는 고객이라 로그인이 없다.
  // 서재·지면이 이 목록을 정적 목록과 병합해 보여준다.
  if (req.method === "GET" && path === "/care/issues") {
    return send(res, 200, readCareList());
  }
  const careBody = req.method === "GET" && /^\/care\/issues\/([a-z0-9-]{1,64})$/.exec(path);
  if (careBody) {
    const file = join(CARE_ISSUES_DIR, careBody[1] + ".json");
    if (!existsSync(file)) return send(res, 404, { error: "없는 발행물입니다." });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(readFileSync(file));
  }

  // 이 아래는 세션 필요
  const me = accountForToken(db, bearer(req));
  if (!me) return send(res, 401, { error: "로그인이 필요합니다." });
  if (me.status === "정지") return send(res, 403, { error: "정지된 계정입니다." });

  if (req.method === "GET" && path === "/me") {
    return send(res, 200, {
      계정: publicAccount(db, me),
      승인권한: canApprove(db, me),
      직급표: listGrades(db).map((g) => ({ 코드: g.code, 이름: g.name }))
    });
  }

  // 승인 대기 상태에서는 여기까지만 — 데이터 경로는 열지 않는다
  if (me.status !== "승인") return send(res, 403, { error: "승인 대기 중입니다." });

  // 기사 제목 다듬기 — 가제를 넣으면 다듬은 제목 3안을 준다.
  // 승인된 계정이면 누구나. 키는 서버에만 있고 응답에 실리지 않는다.
  if (req.method === "POST" && path === "/ai/title") {
    if (!ANTHROPIC_KEY) return send(res, 503, { error: "AI 기능이 설정되지 않았습니다." });
    const { 가제, 카테고리, 채널 } = await readJson(req);
    const draft = String(가제 || "").trim();
    if (!draft) return send(res, 400, { error: "가제를 입력하세요." });
    if (draft.length > 200) return send(res, 400, { error: "가제가 너무 깁니다." });

    const prompt = [
      `보험 설계사가 고객에게 보내는 ${채널 || "주간"} 뉴스레터의 ${카테고리 || ""} 기사 제목을 다듬는다.`,
      `가제: ${draft}`,
      "",
      "조건:",
      "- 경제지 기사 제목 문법. 사실 전달이 우선이고 과장·낚시는 쓰지 않는다.",
      "- 30자 안팎. 이모지·영문 장식 표기 금지.",
      "- 가제의 사실관계를 바꾸지 않는다. 없는 내용을 지어내지 않는다.",
      "- 서로 다른 각도로 3개를 제시한다."
    ].join("\n");

    // 외부 패키지를 쓰지 않는 서버라 공식 SDK 대신 원시 HTTP로 호출한다
    // (서버에서 npm install 하지 않는 배포 방식을 유지하기 위한 선택).
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: TITLE_MODEL,
        max_tokens: 2000,
        output_config: {
          effort: "low",
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                후보: { type: "array", items: { type: "string" } }
              },
              required: ["후보"],
              additionalProperties: false
            }
          }
        },
        messages: [{ role: "user", content: prompt }]
      }),
      signal: AbortSignal.timeout(60000)
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      console.error("제목 다듬기 실패:", upstream.status, detail.slice(0, 300));
      return send(res, 502, { error: "제목을 다듬지 못했습니다. 잠시 후 다시 시도하세요." });
    }
    const data = await upstream.json();
    if (data.stop_reason === "refusal") {
      return send(res, 422, { error: "이 내용으로는 제목을 만들 수 없습니다." });
    }
    const textBlock = (data.content || []).find((b) => b.type === "text");
    let 후보 = [];
    try { 후보 = JSON.parse(textBlock.text)["후보"] || []; } catch (e) { 후보 = []; }
    if (!후보.length) return send(res, 502, { error: "결과를 읽지 못했습니다." });
    return send(res, 200, { 후보: 후보.slice(0, 3) });
  }

  // 발행하기 — 승인된 계정이면 누구나(자기 호를 발행한다. 발행인은 목록항목에 실려 있다).
  // body = { 목록항목, 본문 } — 기존 issues.json 스키마 그대로.
  // 같은 id가 이미 있으면 교체한다(재발행). 발행 즉시 서재·지면에 반영된다.
  if (req.method === "POST" && path === "/care/publish") {
    const { 목록항목, 본문 } = await readJson(req, 1024 * 1024);
    if (!목록항목 || typeof 목록항목 !== "object" || Array.isArray(목록항목)
      || !본문 || typeof 본문 !== "object" || Array.isArray(본문)) {
      return send(res, 400, { error: "형식 오류: { 목록항목, 본문 } 객체가 필요합니다." });
    }
    // id는 파일명이 된다 — 소문자·숫자·하이픈만 허용해 경로 이탈을 원천 차단한다
    const id = String(목록항목.id || "");
    if (!/^[a-z0-9-]{1,64}$/.test(id)) {
      return send(res, 400, { error: "id 형식 오류: 소문자·숫자·하이픈 1~64자만 허용됩니다." });
    }
    if (본문.id !== id) return send(res, 400, { error: "목록항목과 본문의 id가 다릅니다." });
    if (!String(목록항목["제목"] || "").trim()) return send(res, 400, { error: "제목이 비어 있습니다." });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(목록항목["발행일"] || ""))) {
      return send(res, 400, { error: "발행일 형식 오류: YYYY-MM-DD" });
    }
    if (목록항목["채널"] !== "주간" && 목록항목["채널"] !== "월간") {
      return send(res, 400, { error: "채널은 주간 또는 월간이어야 합니다." });
    }
    const entry = { ...목록항목 };
    delete entry["상태"]; // 발행하기를 눌렀다 = 발행 확정. 발행 목록에 초안 표기를 남기지 않는다.
    atomicWrite(join(CARE_ISSUES_DIR, id + ".json"), JSON.stringify(본문, null, 1));
    const list = readCareList().filter((i) => i && i.id !== id);
    list.unshift(entry);
    atomicWrite(CARE_LIST, JSON.stringify(list, null, 1));
    console.log(`발행: ${entry["채널"]} ${entry["호수"]}호 (${id}) — ${me.email}`);
    return send(res, 200, { ok: true, id });
  }

  // 지면 사진 업로드 — 승인된 계정이면 누구나(자기 호에 쓸 사진이다)
  if (req.method === "POST" && path === "/media/upload") {
    const type = String(req.headers["content-type"] || "").split(";")[0].trim();
    const ext = IMAGE_TYPES[type];
    if (!ext) return send(res, 400, { error: "지원하지 않는 형식입니다. (JPG·PNG·WebP·GIF)" });
    const bytes = await readBytes(req, MAX_IMAGE);
    if (!bytes.length) return send(res, 400, { error: "빈 파일입니다." });
    // 파일명은 서버가 만든다 — 올린 이름을 그대로 쓰면 경로 이탈·덮어쓰기 위험이 있다
    const name = new Date().toISOString().slice(0, 10).replace(/-/g, "")
      + "-" + randomBytes(6).toString("hex") + ext;
    writeFileSync(join(MEDIA_DIR, name), bytes);
    return send(res, 200, {
      파일명: name,
      주소: (MEDIA_BASE ? MEDIA_BASE.replace(/\/$/, "") + "/" : "/media/") + name,
      크기: bytes.length
    });
  }

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

  // 승인 권한 부여·회수 — 총관리자 전용. 직급과 무관하게 사람에게 붙인다.
  if (req.method === "POST" && path === "/admin/set-approver") {
    if (!me.is_admin) return send(res, 403, { error: "총관리자만 가능합니다." });
    const { 대상, 부여 } = await readJson(req);
    const target = getAccount(db, Number(대상));
    if (!target) return send(res, 404, { error: "대상 계정을 찾을 수 없습니다." });
    if (target.status !== "승인") return send(res, 400, { error: "승인된 계정에만 줄 수 있습니다." });
    setApprover(db, target.id, !!부여);
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
