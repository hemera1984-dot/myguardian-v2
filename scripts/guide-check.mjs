// 화면별 「?」 도움말(web/assets/guides.js)이 화면을 따라오는지 본다 — 배포 전에 돌린다(2026-10-11, 하랑지점 guide-check 와 같은 뜻).
// 멈추는 것: 공용 틀(platform-sidebar)을 쓰는 화면인데 도움말이 없을 때, 도움말 키에 맞는 화면이 없을 때.
// 알리기만 하는 것: 화면 파일을 「이번에 바뀐 것」 날짜보다 나중에 고쳤을 때 — 눈에 보이는 변화면 news 를 새로 쓴다.
import { readFileSync, readdirSync, statSync } from "fs";
import { execSync } from "child_process";
import vm from "vm";
import path from "path";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..");
const WEB = path.join(ROOT, "web");
const win = {}; const doc = { addEventListener() {}, currentScript: null };
vm.runInNewContext(readFileSync(path.join(WEB, "assets/platform.js"), "utf8"), { window: win, document: doc, navigator: {}, localStorage: {}, setTimeout, URL });
vm.runInNewContext(readFileSync(path.join(WEB, "assets/guides.js"), "utf8"), { window: win });
const key = win.mg.guideKey, G = win.MG_GUIDE;

// guideKey 자체 점검 — 화면 판별이 틀리면 엉뚱한 도움말이 뜬다
const expect = { "/web/": "home", "/": "home", "/web/index.html": "home", "/web/customers/": "customers", "/web/brief/": "brief",
  "/web/brief/present.html": "", "/web/care/desk.html": "desk", "/web/care/": "", "/web/r/": "", "/web/install.html": "install", "/web/intro.html": "" };
for (const [p, k] of Object.entries(expect)) if (key(p) !== k) { console.error(`guideKey(${p}) = ${key(p)} (기대 ${k})`); process.exit(1); }

const walk = (d) => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".html") ? [p] : []; });
const bad = [], used = new Set();
for (const f of walk(WEB)) {
  const html = readFileSync(f, "utf8");
  if (!html.includes("platform.js")) continue;
  const url = "/web/" + path.relative(WEB, f).split(path.sep).join("/").replace(/index\.html$/, "");
  const k = key(url);
  if (k) used.add(k);
  if (html.includes("platform-sidebar") && !(k && G.screens[k])) bad.push(`도움말 없는 화면: ${url} — guides.js screens 에 넣고 platform.js guideKey 에 키를 더한다`);
}
for (const k of Object.keys(G.screens)) if (!used.has(k)) bad.push(`화면이 없는 도움말 키: ${k}`);
if (!/^\d{4}-\d{2}-\d{2}$/.test(G.news?.date || "")) bad.push("news.date(YYYY-MM-DD)가 없다");
let last = "";
try { last = execSync("git log -1 --format=%cs -- web/*.html web/*/*.html web/assets/platform.css", { cwd: ROOT, encoding: "utf8" }).trim(); } catch (e) {}
if (last && G.news && last > G.news.date) console.log(`알림: 화면을 ${last}에 고쳤는데 「이번에 바뀐 것」은 ${G.news.date}입니다 — 눈에 보이는 변화면 guides.js news 를 새로 쓰세요.`);
if (bad.length) { console.error("도움말 점검 실패\n- " + bad.join("\n- ")); process.exit(1); }
console.log(`도움말 점검 통과 — 도움말 있는 화면 ${used.size}곳`);
