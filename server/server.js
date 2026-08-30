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
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;   // 없으면 고객 경로만 잠긴다
  return Buffer.from(hex, "hex");
})();

// 레코드 하나를 감싼다 — iv.암호문.태그 (모두 base64)
function 레코드감싸기(obj) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", DATA_KEY, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return [iv.toString("base64"), ct.toString("base64"), c.getAuthTag().toString("base64")].join(".");
}

function 레코드풀기(s) {
  const [iv, ct, tag] = String(s).split(".");
  if (!iv || !ct || !tag) throw new Error("레코드 형식 오류");
  const d = createDecipheriv("aes-256-gcm", DATA_KEY, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8"));
}

// 총관리자 열람 비밀번호 — 남의 고객을 볼 때만 묻는다. 원문은 저장하지 않는다.
function 비번해시(pw, salt) { return scryptSync(String(pw), salt, 32).toString("base64"); }
function 비번맞나(db, pw) {
  const v = getDoc(db, "열람비번");
  if (!v) return false;
  const { salt, hash } = JSON.parse(v);
  const a = Buffer.from(비번해시(pw, salt), "base64");
  const b = Buffer.from(hash, "base64");
  return a.length === b.length && timingSafeEqual(a, b);
}

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

  if (!DATA_KEY && path.indexOf("/clients") === 0) {
    return send(res, 503, { error: "서버에 보관 열쇠가 설정되지 않았습니다(MG_DATA_KEY)." });
  }

  // 못 푸는 레코드가 하나 있다고 목록 전체가 죽으면 안 된다 — 그 건만 표시하고 넘긴다
  function 목록풀기(행들) {
    let 못푼것 = 0;
    const 고객 = [];
    for (const r of 행들) {
      try { 고객.push({ ...레코드풀기(r.암호문), "고객코드": r.고객코드, "갱신시각": r.갱신시각 }); }
      catch { 못푼것++; }
    }
    return { 고객, 못푼건수: 못푼것 };
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
  // 비밀번호를 매번 묻는다: 한 번 열고 자리를 뜨면 그대로 열려 있게 두지 않는다.
  const 남의것 = req.method === "POST" && /^\/clients\/of\/(\d+)$/.exec(path);
  if (남의것) {
    if (!me.is_admin) return send(res, 403, { error: "총관리자만 볼 수 있습니다." });
    const { 비밀번호 } = await readJson(req);
    if (!getDoc(db, "열람비번")) {
      return send(res, 409, { error: "열람 비밀번호가 아직 정해지지 않았습니다. 관리자 설정에서 정하세요." });
    }
    if (!비번맞나(db, 비밀번호)) return send(res, 403, { error: "열람 비밀번호가 맞지 않습니다." });
    const 대상 = getAccount(db, Number(남의것[1]));
    if (!대상) return send(res, 404, { error: "없는 계정입니다." });
    console.log(`남의 고객 열람: 계정 ${대상.id} — ${me.email}`);
    return send(res, 200, {
      "대상": { "계정": 대상.id, "이름": 대상.display_name || 대상.name },
      ...목록풀기(listClients(db, 대상.id))
    });
  }

  // 열람 비밀번호 정하기 — 총관리자 본인만. 원문은 저장하지 않는다.
  if (req.method === "PUT" && path === "/admin/viewpw") {
    if (!me.is_admin) return send(res, 403, { error: "총관리자만 정할 수 있습니다." });
    const { 비밀번호, 지금것 } = await readJson(req);
    if (String(비밀번호 || "").length < 8) {
      return send(res, 400, { error: "열람 비밀번호는 8자 이상으로 정하세요." });
    }
    // 이미 있으면 지금 것을 함께 넣어야 바꾼다 — 자리를 비운 사이 바뀌지 않게
    if (getDoc(db, "열람비번") && !비번맞나(db, 지금것)) {
      return send(res, 403, { error: "지금 쓰는 열람 비밀번호가 맞지 않습니다." });
    }
    const salt = randomBytes(16).toString("base64");
    setDoc(db, "열람비번", JSON.stringify({ salt, hash: 비번해시(비밀번호, salt) }), me.id);
    console.log(`열람 비밀번호 설정 — ${me.email}`);
    return send(res, 200, { ok: true });
  }

  if (req.method === "GET" && path === "/admin/viewpw") {
    if (!me.is_admin) return send(res, 403, { error: "총관리자만 볼 수 있습니다." });
    return send(res, 200, { "정해짐": !!getDoc(db, "열람비번") });
  }

  if (req.method === "PUT" && path === "/clients") {
    const body = await readJson(req, 8 * 1024 * 1024);
    const 배열 = Array.isArray(body) ? body : (body && Array.isArray(body["레코드"]) ? body["레코드"] : [body]);
    let 주인 = me.id;
    if (!Array.isArray(body) && body && body["소유"] != null) {
      if (!me.is_admin) return send(res, 403, { error: "다른 사람 몫으로 올리는 것은 총관리자만 할 수 있습니다." });
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

  // ── 지점 비상 공개키
  // 공개키만 여기 둔다. 개인키는 서버에 절대 오지 않는다 — 안창민이 오프라인 보관한다.
  // FC 기기는 이 공개키로 데이터열쇠를 감싸므로 로그인한 사람 전원이 읽을 수 있어야 한다.
  if (req.method === "GET" && path === "/vault/pubkey") {
    const v = getDoc(db, "비상공개키");
    if (!v) return send(res, 404, { error: "지점 비상 열쇠가 아직 없습니다." });
    return send(res, 200, JSON.parse(v));
  }

  if (req.method === "PUT" && path === "/vault/pubkey") {
    if (!me.is_admin) return send(res, 403, { error: "총관리자만 지점 비상 열쇠를 정할 수 있습니다." });
    const body = await readJson(req);
    const jwk = body && body["공개키"];
    // RSA-OAEP 공개키 JWK의 최소 형태만 확인한다. 서버는 이걸 쓰지 않고 보관만 한다.
    if (!jwk || jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") {
      return send(res, 400, { error: "RSA 공개키(JWK)가 아닙니다." });
    }
    if (!/^[\w-]{10,128}$/.test(String(body["지문"] || ""))) {
      return send(res, 400, { error: "지문이 없습니다." });
    }
    // 바꿔치기하면 이미 올라간 레코드의 비상 경로가 끊긴다(FC 열쇠는 그대로).
    // 실수로 덮는 일이 없게, 이미 있으면 명시적으로 "교체"를 함께 보내야 한다.
    const 이전 = getDoc(db, "비상공개키");
    if (이전 && !body["교체"]) {
      const p = JSON.parse(이전);
      return send(res, 409, {
        error: `이미 지점 비상 열쇠가 있습니다(지문 ${p["지문"]}, ${String(p["정한날"] || "").slice(0, 10)}).`
          + " 교체하면 지금까지 올라간 레코드의 비상 경로가 끊깁니다 —"
          + " 각 FC가 자기 레코드를 다시 올려야 복구됩니다.",
        "기존지문": p["지문"]
      });
    }
    setDoc(db, "비상공개키", JSON.stringify({
      "공개키": jwk, "지문": String(body["지문"]), "정한날": new Date().toISOString(), "정한이": me.email
    }), me.id);
    console.log(`지점 비상 공개키 ${이전 ? "교체" : "등록"}: 지문 ${body["지문"]} — ${me.email}`);
    return send(res, 200, { ok: true, "지문": String(body["지문"]) });
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
