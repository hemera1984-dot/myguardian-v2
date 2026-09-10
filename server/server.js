// 마이가디언 인증·승인 서버 (2차 공사 STEP 1)
//
// 원칙: 차단은 서버가 한다. 승인되지 않은 계정에는 데이터를 주지 않는다.
// 브라우저가 "로그인했다"고 주장하는 값은 신뢰하지 않는다 — 구글이 발급한 토큰을
// 구글에게 다시 물어 검증한 뒤에만 세션을 만든다.
//
// 외부 패키지를 쓰지 않는다 (Node 22+ 내장 http·sqlite·crypto·fetch).
// 서버에서 npm install 할 일이 없어 배포가 단순하다.

import { createServer } from "node:http";
import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv, scryptSync, timingSafeEqual } from "node:crypto";
import {
  openDb, seedGrades, upsertAccount, createSession, accountForToken, deleteSession,
  listGrades, listPending, listMembers, getAccount, approve, suspend, setAdmin,
  setApprover, isDescendantOf, setDisplayName, getDoc, setDoc,
  listClients, listClientStamps, putClient, deleteClient, clientCounts
} from "./db.js";
import { artworkSvg } from "./artwork.js";
import { chartSvg } from "./chart.js";

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
// 네이버 뉴스 검색 (NAVER API HUB). 앤트로픽 웹 검색은 색인이 늦어 당일 한국 기사를
// 못 물어온다 — 오늘 나온 기사로 칼럼을 쓰려면 이쪽이 필요하다(2026-08-23).
// 고객 레코드 보관 열쇠 (2026-08-31 — 잠금문구 폐지). 서버가 감싸고 푼다.
// 이 열쇠는 .env에만 있다 — DB 파일·백업·디스크 이미지가 통째로 새도 그것만으로는 안 읽힌다.
// 서버를 장악한 사람은 읽을 수 있다. 그 대가는 docs/decisions.md에 적어 두었다.
const DATA_KEY = (() => {
  const hex = process.env.MG_DATA_KEY || "";
  return /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, "hex") : null;
})();

// 레코드 하나를 감싼다 — iv.암호문.태그 (모두 base64)
function 레코드감싸기(obj) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", DATA_KEY, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return [iv.toString("base64"), ct.toString("base64"), c.getAuthTag().toString("base64")].join(".");
}

