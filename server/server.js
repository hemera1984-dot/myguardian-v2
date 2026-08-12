// 마이가디언 인증·승인 서버 (2차 공사 STEP 1)
//
// 원칙: 차단은 서버가 한다. 승인되지 않은 계정에는 데이터를 주지 않는다.
// 브라우저가 "로그인했다"고 주장하는 값은 신뢰하지 않는다 — 구글이 발급한 토큰을
// 구글에게 다시 물어 검증한 뒤에만 세션을 만든다.
//
// 외부 패키지를 쓰지 않는다 (Node 22+ 내장 http·sqlite·crypto·fetch).
// 서버에서 npm install 할 일이 없어 배포가 단순하다.

import { createServer } from "node:http";
import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  openDb, seedGrades, upsertAccount, createSession, accountForToken, deleteSession,
  listGrades, listPending, listMembers, getAccount, approve, suspend, setAdmin,
  setApprover, isDescendantOf, setDisplayName
} from "./db.js";
import { artworkSvg } from "./artwork.js";

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

// 강의 자료 라이브러리 — 팀이 함께 쓰는 발표 자료 목차(2026-08-05).
// 파일은 웹서버가 서빙하지 않는 전용 폴더에 둔다(2026-08-11 교정). 종전에는 사진과 같은
// /media/에 두어 주소만 알면 인증 없이 받아 갈 수 있었다 — 파일명 난수는 접근 권한이 아니다.
// 고객 개인정보가 담기는 상담 자료는 여기 올리지 않는다(화면이 강의 모드에서만 탑재를 연다).
const BRIEF_DIR = process.env.BRIEF_DIR || "./brief";
const BRIEF_LIST = join(BRIEF_DIR, "library.json");
const BRIEF_FILES = join(BRIEF_DIR, "files");
const BRIEF_TYPES = {
  "text/html": ".html",
  "application/pdf": ".pdf",
  "application/json": ".json",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif"
};
const MAX_BRIEF = 40 * 1024 * 1024;
// 총량·인당 상한 — 파일당 제한만 두면 반복 업로드로 디스크를 소진할 수 있다
const MAX_BRIEF_TOTAL = 4 * 1024 * 1024 * 1024;
const MAX_BRIEF_PER_ACCOUNT = 800 * 1024 * 1024;