function 레코드풀기(str) {
  const [iv, ct, tag] = String(str).split(".");
  if (!iv || !ct || !tag) throw new Error("레코드 형식 오류");
  const d = createDecipheriv("aes-256-gcm", DATA_KEY, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8"));
}

// 총관리자 열람 비밀번호 — 남의 고객을 볼 때만 묻는다. 원문은 저장하지 않는다.
// OWASP 권고선(N=2^17). Node 기본 N=2^14보다 8배 무겁다. 메모리 상한을 함께 올려야 돈다.
const SCRYPT = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
function 비번해시(pw, salt, opt) {
  const o = opt || SCRYPT;
  return scryptSync(String(pw), salt, 32, o).toString("base64");
}

// 열람 비밀번호 틀린 횟수 (계정별). 서버가 사는 동안만 기억한다.
const 열람실패 = new Map();

const NAVER_ID = process.env.NAVER_CLIENT_ID || "";
const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET || "";

// 독자가 지면을 읽는 곳. 호별 표지 페이지(/r/<id>)가 여기로 넘긴다.
const SITE = (process.env.SITE_BASE || "https://app.insurguard.life").replace(/\/$/, "");

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
const MAX_BRIEF = 100 * 1024 * 1024;
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

// 목록이 깨졌는데 빈 목록으로 여기면 다음 탑재가 기존 목차를 통째로 덮는다.
// 아직 안 만들어진 것과 깨진 것을 구분한다 — 깨졌으면 막는 쪽으로 실패한다.
function readBriefLibrary() {
  if (!existsSync(BRIEF_LIST)) return [];
  const list = JSON.parse(readFileSync(BRIEF_LIST, "utf8"));
  if (!Array.isArray(list)) throw new Error("강의 자료 목록이 손상됐습니다.");
  return list;
}

// 자료 파일 저장 — 파일명은 서버가 만든다(올린 이름을 믿지 않는다)
function saveBriefFile(bytes, ext, email) {
  const name = new Date().toISOString().slice(0, 10).replace(/-/g, "")
    + "-" + randomBytes(6).toString("hex") + ext;
  writeFileSync(join(BRIEF_FILES, name), bytes);
  const owners = readOwners();
  owners[name] = email;
  writeOwners(owners);
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

// 파일 장부 — 어떤 파일을 누가 올렸는지 적어 둔다.
// 목록(library.json)만 보고 판단하면 목록에 오르지 않은 파일이 셈에서 빠지고,
// 남의 파일 주소를 자기 항목에 적어 넣어 남의 파일을 지우는 것도 막을 수 없다.
const BRIEF_OWNERS = join(BRIEF_DIR, "files.json");

// 장부를 못 읽으면 빈 장부로 여기지 않는다. 빈 장부로 여기면 모든 파일이 주인 미상이 되어
// 아무나 지울 수 있고 계정별 용량도 0이 된다 — 막는 쪽으로 실패해야 한다.
function readOwners() {
  if (!existsSync(BRIEF_OWNERS)) return {};       // 아직 한 번도 안 만들어졌다
  const m = JSON.parse(readFileSync(BRIEF_OWNERS, "utf8"));  // 깨졌으면 여기서 던진다
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("파일 장부가 손상됐습니다.");
  return m;
}

function writeOwners(m) {
  atomicWrite(BRIEF_OWNERS, JSON.stringify(m, null, 1));
}

// 쌓인 용량 — 실제 디스크를 센다. 클라이언트가 보낸 크기나 목록 등재 여부를 믿지 않는다.
function briefUsage(email) {
  const owners = readOwners();
  let 전체 = 0, 내것 = 0;
  let names = [];
  try { names = readdirSync(BRIEF_FILES); } catch (e) { return { 전체: 0, 내것: 0 }; }
  for (const name of names) {
    let size = 0;
    try { size = statSync(join(BRIEF_FILES, name)).size; } catch (e) { continue; }
    전체 += size;
    if (email && owners[name] === email) 내것 += size;
  }
  return { 전체, 내것 };
}

// 파일 하나를 지운다. 올린 본인이거나 승인 권한자만 지울 수 있다 —
// 남의 파일 주소를 자기 항목에 적어 넣고 그 항목을 지우는 수법을 막는다.
function 파일지우기(name, db, me) {
  const owners = readOwners();
  const 주인 = owners[name];
  // 주인을 모르는 파일도 아무나 지우게 두지 않는다 — 승인 권한자만 정리할 수 있다
  if (주인 !== me.email && !canApprove(db, me)) return false;
  try {
    unlinkSync(join(BRIEF_FILES, name));
  } catch (e) {
    // 파일이 이미 없으면 장부만 정리하면 되지만, 권한·디스크 오류면 파일이 남는다.
    // 그 경우 장부를 지우면 주인 없는 파일이 되므로 장부를 그대로 둔다.
    if (e && e.code !== "ENOENT") return false;
  }
  delete owners[name];
  writeOwners(owners);
  return true;
}

// 항목에 딸린 파일 이름들 — 지울 대상을 고를 때 쓴다
function 딸린파일(item) {
  const out = [];
  const 주소 = [];
  if (item && Array.isArray(item["쪽주소"])) 주소.push(...item["쪽주소"]);
  for (const k of ["슬라이드주소", "스크립트주소"]) if (item && item[k]) 주소.push(item[k]);
  for (const v of 주소) {
    const name = briefFileName(v);
    if (name && out.indexOf(name) < 0) out.push(name);
  }
  return out;
}

// 다른 항목이 아직 쓰고 있는 파일인가 — 쓰고 있으면 지우지 않는다
function 딴데서쓰나(name, list, 제외id) {
  return list.some((x) => x && String(x.id) !== 제외id && 딸린파일(x).indexOf(name) >= 0);
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

// 네이버 뉴스 검색 — 제목으로 실제 기사를 찾는다. 키가 없으면 조용히 빈 배열을 돌려주고
// 앤트로픽 웹 검색만으로 간다(기능이 통째로 멈추지 않게).
async function naverNews(query, display = 5) {
  if (!NAVER_ID || !NAVER_SECRET) return [];
  const url = "https://naverapihub.apigw.ntruss.com/search/v1/news?"
    + new URLSearchParams({ query: String(query).slice(0, 200), display: String(display), sort: "date", format: "json" });
  try {
    const r = await fetch(url, {
      headers: { "X-NCP-APIGW-API-KEY-ID": NAVER_ID, "X-NCP-APIGW-API-KEY": NAVER_SECRET },
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) { console.error("네이버 검색 실패:", r.status); return []; }
    const d = await r.json();
    // 네이버는 검색어를 <b>로 감싸 돌려주고 HTML 엔티티도 섞여 온다 — 벗겨서 넘긴다
    const 벗기기 = (t) => String(t || "").replace(/<[^>]*>/g, "")
      .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">").replace(/&#39;/g, "'").trim();
    return (d.items || []).map((it) => ({
      제목: 벗기기(it.title).slice(0, 200),
      요약: 벗기기(it.description).slice(0, 400),
      링크: String(it.originallink || it.link || "").slice(0, 400),
      발행: String(it.pubDate || "").slice(0, 40)
    }));
  } catch (e) {
    console.error("네이버 검색 오류:", e.message);
    return [];
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

// 발행 목록이 깨졌는데 빈 목록으로 여기면 다음 발행이 지난 호를 통째로 지운다.
// 아직 없는 것과 깨진 것을 구분한다.
function readCareList() {
  if (!existsSync(CARE_LIST)) return [];
  const list = JSON.parse(readFileSync(CARE_LIST, "utf8"));
  if (!Array.isArray(list)) throw new Error("발행 목록이 손상됐습니다.");
  return list;
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

  // 호별 표지 페이지 — 카톡에 붙일 주소다.
  // 카톡 미리보기 로봇은 자바스크립트를 실행하지 않으므로 issue.html?id=X 를 보내면
  // 정적으로 박힌 기본 표지만 읽는다. 그래서 호마다 다른 og 태그를 서버가 직접 그려 주고,
  // 사람은 곧바로 지면으로 넘긴다. 로그인 없는 공개 경로다(독자가 고객이다).
  const 표지 = req.method === "GET" && /^\/r\/([a-z0-9-]{1,64})$/.exec(path);
  if (표지) {
    // 옛 호는 정적 저장소(data/care)에만 있어 서버 목록에 없다. 404로 막으면 링크가 죽으므로
    // 미리보기만 기본 표지로 두고 지면으로는 그대로 넘긴다.
    const 호 = readCareList().find((i) => i && i.id === 표지[1]) || { id: 표지[1], "채널": "안창민" };
    const h = (s) => String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const 제목 = 호["호수"]
      ? `『${호["채널"]} ${호["발행인"] || "안창민"}』 `
          + (호["주차라벨"] ? 호["주차라벨"] + " " : "") + `통권 ${호["호수"]}호`
      : "안창민 케어센터";
    const 설명 = String(호["요약"] || (호["목차"] || []).map((t) => t && t["제목"]).filter(Boolean).join(" · ")
      || "보험·경제·상속을 쉽게 풀어 전하는 발행물입니다.").slice(0, 150);
    // 카톡은 SVG를 미리보기로 그리지 않는다 — 삽화 표지인 호는 기본 이미지로 돌린다
    const 커버 = String(호["커버이미지"] || "");
    const 그림 = (커버 && !/\.svg$/i.test(커버))
      ? (/^https?:/i.test(커버) ? 커버 : SITE + "/" + 커버.replace(/^\//, ""))
      : SITE + "/web/assets/img/hero-care.jpg";
    const 지면 = SITE + "/web/care/issue.html?id=" + encodeURIComponent(호.id);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" });
    return res.end('<!DOCTYPE html>\n<html lang="ko">\n<head>\n<meta charset="UTF-8">\n'
      + '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
      + `<title>${h(제목)}</title>\n`
      + `<meta name="description" content="${h(설명)}">\n`
      + '<meta property="og:type" content="article">\n'
      + '<meta property="og:site_name" content="안창민 케어센터">\n'
      + `<meta property="og:title" content="${h(제목)}">\n`
      + `<meta property="og:description" content="${h(설명)}">\n`
      + `<meta property="og:image" content="${h(그림)}">\n`
      + `<meta property="og:url" content="${h(지면)}">\n`
      + '<meta name="twitter:card" content="summary_large_image">\n'
      + `<meta http-equiv="refresh" content="0; url=${h(지면)}">\n`
      + `<script>location.replace(${JSON.stringify(지면)});</script>\n`
      + `</head>\n<body>\n<p><a href="${h(지면)}">${h(제목)}</a> 를 여는 중입니다.</p>\n</body>\n</html>\n`);
  }

  // 발표 자료를 띄우는 빈 틀. 자료는 앱(app.insurguard.life)이 아니라 이 출처에서 돈다.
  // 왜 나눠야 하나: 하이퍼프레임처럼 자기 안에 다시 iframe을 세우는 자료는, 출처를 통째로
  // 끊으면(sandbox allow-scripts만) 그 안쪽 틀을 열지 못해 검은 화면이 된다(2026-09-09 10회차).
  // 그렇다고 앱과 같은 출처에서 돌리면 자료의 스크립트가 앱의 로그인 토큰에 닿는다.
  // 그래서 출처를 주되 앱의 것이 아닌 출처를 준다 — 자료는 여기서 제 기능을 다 쓰고,
  // 앱의 저장소에는 닿지 못한다. 자료는 상위 창이 postMessage로 넣어 준다(서버에 안 남는다).
  // 담기는 내용이 없으므로 이 틀 자체는 로그인을 요구하지 않는다.
  if (req.method === "GET" && path === "/brief/frame") {
    console.log("자료 틀 요청 — " + (req.headers["referer"] || "출처없음") + " · " + String(req.headers["user-agent"] || "").slice(0, 60));
    const 틀 = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>발표 자료</title>
<style>html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden}</style>
</head>
<body>
<script>
(function () {
  var 허용 = ${JSON.stringify(ORIGINS)};
  var 썼다 = false;
  window.addEventListener("message", function (e) {
    if (썼다 || 허용.indexOf(e.origin) < 0) return;
    var d = e.data;
    if (!d || d["틀"] !== "자료" || typeof d.html !== "string") return;
    썼다 = true;
    // document.write로 찍으면 자료가 절반만 살아난다(겉은 서되 플레이어가 안 뜬다).
    // 파일을 열 때와 같은 길로 간다 — 이 출처에서 blob을 만들어 그 문서로 넘어간다.
    // blob은 만든 출처를 물려받으므로 여기서도 api 출처이고, 상위 창은 그대로 앱이라
    // 자료에 붙인 다리(postMessage)가 끊기지 않는다.
    location.replace(URL.createObjectURL(new Blob([d.html], { type: "text/html" })));
  });
  try { parent.postMessage({ "틀": "준비" }, "*"); } catch (x) {}
})();
</script>
</body>
</html>
`;
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      // 우리 앱 말고는 이 틀을 끼워 넣지 못한다
      "Content-Security-Policy": "frame-ancestors " + (ORIGINS.length ? ORIGINS.join(" ") : "'none'"),
      "X-Content-Type-Options": "nosniff",
      // 틀은 작다. 캐시로 굳혀 두면 고친 것이 몇 분간 안 나타난다(오늘 이미 한 번 겪었다).
      "Cache-Control": "no-cache"
    });
    return res.end(틀);
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

  // ── 고객 레코드 ────────────────────────────────────────────────────────────
  // 감싸고 푸는 일은 서버가 한다(2026-08-31 잠금문구 폐지). 설계사는 아무것도 넣지 않는다.
  // FC는 자기 것만 본다. 남의 것은 총관리자가 열람 비밀번호를 넣을 때만 열린다.

  // 틀린 횟수를 센다. 총관리자 세션이 털렸을 때 비밀번호를 무한정 두드리지 못하게 한다.
  // 서버가 살아 있는 동안만 유지되면 충분하다 — 재시작이 잦은 서비스가 아니다.
  function 비번맞나(pw) {
    const v = getDoc(db, "열람비번");
    if (!v) return false;
    const { salt, hash, 방식 } = JSON.parse(v);
    const a = Buffer.from(비번해시(pw, salt, 방식), "base64");
    const b = Buffer.from(hash, "base64");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function 너무많이틀렸나() {
    const r = 열람실패.get(me.id);
    if (!r) return 0;
    if (Date.now() > r.until) { 열람실패.delete(me.id); return 0; }
    return r.n >= 5 ? Math.ceil((r.until - Date.now()) / 1000) : 0;
  }
  function 틀림() {
    const r = 열람실패.get(me.id) || { n: 0, until: 0 };
    r.n++;
    r.until = Date.now() + Math.min(15 * 60000, 1000 * Math.pow(2, r.n));
    열람실패.set(me.id, r);
  }

  // 못 푸는 레코드 하나 때문에 목록 전체가 죽으면 안 된다 — 그 건만 세고 넘긴다
  function 목록풀기(행들) {
    let 못푼것 = 0;
    const 고객 = [];
    for (const r of 행들) {
      try { 고객.push({ ...레코드풀기(r.암호문), "고객코드": r.고객코드, "갱신시각": r.갱신시각 }); }
      catch { 못푼것++; }
    }
    return { 고객, 못푼건수: 못푼것 };
  }

  if (path.indexOf("/clients") === 0 && !DATA_KEY) {
    return send(res, 503, { error: "서버에 보관 열쇠가 설정되지 않았습니다(MG_DATA_KEY)." });
  }

  if (req.method === "GET" && path === "/clients") {
    return send(res, 200, 목록풀기(listClients(db, me.id)));
  }

  if (req.method === "GET" && path === "/clients/stamps") {
    return send(res, 200, listClientStamps(db, me.id));
  }

  // 어느 FC가 몇 명인가 — 총관리자 화면의 목록. 내용은 여기 없다.
  if (req.method === "GET" && path === "/clients/counts") {
    if (!me.is_admin) return send(res, 403, { error: "총관리자만 볼 수 있습니다." });
    return send(res, 200, clientCounts(db));
  }

  // 남의 고객 보기 — 총관리자 + 열람 비밀번호. 퇴사·인수인계·점검이 여기서 끝난다.
  // 누를 때마다 묻는다: 한 번 열고 자리를 뜨면 그대로 열려 있게 두지 않는다.
  const 남의것 = req.method === "POST" && /^\/clients\/of\/(\d+)$/.exec(path);
  if (남의것) {
    if (!me.is_admin) return send(res, 403, { error: "총관리자만 볼 수 있습니다." });
    const { 비밀번호 } = await readJson(req);
    if (!getDoc(db, "열람비번")) {
      return send(res, 409, { error: "열람 비밀번호가 아직 정해지지 않았습니다. 먼저 정하세요." });
    }
    const 남은 = 너무많이틀렸나();
    if (남은) return send(res, 429, { error: `여러 번 틀렸습니다. ${남은}초 뒤에 다시 시도하세요.` });
    if (!비번맞나(비밀번호)) {
      틀림();
      console.log(`열람 비밀번호 실패 — ${me.email}`);
      return send(res, 403, { error: "열람 비밀번호가 맞지 않습니다." });
    }
    열람실패.delete(me.id);
    const 대상 = getAccount(db, Number(남의것[1]));
    if (!대상) return send(res, 404, { error: "없는 계정입니다." });
    console.log(`남의 고객 열람: 계정 ${대상.id} — ${me.email}`);
    return send(res, 200, {
      "대상": { "계정": 대상.id, "이름": 대상.display_name || 대상.name },
      ...목록풀기(listClients(db, 대상.id))
    });
  }

  if (req.method === "GET" && path === "/admin/viewpw") {
    if (!me.is_admin) return send(res, 403, { error: "총관리자만 볼 수 있습니다." });
    return send(res, 200, { "정해짐": !!getDoc(db, "열람비번") });
  }

  // 열람 비밀번호 정하기 — 원문은 저장하지 않는다(scrypt 해시).
  if (req.method === "PUT" && path === "/admin/viewpw") {
    if (!me.is_admin) return send(res, 403, { error: "총관리자만 정할 수 있습니다." });
    const { 비밀번호, 지금것 } = await readJson(req);
    if (String(비밀번호 || "").length < 8) {
      return send(res, 400, { error: "열람 비밀번호는 8자 이상으로 정하세요." });
    }
    // 이미 있으면 지금 것을 함께 넣어야 바꾼다 — 자리를 비운 사이 바뀌지 않게
    if (getDoc(db, "열람비번") && !비번맞나(지금것)) {
      return send(res, 403, { error: "지금 쓰는 열람 비밀번호가 맞지 않습니다." });
    }
    const salt = randomBytes(16).toString("base64");
    // 파라미터를 함께 남긴다 — 나중에 더 올려도 옛 해시를 그대로 검증할 수 있다
    setDoc(db, "열람비번", JSON.stringify({ salt, hash: 비번해시(비밀번호, salt), 방식: SCRYPT }), me.id);
    console.log(`열람 비밀번호 설정 — ${me.email}`);
    return send(res, 200, { ok: true });
  }

  if (req.method === "PUT" && path === "/clients") {
    const body = await readJson(req, 8 * 1024 * 1024);
    const 배열 = Array.isArray(body) ? body : (body && Array.isArray(body["레코드"]) ? body["레코드"] : [body]);
    let 주인 = me.id;
    if (!Array.isArray(body) && body && body["소유"] != null) {
      if (!me.is_admin) return send(res, 403, { error: "다른 사람 몫으로 올리는 것은 총관리자만 할 수 있습니다." });
      // 읽기만 막고 쓰기를 열어 두면 세션이 털렸을 때 남의 고객이 통째로 덮인다.
      // 남의 것에 손대는 일은 읽든 쓰든 열람 비밀번호를 요구한다(2026-08-31 검수 지적).
      const 남은2 = 너무많이틀렸나();
      if (남은2) return send(res, 429, { error: `여러 번 틀렸습니다. ${남은2}초 뒤에 다시 시도하세요.` });
      if (!getDoc(db, "열람비번")) return send(res, 409, { error: "열람 비밀번호를 먼저 정하세요." });
      if (!비번맞나(body["비밀번호"])) { 틀림(); return send(res, 403, { error: "열람 비밀번호가 맞지 않습니다." }); }
      열람실패.delete(me.id);
      const 대상 = getAccount(db, Number(body["소유"]));
      if (!대상 || 대상.status !== "승인") return send(res, 400, { error: "승인된 계정이 아닙니다." });
      주인 = 대상.id;
    }
    if (!배열.length) return send(res, 400, { error: "올릴 레코드가 없습니다." });
    if (배열.length > 500) return send(res, 400, { error: "한 번에 500건까지 올릴 수 있습니다." });
    for (const r of 배열) {
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        return send(res, 400, { error: "레코드 형식 오류입니다." });
      }
      // 고객코드는 기본키가 된다 — 형식을 좁혀 둔다(헌법: 고객은 코드로만 표기)
      if (!/^[A-Za-z0-9-]{1,40}$/.test(String(r["고객코드"] || ""))) {
        return send(res, 400, { error: "고객코드 형식 오류: 영문·숫자·하이픈 1~40자." });
      }
    }
    for (const r of 배열) {
      const { "갱신시각": _버림, ...알맹이 } = r;
      putClient(db, 주인, {
        "고객코드": r["고객코드"], "암호문": 레코드감싸기(알맹이),
        "열쇠_fc": "", "열쇠_비상": "", "비상키지문": ""
      });
    }
    console.log(`고객 저장: ${배열.length}건 — ${me.email}`
      + (주인 === me.id ? "" : ` (대신 올림 → 계정 ${주인})`));
    return send(res, 200, { ok: true, 건수: 배열.length, 소유: 주인 });
  }

  const 고객삭제 = req.method === "DELETE" && /^\/clients\/([A-Za-z0-9-]{1,40})$/.exec(path);
  if (고객삭제) {
    const n = deleteClient(db, me.id, 고객삭제[1]);
    if (!n) return send(res, 404, { error: "없는 고객입니다." });
    console.log(`고객 삭제: ${고객삭제[1]} — ${me.email}`);
    return send(res, 200, { ok: true });
  }

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
  // 망이 한 번 끊겼다고 쓰던 것이 날아가면 안 된다. 잠깐 쉬고 한 번 더 걸어 본다.
  // 다시 걸어도 될 실패만 다시 건다 — 거절·형식 오류는 다시 걸어도 같은 결과다.
  async function 다시걸기(부르기, 횟수 = 2) {
    let 마지막;
    for (let i = 0; i < 횟수; i++) {
      try { return await 부르기(); }
      catch (e) {
        마지막 = e;
        const 망문제 = e && (e.name === "TypeError" || e.name === "TimeoutError"
          || /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i.test(String(e.message)));
        if (!망문제 || i === 횟수 - 1) throw e;
        console.warn(`AI 호출이 끊겼다 — ${i + 1}번째, 다시 건다: ${e.message}`);
        await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
      }
    }
    throw 마지막;
  }

  // SSE를 읽어 응답을 복원한다. 흘려받지 않으면 5분 넘는 요청은 아무것도 안 흐르는 사이
  // 중간 장비가 연결을 끊어 버린다(2026-09-07 /ai/column 실패 원인). 글자가 계속 흐르면 안 끊긴다.
  // content_block_start/delta/stop을 모아 블록을 되살린다 — pause_turn 재개에 그 블록이 필요하다.
  async function 흘려받기(upstream) {
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    const blocks = [];
    let buf = "", stop_reason = null, 남은 = "";

    const 먹기 = (line) => {
      if (!line.startsWith("data:")) return;
      let d;
      try { d = JSON.parse(line.slice(5).trim()); } catch { return; }
      if (d.type === "content_block_start") {
        blocks[d.index] = JSON.parse(JSON.stringify(d.content_block));
        if (blocks[d.index].type === "tool_use" || blocks[d.index].type === "server_tool_use") {
          blocks[d.index]._json = "";        // input은 조각으로 온다
        }
      } else if (d.type === "content_block_delta") {
        const b = blocks[d.index];
        if (!b) return;
        if (d.delta.type === "text_delta") b.text = (b.text || "") + d.delta.text;
        else if (d.delta.type === "thinking_delta") b.thinking = (b.thinking || "") + d.delta.thinking;
        else if (d.delta.type === "input_json_delta") b._json += d.delta.partial_json;
      } else if (d.type === "content_block_stop") {
        const b = blocks[d.index];
        if (b && b._json !== undefined) {
          try { b.input = b._json ? JSON.parse(b._json) : {}; } catch { b.input = {}; }
          delete b._json;
        }
      } else if (d.type === "message_delta") {
        if (d.delta && d.delta.stop_reason) stop_reason = d.delta.stop_reason;
      } else if (d.type === "error") {
        throw new Error("스트림 오류: " + ((d.error && d.error.message) || "알 수 없음"));
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();                      // 마지막 조각은 다음 덩어리와 이어 붙인다
      for (const l of lines) 먹기(l.trim());
    }
    if (buf.trim()) 먹기(buf.trim());
    void 남은;
    return { content: blocks.filter(Boolean), stop_reason };
  }

  async function claude(prompt, schema, opts) {
    const o = opts || {};
    const upstream = await 다시걸기(() => fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: TITLE_MODEL,
        max_tokens: o.maxTokens || 2000,
        stream: true,
        output_config: {
          effort: o.effort || "low",
          format: { type: "json_schema", schema: schema }
        },
        messages: [{ role: "user", content: prompt }]
      }),
      signal: AbortSignal.timeout(o.timeout || 60000)
    }));
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      console.error("AI 호출 실패:", upstream.status, detail.slice(0, 300));
      return { error: 502 };
    }
    const data = await 흘려받기(upstream);
    if (data.stop_reason === "refusal") return { error: 422 };
    const textBlock = (data.content || []).filter((b) => b.type === "text").pop();
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

  // 칼럼 성격 — 무엇을 쓸 자리인지. 데스크에서 고른 꼭지가 있으면 그것이 먼저다.
  // 못 골랐을 때만 채널의 기본값을 쓴다: 주간은 보험·자산·세무, 일간·월간은 자유 주제
  // (2026-08-17 — 일간은 소재를 가리지 않는다).
  function 칼럼성격(채널, 카테고리) {
    const c = String(카테고리 || "").trim();
    if (c) return c;
    return String(채널 || "").indexOf("주간") >= 0 ? "보험·자산·세무" : "자유 주제";
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
      "- 정치 사안도 주제로 삼는다. 다만 각도는 「누가 옳은가」가 아니라 「무슨 일이 있었고",
      "  어디로 이어지는가」로 잡는다. 필자가 편드는 각도만 피한다.",
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
    const 일간 = 채널.indexOf("일간") >= 0;
    const 분량 = 월간 ? "8000자에서 10000자" : 일간 ? "700자에서 1200자" : "1800자에서 2800자";
    const 결 = 월간
      ? "월간이므로 배경·현황·전망·시사점을 두루 짚고, 소제목으로 흐름을 나눈다."
      : 일간
        ? "일간이므로 오늘 하나만 다룬다. 소제목 없이 세 문단 안팎으로 쓰고, 배경 설명은 최소로 줄인다."
        : "주간이므로 핵심을 빠르게 전달한다.";

    // 제목으로 네이버를 먼저 뒤진다. 편집자가 붙여 넣는 것은 대개 오늘 나온 기사 제목이고,
    // 앤트로픽 웹 검색은 색인이 늦어 당일 기사를 못 찾는다(2026-08-23 상속예금 1.9조원 건).
    const 네이버 = await naverNews(제목, 5);
    // 프롬프트 배열이 줄 단위로 합쳐지므로 여기서는 줄만 만들어 펼친다
    const 기사줄 = 네이버.length
      ? ["", "제목으로 네이버 뉴스를 찾은 결과다. 이 중 제목과 같은 사안을 다룬 기사가 있으면",
         "그 기사가 이 글의 사안이다. 여기 실린 수치·기관·날짜는 확인된 것으로 보고 써도 된다.",
         ...네이버.flatMap((n, i) => [
           (i + 1) + ". " + n.제목 + " (" + n.발행 + ")",
           "   " + n.요약,
           "   " + n.링크
         ])]
      : [];

    const prompt = [
      `잡지 "${채널}"의 "${카테고리}" 칼럼 본문을 쓴다.`,
      필자(카테고리),
      `제목: ${제목}`,
      방향 ? `방향: ${방향}` : "",
      "",
      `분량: 본문 합계 ${분량}. ${결}`,
      "",
      "먼저 웹을 검색해 사실을 모은 뒤에 쓴다. 검색 없이 쓰면 「무엇이 일어났는가」가 빠지고",
      "「어떻게 볼 것인가」만 남아 칼럼이 아니라 소감문이 된다.",
      "",
      ...기사줄,
      "",
      "**첫 검색은 제목 그 자체로 한다.** 편집자가 실제 기사 제목을 그대로 붙여 넣는 일이 잦다.",
      "제목 문장을 검색어로 넣어 그 기사를 찾고, 찾으면 그 기사가 다룬 사안을 이 글의 사안으로 삼는다.",
      "다른 검색은 그 사안을 넓히고 뒷받침하는 데 쓴다 — 사안 자체를 갈아치우는 데 쓰지 않는다.",
      "",
      "기사 문법:",
      "- **제목이 약속한 것을 본문이 지킨다.** 제목에 수치가 있으면 그 수치를 검색해 확인하고",
      "  첫 부분에서 다룬다. 제목이 말한 상황이 본문에 없으면 제목과 다른 글이 된 것이다.",
      "  검색해도 제목의 수치를 확인하지 못하면 본문에 지어 쓰지 말고, 확인된 범위로 바꿔 쓴다.",
      "  **그 사실을 본문에 쓰지 않는다.** 「확인하지 못했습니다」, 「제가」, 「이 글의 제목에 붙은」처럼",
      "  글쓴이의 취재 과정을 말하는 문장은 독자에게 할 말이 아니다 — 아래 제목검증 칸에만 적는다.",
      "- 제목이 사람의 처지를 말하면(예: 장례비가 급하다) 그 처지가 본문에 나와야 한다.",
      "  제도 설명만 하고 그 사람이 사라지면 제목과 다른 글이다.",
      "- 첫 문단에 무엇이 언제 얼마나 있었는지를 쓴다. 마음가짐·배경 설명으로 시작하지 않는다.",
      "  다만 제목이 가리키는 사안으로 시작한다 — 검색에서 나온 다른 큰 사실로 리드를 바꾸지 않는다.",
      "- 수치·발표·통계에는 출처와 시점을 붙인다. 예: \"한국거래소 8월 14일 종가 기준\".",
      "- 검색으로 확인한 것만 쓴다. 확인이 안 되면 그 대목을 빼고 확인된 다른 사실로 채운다."
        + " 지어낸 수치·통계·발언은 절대 쓰지 않는다.",
      "- 독자를 가르치는 문장을 쓰지 않는다. \"~하는 습관이 필요합니다\", \"~하면 좋습니다\" 같은 훈수 대신",
      "  확인된 사실과 그것이 뜻하는 바를 쓴다.",
      "",
      "조건:",
      "- 독자는 보험 고객이다. 설명은 쉽게, 내용은 얕지 않게.",
      "- 정치 사안은 **다뤄도 된다.** 누가 무엇을 결정했는지, 어떤 논란이 있는지, 여론이 어느 쪽으로",
      "  갈리는지 그대로 전한다. 여론을 소개하는 것은 편드는 것이 아니다.",
      "  하지 않는 것은 **필자 자신이 편드는 것** 하나다 — 잘한 일이다·잘못한 일이다라고 필자가 판정하지",
      "  않는다. 비판이 있으면 누가 무엇을 근거로 비판하는지 밝혀 적고, 반대편 주장도 함께 적는다.",
      "- 세금·투자 권유로 읽힐 표현을 쓰지 않는다.",
      "- 판례·사례를 지어내지 않는다. 사건번호 없는 판례는 쓰지 않는다.",
      "- 문체는 평서형 존댓말. 이모지·영문 장식 표기·과장된 수식 금지.",
      "- 마지막 문단은 보험 설계사의 시각으로 시사점을 짚되, 앞에서 쓴 사실에 근거해 맺는다.",
      "",
      "출력 형식:",
      "- 카테고리: 이 글이 어느 꼭지인지 2~6자 라벨. 예: 시사, 경제, 보험, 자산, 세무, 건강.",
      "- 부제: 제목을 보완하는 한 줄. 제목과 겹치지도, 제목을 대신하지도 않는다."
        + " 제목이 던진 것을 한 발 더 좁히는 자리다. 여기에 새 제목을 달지 않는다.",
      "- 요약: 150자에서 200자. 서재 카드에 실린다.",
      "",
      "지면 문법 — 지면은 문장 모양을 보고 다르게 그린다. 처음부터 끝까지 문단만 이어지면",
      "글이 아무리 좋아도 독자는 지겨워한다. 아래 모양을 흐름에 맞는 자리에 섞는다.",
      "억지로 채우지 않는다 — 없는 수치를 지어내 넣지 않는다.",
      "",
      "- 대형 수치: 「1조8945억원 — 은행에 묶인 상속예금」처럼 수치와 설명을 줄표로 잇는다.",
      "  기사에서 가장 중요한 숫자 한둘을 이 모양으로 뽑는다. 지면이 크게 조판한다.",
      "- 표: 항목을 탭 문자로 나눠 쓴다. 첫 줄이 머리, 다음 줄들이 내용이다.",
      "  둘 이상을 나란히 견줄 때만 쓴다.",
      "- 짚는 문장: 58자 이하이고 마침표로 끝나지 않는 한 줄. 그 대목의 핵심을 못 박는다.",
      "- 차례 짚기: 「첫째,」 「둘째,」 「셋째,」로 시작하는 문단.",
      "- 예시: 「예를 들어」로 시작하는 문단.",
      "- 주의: 반드시·유의해야 같은 말이 들어간, 놓치면 손해 보는 대목.",
      "",
      "- 본문: 블록 배열. t가 h면 소제목, p면 문단이다. 위 모양들도 p로 적는다 —",
      "  지면이 문장 모양을 보고 알아서 다르게 그린다."
        + (일간 ? " 일간은 짧으므로 소제목 없이 문단만 쓴다." : " 소제목으로 흐름을 나눈다."),
      "- 한마디: 설계사가 덧붙이는 한 문장.",
      "- 제목검증: 제목이 내세운 사실·수치를 검색으로 확인했는지. 편집자만 보고 발행물에는 안 나간다."
        + " 확인=근거를 찾음, 못찾음=공개 자료에 없음, 다름=찾았으나 제목과 값·범위가 어긋남.",
      "- 검증설명: 제목검증이 확인이 아니면 무엇이 어긋났는지 한 줄. 확인이면 빈 문자열."
    ].filter(Boolean).join("\n");

    // 검색을 붙여 쓴다(2026-08-17). 사실 없이 쓰면 「어떻게 볼 것인가」만 남아 칼럼이
    // 소감문이 된다. 월간은 길고 다룰 것이 많아 검색 횟수를 늘린다.
    const r = await claudeWeb(prompt, {
      type: "object",
      properties: {
        카테고리: { type: "string" },
        부제: { type: "string" },
        요약: { type: "string" },
        한마디: { type: "string" },
        제목검증: { type: "string", enum: ["확인", "못찾음", "다름"] },
        검증설명: { type: "string" },
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
      required: ["카테고리", "부제", "요약", "한마디", "본문", "제목검증", "검증설명"],
      additionalProperties: false
    }, {
      effort: 월간 ? "high" : "medium",
      maxTokens: 월간 ? 32000 : 12000,
      maxUses: 월간 ? 14 : 일간 ? 5 : 8,
      timeout: 600000
    });

    if (r.error === 422) return send(res, 422, { error: "이 제목으로는 본문을 쓸 수 없습니다." });
    if (r.error) return send(res, 502, { error: "본문을 받아오지 못했습니다. 잠시 후 다시 시도하세요." });
    // 무엇을 찾아 썼는지 함께 돌려준다 — 검색이 안 돌았으면 화면에서 바로 보인다.
    const 네이버출처 = 네이버.map((n) => ({ url: n.링크, 제목: n.제목 }));
    return send(res, 200, {
      ...r.value,
      "출처": [...네이버출처, ...(r.출처 || [])],
      "검색횟수": r.검색횟수 || 0,
      "네이버건수": 네이버.length
    });
  }

  // 데이터 그림 — 기사가 실제로 든 수치로 그린다(2026-08-31).
  // 종전 삽화는 네모·원·삼각을 아무 데나 놓는 것이라 기사와 상관이 없어 오히려 이상했다.
  // 코드로 그려 값어치가 나오는 건 추상 도형이 아니라 기사 안의 숫자다.
  // 쓸 수치가 둘 미만이면 그리지 않는다 — 가짜로 채우지 않는다(헌법).
  if (req.method === "POST" && path === "/ai/chart") {
    if (!ANTHROPIC_KEY) return send(res, 503, { error: "AI 기능이 설정되지 않았습니다." });
    const body = await readJson(req, 512 * 1024);
    const 제목 = String(body["제목"] || "").slice(0, 200);
    const 본문 = (Array.isArray(body["본문"]) ? body["본문"] : [])
      .map((b) => String(b && b.x || "")).join("\n").slice(0, 20000);
    if (!본문.trim()) return send(res, 400, { error: "본문이 먼저 필요합니다." });

    const prompt = [
      "아래 기사에서 그림으로 그릴 수치를 뽑는다. 경제지가 본문 옆에 싣는 그래프를 만드는 일이다.",
      "",
      `제목: ${제목}`,
      "본문:",
      본문,
      "",
      "규칙:",
      "- **본문에 실제로 적힌 수치만 쓴다.** 없는 값을 지어내거나 어림잡아 채우지 않는다.",
      "- 쓸 수치가 둘 미만이면 그리지 않는다 — 그때는 항목을 빈 배열로 두고 사유를 적는다.",
      "- 종류: 시간에 따른 변화면 「선」, 몇 개를 견주면 「막대」, 둘을 크게 맞세우면 「견줌」,",
      "  절차·제도를 단계로 설명하면 「흐름」. 수치가 없어도 흐름은 그릴 수 있다.",
      "- 「흐름」일 때는 항목 대신 칸을 채운다. 칸 2~5개, 각 칸에 이름과 한 줄 설명.",
      "  막히는 자리에 막힘을 참으로 준다 — 기사가 문제라고 말하는 그 단계다. 없으면 전부 거짓.",
      "- 단위를 하나로 맞춘다. 억원과 조원을 섞지 않는다(억원으로 통일하는 식).",
      "- 표기는 사람이 읽는 말로 짧게: 1조8945억, 628만, 556.",
      "- 강조는 기사가 말하려는 그 항목의 번호(0부터). 없으면 -1.",
      "- 출처는 본문에 적힌 기관·보도·시점을 그대로 옮긴다. 없으면 빈 문자열."
    ].join("\n");

    const r = await claude(prompt, {
      type: "object",
      properties: {
        그릴수있나: { type: "boolean" },
        사유: { type: "string" },
        종류: { type: "string", enum: ["막대", "선", "견줌", "흐름"] },
        제목: { type: "string" },
        단위: { type: "string" },
        출처: { type: "string" },
        강조: { type: "integer" },
        항목: {
          type: "array",
          items: {
            type: "object",
            properties: { 이름: { type: "string" }, 값: { type: "number" }, 표기: { type: "string" } },
            required: ["이름", "값", "표기"],
            additionalProperties: false
          }
        },
        칸: {
          type: "array",
          items: {
            type: "object",
            properties: { 이름: { type: "string" }, 설명: { type: "string" }, 막힘: { type: "boolean" } },
            required: ["이름", "설명", "막힘"],
            additionalProperties: false
          }
        }
      },
      required: ["그릴수있나", "사유", "종류", "제목", "단위", "출처", "강조", "항목", "칸"],
      additionalProperties: false
    }, { effort: "medium", maxTokens: 4000, timeout: 120000 });

    if (r.error) return send(res, 502, { error: "그림 자료를 받아오지 못했습니다." });
    const spec = r.value;
    if (!spec["그릴수있나"]) {
      return send(res, 200, { "그림없음": true, "사유": spec["사유"] || "쓸 수치가 없습니다." });
    }
    const svg = chartSvg(spec);
    if (!svg) return send(res, 200, { "그림없음": true, "사유": "그릴 것이 둘 미만입니다." });
    const 저장 = saveMedia(Buffer.from(svg, "utf8"), "svg");
    const 개수 = spec["종류"] === "흐름" ? (spec["칸"] || []).length : (spec["항목"] || []).length;
    console.log(`데이터 그림: ${spec["종류"]} ${개수}개 — ${me.email}`);
    return send(res, 200, { ...저장, "종류": spec["종류"], "항목수": 개수, "출처": spec["출처"] });
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
    // 검색이 실제로 돌았는지 남긴다 — 횟수와 출처를 응답에 실어 보고에 쓴다.
    let 검색횟수 = 0;
    const 출처 = [];
    function 수확(content) {
      (content || []).forEach((b) => {
        // web_search_20260209은 질의를 input에 담아 주지 않는다(속으로 코드 실행을 쓴다).
        // 확인해 보니 input이 비어 온다 — 질의를 모을 수 없다. 몇 번 찾았는지만 센다.
        if (b.type === "server_tool_use" && b.name === "web_search") 검색횟수 += 1;
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
      const upstream = await 다시걸기(() => fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: TITLE_MODEL,
          max_tokens: o.maxTokens || 16000,
          stream: true,
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: o.maxUses || 8 }],
          output_config: {
            effort: o.effort || "medium",
            format: { type: "json_schema", schema: schema }
          },
          messages: messages
        }),
        signal: AbortSignal.timeout(o.timeout || 600000)
      }));
      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => "");
        console.error("검증 호출 실패:", upstream.status, detail.slice(0, 300));
        return { error: 502 };
      }
      const data = await 흘려받기(upstream);
      수확(data.content);
      if (data.stop_reason === "refusal") return { error: 422 };
      if (data.stop_reason === "pause_turn") {
        messages = [messages[0], { role: "assistant", content: data.content }];
        continue;
      }
      const texts = (data.content || []).filter((b) => b.type === "text");
      const last = texts[texts.length - 1];
      try { return { value: JSON.parse(last.text), 검색횟수, 출처 }; } catch (e) { return { error: 502 }; }
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
        "4. 정치 편향 — **필자가 직접 편드는 서술**만 잡는다(잘한 일이다·잘못됐다는 판정).",
        "   여론이나 비판을 출처와 함께 소개한 것은 편향이 아니다 — 그것까지 잡으면 기사가 아니게 된다.",
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
      return { 번호, 결과, 요약: String(r.value["요약"] || ""), 검색횟수: r.검색횟수 || 0, 출처: r.출처 || [] };
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
    if (["일간", "주간", "월간"].indexOf(목록항목["채널"]) < 0) {
      return send(res, 400, { error: "채널은 일간·주간·월간 중 하나여야 합니다." });
    }
    const entry = { ...목록항목 };
    delete entry["상태"]; // 발행하기를 눌렀다 = 발행 확정. 발행 목록에 초안 표기를 남기지 않는다.

    const list = readCareList();
    const 이미 = list.find((i) => i && i.id === id);
    // 두 사람이 같은 호수를 각자 만들면 id가 겹친다. 말없이 덮어쓰면 앞사람 호가 사라진다.
    // 덮어쓰려면 "덮어쓰기"를 함께 보내야 한다 — 화면이 사용자에게 확인을 받고 넣는다.
    if (이미 && !목록항목["덮어쓰기"]) {
      return send(res, 409, {
        error: `${이미["채널"]} ${이미["호수"]}호(${id})는 이미 발행돼 있습니다.`
          + ` "${이미["제목"]}" — ${이미["발행인"] || ""} ${String(이미["발행일"] || "").slice(0, 10)}.`
          + " 덮어쓰려면 다시 눌러 확인해 주세요.",
        "이미발행": {
          "제목": 이미["제목"], "발행인": 이미["발행인"], "발행일": 이미["발행일"]
        }
      });
    }
    delete entry["덮어쓰기"];

    // 본문을 먼저 쓰고 목록을 쓴다. 목록 쓰기가 실패하면 본문만 바뀐 채로 남아
    // 고객이 옛 제목·표지에 새 본문을 보게 되므로, 실패하면 본문을 되돌린다.
    const 본문경로 = join(CARE_ISSUES_DIR, id + ".json");
    const 옛본문 = existsSync(본문경로) ? readFileSync(본문경로) : null;
    atomicWrite(본문경로, JSON.stringify(본문, null, 1));
    try {
      atomicWrite(CARE_LIST, JSON.stringify([entry, ...list.filter((i) => i && i.id !== id)], null, 1));
    } catch (e) {
      if (옛본문) writeFileSync(본문경로, 옛본문);
      else { try { unlinkSync(본문경로); } catch (e2) { /* 없으면 그만 */ } }
      throw e;
    }
    console.log(`발행: ${entry["채널"]} ${entry["호수"]}호 (${id}) — ${me.email}`);
    return send(res, 200, { ok: true, id });
  }

  // ── 강의 자료 라이브러리 (팀 공유) ───────────────────────────────────────
  // 종전에는 브라우저 IndexedDB에만 쌓여 올린 사람만 볼 수 있었다. 팀 플랫폼이므로
  // 승인 계정이면 누구나 목록을 보고 발표할 수 있어야 한다(2026-08-05 사용자 지시).
  // 상담 자료는 여기 올리지 않는다 — 화면이 이미 강의 모드에서만 탑재를 연다.
  if (req.method === "GET" && path === "/brief/library") {
    // 소유 판정용 메일은 서버 안에서만 쓴다. 목록에는 이름만 내보내고,
    // 화면이 "내가 올린 것"을 가릴 수 있게 그 여부만 알려 준다.
    const 지울수있음 = canApprove(db, me);
    return send(res, 200, readBriefLibrary().map((it) => {
      const { 올린이메일, ...rest } = it || {};
      return {
        ...rest,
        "내가올림": 올린이메일 === me.email,
        "지울수있음": 올린이메일 === me.email || 지울수있음
      };
    }));
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
    // 크기는 받기 전에 본다. 다 받고 나서 끊으면 브라우저는 "연결 실패"만 보고,
    // 발표 자료가 왜 안 올라갔는지 알 길이 없다(2026-09-09 10회차 48MB 건).
    const 길이 = Number(req.headers["content-length"] || 0);
    if (길이 > MAX_BRIEF) {
      req.resume();
      const mb = (n) => Math.round(n / (1024 * 1024));
      return send(res, 413, { error: `파일이 너무 큽니다 — ${mb(길이)}MB. ${mb(MAX_BRIEF)}MB까지 올릴 수 있습니다.` });
    }
    const bytes = await readBytes(req, MAX_BRIEF);
    if (!bytes.length) return send(res, 400, { error: "빈 파일입니다." });
    if (!형식일치(ext, bytes)) return send(res, 400, { error: "파일 내용이 형식과 맞지 않습니다." });
    // 받은 뒤에 센다 — 이 파일 크기까지 더해야 상한이 실제로 지켜진다
    const 쓴양 = briefUsage(me.email);
    if (쓴양.전체 + bytes.length > MAX_BRIEF_TOTAL) {
      return send(res, 507, { error: "저장 공간이 가득 찼습니다. 지난 자료를 지우고 다시 시도하세요." });
    }
    if (쓴양.내것 + bytes.length > MAX_BRIEF_PER_ACCOUNT) {
      return send(res, 507, { error: "올릴 수 있는 용량을 넘었습니다. 올린 자료를 지우고 다시 시도하세요." });
    }
    return send(res, 200, saveBriefFile(bytes, ext, me.email));
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
    const owners = readOwners();
    const 주소 = {};
    // 주소는 이 서버가 내준 것이면서, 내가 올린 파일이어야 한다.
    // 안 그러면 남의 파일 주소를 자기 항목에 붙여 놓고 지워 버릴 수 있다.
    function 확인(v, 이름표) {
      const name = briefFileName(v);
      if (!name) { throw new Error(이름표 + "가 이 서버의 자료 주소가 아닙니다."); }
      if (!existsSync(join(BRIEF_FILES, name))) { throw new Error(이름표 + "의 파일이 서버에 없습니다."); }
      if (owners[name] !== me.email && !canApprove(db, me)) {
        throw new Error(이름표 + "는 다른 사람이 올린 파일입니다.");
      }
      return "/brief/file/" + name;
    }
    try {
      for (const k of ["슬라이드주소", "스크립트주소"]) {
        if (항목[k] !== undefined) 주소[k] = 확인(항목[k], k);
      }
      if (Array.isArray(항목["쪽주소"])) {
        주소["쪽주소"] = 항목["쪽주소"].map((v, n) => 확인(v, "쪽주소 " + (n + 1)));
      }
    } catch (e) {
      return send(res, 400, { error: e.message });
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
    남길것.unshift(entry);
    // 목록을 먼저 쓴다. 파일부터 지우면 목록 쓰기가 실패했을 때 파일만 사라진다.
    atomicWrite(BRIEF_LIST, JSON.stringify(남길것, null, 1));
    // 덮어쓰면서 더 이상 쓰이지 않게 된 파일만 지운다. 같은 주소를 그대로 두면 건드리지 않는다.
    // 목록은 이미 저장됐다. 여기서 사고가 나도 그 사실을 뒤집지 않는다 —
    // 지우지 못한 파일은 남을 뿐이고, 그건 목록이 틀리는 것보다 가볍다.
    let 못지운것 = 0;
    if (기존) {
      const 새것 = 딸린파일(entry);
      for (const name of 딸린파일(기존)) {
        if (새것.indexOf(name) >= 0) continue;
        if (딴데서쓰나(name, 남길것, id)) continue;   // 다른 항목이 아직 쓴다
        try {
          if (!파일지우기(name, db, me)) 못지운것 += 1;
        } catch (e) { 못지운것 += 1; }
      }
    }
    if (못지운것) console.warn(`강의자료 교체 중 파일 ${못지운것}개를 정리하지 못했습니다 (${id})`);
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
    atomicWrite(BRIEF_LIST, JSON.stringify(list.filter((x) => x && String(x.id) !== id), null, 1));
    // 목록을 먼저 쓴 뒤 파일을 지운다. 남의 파일과 다른 항목이 쓰는 파일은 건너뛴다.
    const 남은목록 = list.filter((x) => x && String(x.id) !== id);
    let 남은파일 = 0;
    for (const name of 딸린파일(gone)) {
      if (딴데서쓰나(name, 남은목록, id)) continue;
      try {
        if (!파일지우기(name, db, me)) 남은파일 += 1;
      } catch (e) { 남은파일 += 1; }
    }
    if (남은파일) console.warn(`강의자료 삭제 중 파일 ${남은파일}개를 지우지 못했습니다 (${id})`);
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

  // ── 조직도 ──
  // 자리마다 계정 번호·이메일이 붙는다. 저장소(공개)가 아니라 여기 둔다.
  // 열람은 로그인한 사람 전원 — 조직도는 원래 다 같이 보는 것이다.
  // 조직도(/org)는 걷어냈다 — 하랑지점이 원본이다(2026-09-10). 관리자 화면이 그쪽을 읽는다.

  // ── 상담 스크립트 (FC 개인)
  // 고객 이름을 끼워 넣을 틀이다. 고객 정보가 아니므로 암호화하지 않는다 — 사람마다
  // 자기 것만 쓰고 읽는다. 기본 틀은 화면이 들고 있고, 여기에는 고친 것만 쌓인다.
  if (req.method === "GET" && path === "/scripts") {
    const v = getDoc(db, "scripts:" + me.id);
    return send(res, 200, v ? JSON.parse(v) : null);
  }

  if (req.method === "PUT" && path === "/scripts") {
    const body = await readJson(req, 512 * 1024);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return send(res, 400, { error: "스크립트 묶음 형식 오류입니다." });
    }
    // 카테고리마다 배열 하나. 너무 길면 화면이 못 감당하므로 여기서 자른다.
    for (const [k, v] of Object.entries(body)) {
      if (!Array.isArray(v)) return send(res, 400, { error: `${k}가 배열이 아닙니다.` });
      if (v.length > 50) return send(res, 400, { error: `${k}는 50개까지 넣을 수 있습니다.` });
      for (const it of v) {
        if (!it || typeof it !== "object") return send(res, 400, { error: "항목 형식 오류입니다." });
        if (String(it["제목"] || "").length > 100 || String(it["본문"] || "").length > 5000) {
          return send(res, 400, { error: "제목 100자·본문 5000자를 넘을 수 없습니다." });
        }
      }
    }
    setDoc(db, "scripts:" + me.id, JSON.stringify(body), me.id);
    return send(res, 200, { ok: true });
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
    if (/토큰|형식|JSON|앱의|발급자|만료|미인증/.test(msg)) return send(res, 400, { error: msg });
    // 속사정을 그대로 내보내면 사용자는 "fetch failed" 같은 말을 보고 자기 입력을 고치려 든다.
    // 로그에는 원문을 남기고 화면에는 무엇을 하면 되는지만 알린다(2026-09-06).
    console.error("처리 실패:", url.pathname, msg);
    const 망 = /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network|timeout|aborted/i.test(msg);
    send(res, 망 ? 503 : 500, {
      error: 망
        ? "서버가 외부와 연결되지 않았습니다. 입력은 그대로 두고 잠시 뒤 다시 눌러 주세요."
        : "서버에서 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요."
    });
  });
});

server.listen(PORT, () => {
  console.log(`마이가디언 인증 서버 :${PORT} — DB ${DB_FILE}`);
  if (!ORIGINS.length) console.warn("ALLOWED_ORIGINS가 비어 있어 브라우저 호출이 차단됩니다.");
  if (!BOOTSTRAP.length) console.warn("BOOTSTRAP_ADMINS가 비어 있어 첫 총관리자를 만들 수 없습니다.");
});

export { server, db };