// 형식별 시그니처 — 올린 쪽이 말하는 Content-Type만 믿지 않는다.
// 임의 바이트를 PDF·PNG로 위장해 두면 나중에 그 형식으로 다루는 코드가 오작동한다.
function 형식일치(ext, b) {
  if (!b.length) return false;
  if (ext === ".pdf") return b.slice(0, 5).toString("latin1") === "%PDF-";
  if (ext === ".png") return b.slice(0, 8).toString("hex") === "89504e470d0a1a0a";
  if (ext === ".jpg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (ext === ".gif") return b.slice(0, 6).toString("latin1").startsWith("GIF8");
  if (ext === ".webp") return b.slice(0, 4).toString("latin1") === "RIFF"
    && b.slice(8, 12).toString("latin1") === "WEBP";
  if (ext === ".json") {
    try { JSON.parse(b.toString("utf8")); return true; } catch (e) { return false; }
  }
  return true;  // html은 시그니처가 없다 — 대신 브라우저가 격리해서 연다
}

function readBriefLibrary() {
  try {
    const list = JSON.parse(readFileSync(BRIEF_LIST, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

// 자료 파일 저장 — 파일명은 서버가 만든다(올린 이름을 믿지 않는다)
function saveBriefFile(bytes, ext) {
  const name = new Date().toISOString().slice(0, 10).replace(/-/g, "")
    + "-" + randomBytes(6).toString("hex") + ext;
  writeFileSync(join(BRIEF_FILES, name), bytes);
  return { 파일명: name, 주소: "/brief/file/" + name, 크기: bytes.length };
}

// 목록에 실을 주소는 이 서버가 내준 것만 받는다.
// 접두사만 보면 /brief/file/%2e%2e/... 같은 것이 통과하므로 파일명 형식까지 확인한다.
const BRIEF_NAME = /^\d{8}-[0-9a-f]{12}\.[a-z]{3,4}$/;
function briefFileName(url) {
  const s = String(url || "");
  const at = s.lastIndexOf("/brief/file/");
  if (at < 0) return "";
  const name = s.slice(at + "/brief/file/".length);
  return BRIEF_NAME.test(name) ? name : "";
}

// 쌓인 용량 — 목록에 남은 파일 기준으로 센다
function briefUsage(email) {
  let 전체 = 0, 내것 = 0;
  for (const it of readBriefLibrary()) {
    const n = Number(it && it["크기"]) || 0;
    전체 += n;
    if (email && it && it["올린이메일"] === email) 내것 += n;
  }
  return { 전체, 내것 };
}

// 목록에서 내려간 자료의 실제 파일을 지운다
function 지우기(item) {
  for (const k of ["슬라이드주소", "스크립트주소"]) {
    const name = briefFileName(item && item[k]);
    if (!name) continue;
    try { unlinkSync(join(BRIEF_FILES, name)); } catch (e) { /* 이미 없으면 그만이다 */ }
  }
}

// 자료를 고치거나 지울 수 있는 사람 — 올린 본인, 또는 승인 권한을 가진 관리자
function canEditBrief(db, me, item) {
  if (!item) return true;
  if (item["올린이메일"] && item["올린이메일"] === me.email) return true;
  return canApprove(db, me);
}

// 미디어 파일 저장 — 파일명은 서버가 만든다(올린 이름을 믿지 않는다)
function saveMedia(bytes, ext) {
  const name = new Date().toISOString().slice(0, 10).replace(/-/g, "")
    + "-" + randomBytes(6).toString("hex") + ext;
  writeFileSync(join(MEDIA_DIR, name), bytes);
  return {
    파일명: name,
    주소: (MEDIA_BASE ? MEDIA_BASE.replace(/\/$/, "") + "/" : "/media/") + name,
    크기: bytes.length
  };
}

mkdirSync(MEDIA_DIR, { recursive: true });
mkdirSync(CARE_ISSUES_DIR, { recursive: true });
mkdirSync(BRIEF_DIR, { recursive: true });
mkdirSync(BRIEF_FILES, { recursive: true });

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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
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

  // ── 케어 발행 AI (2026-08-02, v1 기능 복구) ─────────────────────────────
  // 공통 호출부. 외부 패키지를 쓰지 않는 서버라 공식 SDK 대신 원시 HTTP를 쓴다.
  async function claude(prompt, schema, opts) {
    const o = opts || {};
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: TITLE_MODEL,
        max_tokens: o.maxTokens || 2000,
        output_config: {
          effort: o.effort || "low",
          format: { type: "json_schema", schema: schema }
        },
        messages: [{ role: "user", content: prompt }]
      }),
      signal: AbortSignal.timeout(o.timeout || 60000)
    });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      console.error("AI 호출 실패:", upstream.status, detail.slice(0, 300));
      return { error: 502 };
    }
    const data = await upstream.json();
    if (data.stop_reason === "refusal") return { error: 422 };
    const textBlock = (data.content || []).find((b) => b.type === "text");
    try { return { value: JSON.parse(textBlock.text) }; } catch (e) { return { error: 502 }; }
  }

  // 칼럼별 필자 페르소나 — 같은 사람이 쓴 듯한 균질한 톤을 피한다.
  // 경제면은 경제 전문가가, 사회면은 사회 전문가가 쓴 글처럼 읽혀야 한다(2026-08-03 사용자 지시).
  function 필자(카테고리) {
    const c = String(카테고리 || "");
    if (/정치|사회|시사/.test(c)) {
      return [
        "필자는 사회부에서 오래 일한 기자다.",
        "사실관계를 먼저 정리하고, 누가 무엇을 결정했으며 그 결정이 누구에게 어떻게 닿는지를 따라간다.",
        "이해관계자를 균형 있게 다루고 어느 편도 들지 않는다. 단정보다 확인된 사실과 그 함의를 쓴다."
      ].join(" ");
    }
    if (/경제|금융|증권|부동산|AI|IT|산업|기술/.test(c)) {
      return [
        "필자는 경제 애널리스트다.",
        "현상보다 구조를 본다 — 왜 이 일이 일어났고 어디로 파급되는지, 앞뒤 인과를 짚는다.",
        "숫자를 다룰 때는 그 숫자가 무엇을 뜻하는지까지 설명한다. 전망은 근거와 함께, 단정은 피한다."
      ].join(" ");
    }
    if (/보험|보장|청구|연금|세무|상속|증여/.test(c)) {
      return [
        "필자는 현직 보험 설계사다.",
        "제도나 약관을 설명할 때 그것이 고객의 실제 상황에서 어떻게 작동하는지로 풀어낸다.",
        "실무에서 자주 부딪히는 오해를 짚되, 특정 상품을 권유하지 않는다."
      ].join(" ");
    }
    return [
      "필자는 해당 분야를 오래 다뤄 온 전문 필자다.",
      "주제의 맥락을 먼저 세우고, 독자가 알아야 할 것을 순서대로 짚는다."
    ].join(" ");
  }

  // 칼럼 성격 — 채널로 무엇을 쓸 자리인지 정한다.
  // 일일은 오늘의 경제·시사 한 꼭지, 주간은 보험·자산·세무, 월간은 자유 주제다
  // (2026-08-05 채널 역할 분리 — 일일과 주간이 같은 소재를 다루면 주간이 재탕이 된다).
  function 칼럼성격(채널, 카테고리) {
    const c = String(카테고리 || "").trim();
    if (c) return c;
    const ch = String(채널 || "");
    if (ch.indexOf("월간") >= 0) return "자유 주제";
    if (ch.indexOf("일일") >= 0) return "경제";  // 데스크에서 경제·시사 중 고른다. 못 고른 때의 기본값
    return "보험·자산·세무";
  }

  // 주제 추천 — 제목을 아직 정하지 않았을 때
  if (req.method === "POST" && path === "/ai/topic") {
    if (!ANTHROPIC_KEY) return send(res, 503, { error: "AI 기능이 설정되지 않았습니다." });
    const body = await readJson(req);
    const 채널 = String(body["채널"] || "주간 안창민").slice(0, 40);
    const 카테고리 = 칼럼성격(채널, body["카테고리"]);
    const 지난주제 = Array.isArray(body["지난주제"]) ? body["지난주제"].slice(0, 20) : [];
    const 월간 = 채널.indexOf("월간") >= 0;

    const prompt = [
      `보험 설계사 안창민이 고객에게 보내는 뉴스레터 "${채널}"의 "${카테고리}" 칼럼 주제를 제안한다.`,
      월간
        ? "월간이라 한 주제를 깊게 파고든다. 흐름과 구조를 설명할 수 있는 큰 주제를 고른다."
        : "주간이라 최근 2주 안의 사안을 다룬다. 시의성이 우선이다.",
      지난주제.length ? "\n지난 호에서 다룬 주제(겹치지 않게 한다):\n- " + 지난주제.join("\n- ") : "",
      "",
      "조건:",
      "- 독자는 보험 고객이다. 전문 용어를 늘어놓지 않되 내용은 얕지 않게.",
      "- 사실관계가 분명한 사안만. 확인되지 않은 소문·전망은 주제로 삼지 않는다.",
      "- 특정 정당·정치인을 옹호하거나 비난하는 각도는 피한다.",
      "- 서로 다른 각도로 3개. 각각 제목과 한 줄 방향을 함께 낸다.",
      "- 이모지·영문 장식 표기 금지."
    ].join("\n");

    const r = await claude(prompt, {
      type: "object",
      properties: {
        후보: {
          type: "array",
          items: {
            type: "object",
            properties: { 제목: { type: "string" }, 방향: { type: "string" } },
            required: ["제목", "방향"],
            additionalProperties: false
          }
        }
      },
      required: ["후보"],
      additionalProperties: false
    }, { effort: "medium", maxTokens: 3000 });

    if (r.error === 422) return send(res, 422, { error: "이 조건으로는 주제를 제안할 수 없습니다." });
    if (r.error) return send(res, 502, { error: "주제를 받아오지 못했습니다. 잠시 후 다시 시도하세요." });
    return send(res, 200, { 후보: (r.value["후보"] || []).slice(0, 3) });
  }

  // 본문 생성 — v1의 핵심 기능. 제목에서 본문·요약·부제까지.
  // 본문은 지면 렌더러가 쓰는 블록 배열로 받는다: [{t:"h"|"p", x:"..."}]
  if (req.method === "POST" && path === "/ai/column") {
    if (!ANTHROPIC_KEY) return send(res, 503, { error: "AI 기능이 설정되지 않았습니다." });
    const body = await readJson(req);
    const 제목 = String(body["제목"] || "").trim();
    if (!제목) return send(res, 400, { error: "제목을 입력하세요." });
    if (제목.length > 200) return send(res, 400, { error: "제목이 너무 깁니다." });
    const 채널 = String(body["채널"] || "주간 안창민").slice(0, 40);
    const 카테고리 = 칼럼성격(채널, body["카테고리"]);
    const 방향 = String(body["방향"] || "").slice(0, 500);
    const 월간 = 채널.indexOf("월간") >= 0;
    const 일일 = 채널.indexOf("일일") >= 0;
    const 분량 = 월간 ? "8000자에서 10000자" : 일일 ? "700자에서 1200자" : "1800자에서 2800자";
    const 결 = 월간
      ? "월간이므로 배경·현황·전망·시사점을 두루 짚고, 소제목으로 흐름을 나눈다."
      : 일일
        ? "일일이므로 오늘 하나만 다룬다. 소제목 없이 세 문단 안팎으로 쓰고, 배경 설명은 최소로 줄인다."
        : "주간이므로 핵심을 빠르게 전달한다.";

    const prompt = [
      `잡지 "${채널}"의 "${카테고리}" 칼럼 본문을 쓴다.`,
      필자(카테고리),
      `제목: ${제목}`,
      방향 ? `방향: ${방향}` : "",
      "",
      `분량: 본문 합계 ${분량}. ${결}`,
      "",
      "조건:",
      "- 독자는 보험 고객이다. 설명은 쉽게, 내용은 얕지 않게.",
      "- **확인되지 않은 수치·통계·발언을 지어내지 않는다.** 확실하지 않으면 수치를 쓰지 말고 서술로 대체한다.",
      "- 특정 정당·정치인을 옹호하거나 비난하지 않는다. 세금·투자 권유로 읽힐 표현을 쓰지 않는다.",
      "- 문체는 평서형 존댓말. 이모지·영문 장식 표기·과장된 수식 금지.",
      "- 마지막 문단은 보험 설계사의 시각으로 독자에게 주는 시사점으로 맺는다.",
      "",
      "출력 형식:",
      "- 카테고리: 이 글이 어느 꼭지인지 2~6자 라벨. 예: 시사, 경제, 보험, 자산, 세무, 건강.",
      "- 부제: 제목을 보완하는 한 줄.",
      "- 요약: 150자에서 200자. 서재 카드에 실린다.",
      "- 본문: 블록 배열. t가 h면 소제목, p면 문단이다. 소제목으로 흐름을 나눈다.",
      "- 한마디: 설계사가 덧붙이는 한 문장."
    ].filter(Boolean).join("\n");

    const r = await claude(prompt, {
      type: "object",
      properties: {
        카테고리: { type: "string" },
        부제: { type: "string" },
        요약: { type: "string" },
        한마디: { type: "string" },
        본문: {
          type: "array",
          items: {
            type: "object",
            properties: { t: { type: "string", enum: ["h", "p"] }, x: { type: "string" } },
            required: ["t", "x"],
            additionalProperties: false
          }
        }
      },
      required: ["카테고리", "부제", "요약", "한마디", "본문"],
      additionalProperties: false
    }, { effort: 월간 ? "high" : "medium", maxTokens: 월간 ? 32000 : 12000, timeout: 300000 });

    if (r.error === 422) return send(res, 422, { error: "이 제목으로는 본문을 쓸 수 없습니다." });
    if (r.error) return send(res, 502, { error: "본문을 받아오지 못했습니다. 잠시 후 다시 시도하세요." });
    return send(res, 200, r.value);
  }

  // 이미지 프롬프트 — 표지·칼럼 그림을 생성기에 넣을 지시문으로 만들어 준다.
  // 사진을 찾아 헤매는 시간을 없애는 것이 목적이고, 저작권 시비가 없는 생성 이미지를 전제로 한다(헌법).
  if (req.method === "POST" && path === "/ai/imgprompt") {
    if (!ANTHROPIC_KEY) return send(res, 503, { error: "AI 기능이 설정되지 않았습니다." });
    const body = await readJson(req);
    const 종류 = String(body["종류"] || "칼럼");           // 표지 | 칼럼
    const 채널 = String(body["채널"] || "월간 안창민").slice(0, 40);
    const 제목 = String(body["제목"] || "").slice(0, 200);
    const 요약 = String(body["요약"] || "").slice(0, 800);
    const 제목들 = (Array.isArray(body["제목들"]) ? body["제목들"] : []).slice(0, 5)
      .map((t) => String(t).slice(0, 200)).filter(Boolean);
    if (종류 === "표지" ? !제목들.length : !제목) {
      return send(res, 400, { error: 종류 === "표지" ? "칼럼 제목이 먼저 필요합니다." : "제목이 먼저 필요합니다." });
    }

    const 양식 = [
      "이 잡지의 지면 양식은 바우하우스다: 삼원색(빨강 #E63329, 파랑 #005BBB, 노랑 #F5C518)과",
      "검정·아이보리, 원·사각·삼각 같은 기하 도형, 평면적이고 절제된 구성.",
      "사진이 아니라 그래픽·일러스트 계열이어야 지면과 어울린다."
    ].join(" ");

    const prompt = 종류 === "표지"
      ? [
          `보험 설계사가 발행하는 잡지 "${채널}"의 표지 이미지를 만들 프롬프트를 쓴다.`,
          "이번 호 칼럼:", ...제목들.map((t) => "- " + t), "",
          양식,
          "",
          "조건:",
          "- 이미지 생성기에 그대로 넣을 지시문. 영어로 쓴다(생성기가 영어에 더 정확하다).",
          "- 특정 인물·실존 브랜드·로고·글자를 넣지 않는다(글자는 지면에서 얹는다).",
          "- 세로 판형(3:4)에 맞는 구도.",
          "- 한 줄 요약(한국어)도 함께 준다 — 무엇을 그리려는 것인지."
        ].join("\n")
      : [
          `잡지 "${채널}"에 실릴 칼럼의 삽화 프롬프트를 쓴다.`,
          `칼럼 제목: ${제목}`,
          요약 ? `요약: ${요약}` : "",
          "",
          양식,
          "",
          "조건:",
          "- 이미지 생성기에 그대로 넣을 지시문. 영어로 쓴다.",
          "- 글의 주제를 상징적으로 표현한다. 도표·설명 그림이 아니라 편집 삽화.",
          "- 특정 인물·실존 브랜드·로고·글자를 넣지 않는다.",
          "- 가로 판형(16:9 또는 4:3)에 맞는 구도.",
          "- 한 줄 요약(한국어)도 함께 준다."
        ].filter(Boolean).join("\n");

    const r = await claude(prompt, {
      type: "object",
      properties: {
        프롬프트: { type: "string" },
        설명: { type: "string" }
      },
      required: ["프롬프트", "설명"],
      additionalProperties: false
    }, { effort: "low", maxTokens: 2000 });

    if (r.error === 422) return send(res, 422, { error: "이 내용으로는 프롬프트를 만들 수 없습니다." });
    if (r.error) return send(res, 502, { error: "프롬프트를 받아오지 못했습니다." });
    return send(res, 200, r.value);
  }

  // 삽화 생성 — 이미지 생성 API 없이 지면 삽화를 만든다.
  // AI에게 도형 배치(0~100 상대좌표)만 받고 SVG 조립·저장은 서버가 한다.
  // 만들어진 파일은 업로드한 사진과 똑같이 /media/에 놓이므로 지면·서재·카톡이 그대로 쓴다.
  if (req.method === "POST" && path === "/ai/artwork") {
    if (!ANTHROPIC_KEY) return send(res, 503, { error: "AI 기능이 설정되지 않았습니다." });
    const body = await readJson(req);
    const 종류 = body["종류"] === "표지" ? "표지" : "칼럼";
    const 채널 = String(body["채널"] || "월간 안창민").slice(0, 40);
    const 제목 = String(body["제목"] || "").slice(0, 200);
    const 요약 = String(body["요약"] || "").slice(0, 800);
    const 카테고리 = String(body["카테고리"] || "").slice(0, 40);
    const 제목들 = (Array.isArray(body["제목들"]) ? body["제목들"] : []).slice(0, 5)
      .map((t) => String(t).slice(0, 200)).filter(Boolean);
    if (종류 === "표지" ? !제목들.length : !제목) {
      return send(res, 400, { error: 종류 === "표지" ? "칼럼 제목이 먼저 필요합니다." : "제목이 먼저 필요합니다." });
    }

    const prompt = [
      종류 === "표지"
        ? `잡지 "${채널}" 표지의 추상 그래픽을 구성한다. 세로 판형(3:4)이다.`
        : `잡지 "${채널}"에 실릴 칼럼 삽화를 구성한다. 가로 판형(16:9)이다.`,
      종류 === "표지" ? "이번 호 칼럼:" : `칼럼 제목: ${제목}`,
      ...(종류 === "표지" ? 제목들.map((t) => "- " + t) : []),
      종류 !== "표지" && 카테고리 ? `분야: ${카테고리}` : "",
      종류 !== "표지" && 요약 ? `요약: ${요약}` : "",
      "",
      "양식은 바우하우스다. 원·사각·삼각을 삼원색으로 배치한 평면 구성이고,",
      "글의 주제를 상징적으로 담되 도표나 설명 그림이 아니다.",
      "",
      "규칙:",
      "- 배경 1색, 도형 3~6개.",
      "- 좌표 x·y는 도형 왼쪽 위 모서리, 크기 w·h는 화면 대비 백분율(0~100)이다.",
      "- 화면 밖으로 일부 걸쳐 나가는 큰 도형을 하나 두어 시원하게 만든다(음수·100 초과 좌표 허용).",
      "- 큰 도형 1개, 중간 1~2개, 작은 것 나머지로 크기를 확실히 다르게 한다. 격자처럼 늘어놓지 않는다.",
      "- 배경과 명도 차이가 큰 색을 골라 도형이 묻히지 않게 한다.",
      "- 회전은 사각·삼각에만 의미가 있다(원은 무시된다). 쓰지 않으면 0.",
      "- 의도는 무엇을 어떻게 상징했는지 한국어 한 줄."
    ].filter(Boolean).join("\n");

    const r = await claude(prompt, {
      type: "object",
      properties: {
        배경: { type: "string", enum: ["종이", "노랑", "파랑", "빨강", "잉크"] },
        도형: {
          type: "array",
          items: {
            type: "object",
            properties: {
              형: { type: "string", enum: ["원", "사각", "삼각"] },
              x: { type: "number" }, y: { type: "number" },
              w: { type: "number" }, h: { type: "number" },
              색: { type: "string", enum: ["빨강", "파랑", "노랑", "잉크", "종이"] },
              회전: { type: "number" }
            },
            required: ["형", "x", "y", "w", "h", "색", "회전"],
            additionalProperties: false
          }
        },
        의도: { type: "string" }
      },
      required: ["배경", "도형", "의도"],
      additionalProperties: false
    }, { effort: "low", maxTokens: 2000 });

    if (r.error === 422) return send(res, 422, { error: "이 내용으로는 삽화를 만들 수 없습니다." });
    if (r.error) return send(res, 502, { error: "삽화를 만들지 못했습니다. 잠시 후 다시 시도하세요." });
    if (!Array.isArray(r.value["도형"]) || !r.value["도형"].length) {
      return send(res, 502, { error: "삽화 구성이 비어 있습니다. 다시 시도하세요." });
    }
    const info = saveMedia(Buffer.from(artworkSvg(r.value, 종류), "utf8"), ".svg");
    return send(res, 200, { ...info, 의도: String(r.value["의도"] || "") });
  }

  // 편집장의 말 — 확정된 칼럼 제목들을 보고 서문을 쓴다
  if (req.method === "POST" && path === "/ai/preface") {
    if (!ANTHROPIC_KEY) return send(res, 503, { error: "AI 기능이 설정되지 않았습니다." });
    const body = await readJson(req);
    const 채널 = String(body["채널"] || "주간 안창민").slice(0, 40);
    const 호수 = String(body["호수"] || "").slice(0, 20);
    const 제목들 = (Array.isArray(body["제목들"]) ? body["제목들"] : []).slice(0, 5)
      .map((t) => String(t).slice(0, 200)).filter(Boolean);
    if (!제목들.length) return send(res, 400, { error: "칼럼 제목이 먼저 필요합니다." });

    const prompt = [
      `보험 설계사 안창민이 발행하는 "${채널}" ${호수 ? 호수 + "호 " : ""}편집장의 말을 쓴다.`,
      "이번 호 칼럼:",
      ...제목들.map((t) => "- " + t),
      "",
      "조건:",
      "- 3문단에서 4문단, 합계 350자에서 500자.",
      "- 이번 호를 왜 이렇게 구성했는지 자연스럽게 풀어낸다. 목차를 나열하지 않는다.",
      "- 평서형 존댓말. 이모지·영문 장식 표기·과장된 수식 금지.",
      "- 없는 사실을 지어내지 않는다.",
      "- 문단 배열로 낸다."
    ].join("\n");

    const r = await claude(prompt, {
      type: "object",
      properties: { 문단: { type: "array", items: { type: "string" } } },
      required: ["문단"],
      additionalProperties: false
    }, { effort: "medium", maxTokens: 3000 });

    if (r.error === 422) return send(res, 422, { error: "서문을 쓸 수 없습니다." });
    if (r.error) return send(res, 502, { error: "서문을 받아오지 못했습니다." });
    return send(res, 200, { 문단: r.value["문단"] || [] });
  }

  // ── 발행 전 사실검증 (2026-08-03) ────────────────────────────────────
  // 본문을 쓰는 AI에게는 웹이 없어 수치를 확인할 방법이 없다. 그래서 발행 직전에
  // 웹 검색을 켠 채로 한 번 더 읽히고, 틀린 곳을 고쳐 돌려준다.
  // claude()는 구조화 출력만 다루므로 도구를 붙이는 이 호출은 따로 둔다(원시 HTTP는 동일).
  async function claudeWeb(prompt, schema, opts) {
    const o = opts || {};
    let messages = [{ role: "user", content: prompt }];
    // 검색이 실제로 돌았는지 남긴다 — 질의와 출처를 응답에 실어 보고에 쓴다.
    const 질의 = [];
    const 출처 = [];
    function 수확(content) {
      (content || []).forEach((b) => {
        if (b.type === "server_tool_use" && b.name === "web_search" && b.input && b.input.query) {
          if (질의.indexOf(b.input.query) < 0) 질의.push(String(b.input.query).slice(0, 200));
        }
        if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
          b.content.forEach((r) => {
            if (r && r.url && !출처.some((x) => x.url === r.url)) {
              출처.push({ url: String(r.url).slice(0, 400), 제목: String(r.title || "").slice(0, 200) });
            }
          });
        }
      });
    }
    // 서버 도구는 API가 알아서 돌린다. 다만 도구 반복 한도에 걸리면 pause_turn으로
    // 끊기므로 그때는 응답을 그대로 붙여 다시 보낸다(공식 재개 방식).
    for (let turn = 0; turn < 4; turn++) {
      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: TITLE_MODEL,
          max_tokens: o.maxTokens || 16000,
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: o.maxUses || 8 }],
          output_config: {
            effort: o.effort || "medium",
            format: { type: "json_schema", schema: schema }
          },
          messages: messages
        }),
        signal: AbortSignal.timeout(o.timeout || 600000)
      });
      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => "");
        console.error("검증 호출 실패:", upstream.status, detail.slice(0, 300));
        return { error: 502 };
      }
      const data = await upstream.json();
      수확(data.content);
      if (data.stop_reason === "refusal") return { error: 422 };
      if (data.stop_reason === "pause_turn") {
        messages = [messages[0], { role: "assistant", content: data.content }];
        continue;
      }
      const texts = (data.content || []).filter((b) => b.type === "text");
      const last = texts[texts.length - 1];
      try { return { value: JSON.parse(last.text), 질의, 출처 }; } catch (e) { return { error: 502 }; }
    }
    return { error: 504 };
  }

  const 검증종류 = ["수치", "사실", "단정", "정치", "컴플라이언스", "표기"];

  if (req.method === "POST" && path === "/ai/verify") {
    if (!ANTHROPIC_KEY) return send(res, 503, { error: "AI 기능이 설정되지 않았습니다." });
    const body = await readJson(req, 2 * 1024 * 1024);
    const 채널 = String(body["채널"] || "주간 안창민").slice(0, 40);
    const 호수 = String(body["호수"] || "").slice(0, 20);
    const 기사 = (Array.isArray(body["기사"]) ? body["기사"] : []).slice(0, 5);
    if (!기사.length) return send(res, 400, { error: "검증할 기사가 없습니다." });

    const schema = {
      type: "object",
      properties: {
        결과: {
          type: "array",
          items: {
            type: "object",
            properties: {
              위치: { type: "integer" },
              종류: { type: "string", enum: 검증종류 },
              원문: { type: "string" },
              문제: { type: "string" },
              조치: { type: "string", enum: ["수정", "삭제", "유지"] },
              수정문: { type: "string" },
              확신도: { type: "string", enum: ["높음", "보통", "낮음"] },
              근거: { type: "string" }
            },
            required: ["위치", "종류", "원문", "문제", "조치", "수정문", "확신도", "근거"],
            additionalProperties: false
          }
        },
        요약: { type: "string" }
      },
      required: ["결과", "요약"],
      additionalProperties: false
    };

    const jobs = 기사.map(async (a, idx) => {
      const 번호 = Number(a["번호"]) || idx + 1;
      const blocks = (Array.isArray(a["본문"]) ? a["본문"] : []).slice(0, 200)
        .map((b) => ({ t: b && b.t === "h" ? "h" : "p", x: String((b && b.x) || "") }));
      if (!blocks.length) return { 번호, 결과: [], 요약: "본문이 비어 있어 검증하지 않았습니다." };

      const prompt = [
        `보험 설계사가 고객에게 보내는 뉴스레터 "${채널}${호수 ? " " + 호수 + "호" : ""}"에 실릴 기사를 발행 직전에 검증한다.`,
        "웹 검색으로 사실관계를 직접 확인해라. 기억에 의존하지 마라.",
        "",
        `제목: ${String(a["제목"] || "").slice(0, 200)}`,
        a["부제"] ? `부제: ${String(a["부제"]).slice(0, 300)}` : "",
        a["카테고리"] ? `분야: ${String(a["카테고리"]).slice(0, 40)}` : "",
        "",
        "본문 블록(대괄호 안 숫자가 위치다. h는 소제목, p는 문단):",
        ...blocks.map((b, i) => `[${i}] (${b.t}) ${b.x}`),
        "",
        "검사 항목:",
        "1. 수치·통계·인용 — 그런 발표·자료가 실제로 있는지, 숫자가 맞는지 웹에서 확인한다.",
        "2. 날짜·이름·기관 — 사실 오류가 있는지 확인한다.",
        "3. 근거 없는 단정 — 확인할 수 없는 주장을 사실처럼 서술한 곳.",
        "4. 정치 편향 — 특정 정당·정치인을 옹호하거나 비난하는 서술.",
        "5. 컴플라이언스 — 투자·세무 권유로 읽힐 표현, 특정 상품 권유.",
        "6. 표기 — 이모지, AI 말투(\"~해 드릴게요\", \"물론입니다\"), 은유 표현.",
        "",
        "규칙:",
        "- 원문에는 해당 블록 안에 있는 문장을 **한 글자도 바꾸지 말고** 그대로 옮겨 적어라.",
        "  본문에 없는 문장을 적으면 그 지적은 버려진다.",
        "- **확신이 서지 않으면 조치를 \"유지\"로 하고 문제만 알려라.** 검증이 틀렸는데 멀쩡한 문장을",
        "  망가뜨리는 것이 최악이다.",
        "- 수치가 애매하면 수치를 빼고 서술로 바꾸는 쪽을 택한다(확실하지 않으면 수치를 쓰지 않는다).",
        "- 수정문은 원문을 그대로 대신할 문장이다. 평서형 존댓말과 앞뒤 흐름을 유지하고 문제가 된 곳만 고친다.",
        "- 조치가 \"삭제\"면 수정문은 빈 문자열로 둔다.",
        "- 문제가 없으면 결과를 빈 배열로 낸다. 억지로 찾아내지 마라.",
        "- **근거에는 웹에서 실제로 확인한 출처를 적는다** — 발표 기관·날짜·매체명, 있으면 주소까지.",
        "  검색해도 확인하지 못했으면 \"웹에서 확인하지 못함\"이라고 적고 조치는 \"유지\"로 둔다.",
        "- 지적할 곳이 없더라도 수치·인용이 있으면 반드시 검색해서 맞는지 확인한 뒤 판단해라.",
        "- 요약은 이 기사의 검증 결과를 한두 문장으로 적는다."
      ].filter(Boolean).join("\n");

      const r = await claudeWeb(prompt, schema, { effort: "medium", maxTokens: 16000, maxUses: 10 });
      if (r.error) return { 번호, 오류: true, 결과: [], 요약: "검증하지 못했습니다." };

      // 서버가 한 번 더 거른다 — 원문이 실제로 본문에 있어야 자동 수정을 허용한다.
      const 결과 = (Array.isArray(r.value["결과"]) ? r.value["결과"] : []).slice(0, 20).map((f) => {
        const 원문 = String(f["원문"] || "");
        let 위치 = Number.isInteger(f["위치"]) ? f["위치"] : -1;
        if (!(위치 >= 0 && 위치 < blocks.length) || blocks[위치].x.indexOf(원문) < 0) {
          위치 = 원문 ? blocks.findIndex((b) => b.x.indexOf(원문) >= 0) : -1;
        }
        let 조치 = f["조치"];
        const 확신도 = f["확신도"];
        const 수정문 = String(f["수정문"] || "");
        // 찾을 수 없는 원문·확신도 낮음·빈 수정문은 손대지 않는다(경고만).
        if (!원문 || 위치 < 0) 조치 = "유지";
        if (확신도 === "낮음") 조치 = "유지";
        if (조치 === "수정" && !수정문.trim()) 조치 = "유지";
        return {
          기사번호: 번호,
          위치: 위치,
          종류: 검증종류.indexOf(f["종류"]) >= 0 ? f["종류"] : "사실",
          원문: 원문,
          문제: String(f["문제"] || ""),
          조치: 조치,
          수정문: 조치 === "삭제" ? "" : 수정문,
          확신도: ["높음", "보통", "낮음"].indexOf(확신도) >= 0 ? 확신도 : "낮음",
          근거: String(f["근거"] || ""),
          적용가능: 위치 >= 0 && !!원문
        };
      });
      return { 번호, 결과, 요약: String(r.value["요약"] || ""), 질의: r.질의 || [], 출처: r.출처 || [] };
    });

    const 결과들 = await Promise.all(jobs);
    const 검증 = 결과들.flatMap((x) => x.결과);
    const 질의 = [...new Set(결과들.flatMap((x) => x.질의 || []))];
    const 출처 = [];
    결과들.forEach((x) => (x.출처 || []).forEach((s) => {
      if (!출처.some((y) => y.url === s.url)) 출처.push(s);
    }));
    const 실패 = 결과들.filter((x) => x.오류).map((x) => x.번호);
    const 고침 = 검증.filter((f) => f.조치 !== "유지").length;
    const 요약 = [
      실패.length ? `${실패.join("·")}번 칼럼은 검증하지 못했습니다.` : "",
      질의.length ? `웹에서 ${질의.length}건을 검색해 ${출처.length}개 자료를 확인했습니다.`
        : "웹 검색이 이루어지지 않았습니다.",
      고침 ? `${고침}곳을 고쳤습니다.` : "고칠 곳은 없었습니다.",
      검증.length - 고침 ? `${검증.length - 고침}곳은 확인만 필요합니다.` : ""
    ].filter(Boolean).join(" ");
    console.log(`검증: ${채널} ${호수}호 — 검색 ${질의.length}건 / 지적 ${검증.length}건 / 자동수정 ${고침}건 — ${me.email}`);
    return send(res, 200, { 검증, 요약, 실패, 질의, 출처: 출처.slice(0, 40) });
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
    if (["일일", "주간", "월간"].indexOf(목록항목["채널"]) < 0) {
      return send(res, 400, { error: "채널은 일일·주간·월간 중 하나여야 합니다." });
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

  // ── 강의 자료 라이브러리 (팀 공유) ───────────────────────────────────────
  // 종전에는 브라우저 IndexedDB에만 쌓여 올린 사람만 볼 수 있었다. 팀 플랫폼이므로
  // 승인 계정이면 누구나 목록을 보고 발표할 수 있어야 한다(2026-08-05 사용자 지시).
  // 상담 자료는 여기 올리지 않는다 — 화면이 이미 강의 모드에서만 탑재를 연다.
  if (req.method === "GET" && path === "/brief/library") {
    return send(res, 200, readBriefLibrary());
  }

  // 자료 파일 내려받기. 파일은 웹서버가 서빙하지 않는 폴더에 있으므로 이 경로가 유일한 출구다.
  // 승인 계정만 받아 갈 수 있고, CORS도 여기서 붙는다.
  const briefFile = req.method === "GET" && /^\/brief\/file\/([A-Za-z0-9._-]+)$/.exec(path);
  if (briefFile) {
    const name = briefFile[1];
    if (!BRIEF_NAME.test(name)) return send(res, 400, { error: "잘못된 파일명입니다." });
    let bytes;
    try {
      bytes = readFileSync(join(BRIEF_FILES, name));
    } catch (e) {
      return send(res, 404, { error: "없는 파일입니다." });
    }
    const ext = "." + name.split(".").pop().toLowerCase();
    const type = Object.keys(BRIEF_TYPES).find((k) => BRIEF_TYPES[k] === ext) || "application/octet-stream";
    // 다른 기기에서 자료가 안 열릴 때 어디서 끊겼는지 보려면 이 줄이 필요하다
    console.log(`강의자료 내려받기: ${name} (${bytes.length}바이트) — ${me.email}`);
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": bytes.length,
      // 브라우저가 이 응답을 스스로 해석해 실행하지 않게 한다. 화면은 blob으로 다시 만들어 연다.
      "Content-Disposition": "attachment",
      "X-Content-Type-Options": "nosniff"
    });
    return res.end(bytes);
  }

  // 자료 파일 업로드. 슬라이드·스크립트를 각각 올리고 받은 주소를 레코드에 싣는다.
  if (req.method === "POST" && path === "/brief/file") {
    const type = String(req.headers["content-type"] || "").split(";")[0].trim();
    const ext = BRIEF_TYPES[type];
    if (!ext) return send(res, 400, { error: "지원하지 않는 형식입니다. (HTML·PDF·JSON·이미지)" });
    const 쓴양 = briefUsage(me.email);
    if (쓴양.전체 >= MAX_BRIEF_TOTAL) return send(res, 507, { error: "저장 공간이 가득 찼습니다. 지난 자료를 지우고 다시 시도하세요." });
    if (쓴양.내것 >= MAX_BRIEF_PER_ACCOUNT) return send(res, 507, { error: "올릴 수 있는 용량을 넘었습니다. 올린 자료를 지우고 다시 시도하세요." });
    const bytes = await readBytes(req, MAX_BRIEF);
    if (!bytes.length) return send(res, 400, { error: "빈 파일입니다." });
    if (!형식일치(ext, bytes)) return send(res, 400, { error: "파일 내용이 형식과 맞지 않습니다." });
    return send(res, 200, saveBriefFile(bytes, ext));
  }

  if (req.method === "POST" && path === "/brief/library") {
    const 항목 = await readJson(req, 256 * 1024);
    if (!항목 || typeof 항목 !== "object" || Array.isArray(항목)) {
      return send(res, 400, { error: "형식 오류: 자료 항목 객체가 필요합니다." });
    }
    const id = String(항목.id || "");
    if (!/^[A-Za-z0-9가-힣ㄱ-ㅎㅏ-ㅣ_-]{1,80}$/.test(id)) {
      return send(res, 400, { error: "id 형식 오류입니다." });
    }
    if (!String(항목["제목"] || "").trim()) return send(res, 400, { error: "제목이 비어 있습니다." });
    // 주소는 이 서버가 내준 것만 받는다. 접두사만 보면 %2e%2e 같은 것이 통과하므로
    // 파일명 형식까지 확인하고, 목록에는 검증된 이름으로 다시 지어 넣는다.
    const 주소 = {};
    for (const k of ["슬라이드주소", "스크립트주소"]) {
      if (항목[k] === undefined) continue;
      const name = briefFileName(항목[k]);
      if (!name) return send(res, 400, { error: k + "가 이 서버의 자료 주소가 아닙니다." });
      주소[k] = "/brief/file/" + name;
    }
    const list = readBriefLibrary();
    const 기존 = list.find((x) => x && String(x.id) === id);
    // 남의 자료를 말없이 덮어쓰지 못하게 한다. 올린 본인이거나 승인 권한이 있어야 한다.
    if (기존 && !canEditBrief(db, me, 기존)) {
      return send(res, 403, { error: "다른 사람이 올린 자료입니다. 올린 사람만 바꿀 수 있습니다." });
    }
    // 목록에는 사람 이름을 보이고, 소유 판정에 쓸 메일은 따로 둔다.
    const entry = {
      ...항목,
      ...주소,
      id,  // 검사한 문자열로 통일한다 — 숫자로 들어오면 이후 비교가 어긋난다
      "올린이": (me.name || "").trim() || String(me.email).split("@")[0],
      "올린이메일": me.email,
      "등록일": new Date().toISOString()
    };
    const 남길것 = list.filter((x) => x && String(x.id) !== id);
    // 덮어쓰는 경우 이전 파일은 지운다 — 안 지우면 쓰레기가 쌓이고 용량 계산이 어긋난다
    if (기존) 지우기(기존);
    남길것.unshift(entry);
    atomicWrite(BRIEF_LIST, JSON.stringify(남길것, null, 1));
    console.log(`강의자료 탑재: ${entry["제목"]} (${id}) — ${me.email}`);
    return send(res, 200, { ok: true, id });
  }

  const briefDel = req.method === "DELETE" && /^\/brief\/library\/(.+)$/.exec(path);
  if (briefDel) {
    const id = decodeURIComponent(briefDel[1]);
    const list = readBriefLibrary();
    const gone = list.find((x) => x && String(x.id) === id);
    if (!gone) return send(res, 404, { error: "없는 자료입니다." });
    if (!canEditBrief(db, me, gone)) {
      return send(res, 403, { error: "다른 사람이 올린 자료입니다. 올린 사람만 지울 수 있습니다." });
    }
    지우기(gone);  // 목록만 지우면 파일이 남아 용량을 먹는다
    atomicWrite(BRIEF_LIST, JSON.stringify(list.filter((x) => x && String(x.id) !== id), null, 1));
    console.log(`강의자료 삭제: ${gone["제목"]} (${id}) — ${me.email}`);
    return send(res, 200, { ok: true });
  }

  // 지면 사진 업로드 — 승인된 계정이면 누구나(자기 호에 쓸 사진이다)
  if (req.method === "POST" && path === "/media/upload") {
    const type = String(req.headers["content-type"] || "").split(";")[0].trim();
    const ext = IMAGE_TYPES[type];
    if (!ext) return send(res, 400, { error: "지원하지 않는 형식입니다. (JPG·PNG·WebP·GIF)" });
    const bytes = await readBytes(req, MAX_IMAGE);
    if (!bytes.length) return send(res, 400, { error: "빈 파일입니다." });
    return send(res, 200, saveMedia(bytes, ext));
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

  // 이름 고치기 — 구글 계정의 표시 이름이 실제 이름과 다른 사람이 있다(별명·오기·영문).
  // 승인 권한을 가진 사람이면 고칠 수 있다. 빈 값으로 보내면 구글 이름으로 되돌린다.
  if (req.method === "POST" && path === "/admin/set-name") {
    if (!canApprove(db, me)) return send(res, 403, { error: "승인 권한이 없습니다." });
    const { 대상, 이름 } = await readJson(req);
    const target = getAccount(db, Number(대상));
    if (!target) return send(res, 404, { error: "대상 계정을 찾을 수 없습니다." });
    const v = String(이름 || "").trim();
    if (v.length > 40) return send(res, 400, { error: "이름이 너무 깁니다." });
    setDisplayName(db, target.id, v);
    console.log(`이름 고침: ${target.email} → ${v || "(구글 이름으로 되돌림)"} — ${me.email}`);
    return send(res, 200, { ok: true, "이름": v || target.name });
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
