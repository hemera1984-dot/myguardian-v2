// 지면 사진 찾기 (2026-11-01 케어센터 고도화 3단계 — 「실제 이미지 자동으로 찾아서 넣을 수 있게」)
//
// 기사 소재에 따라 사진 갈래가 다르다(헌법 「지면 이미지」):
//   제품·작품 → 제작사 공식 페이지의 홍보 이미지(og:image) / 현장·사건·제도·개념 → 상업 이용·수정 허용 사진
//   (위키미디어 공용 + Pixabay·Pexels — 11-01 「삽화보다 실제 사진」). Openverse는 이 PC·운영 서버 둘 다 응답이 없어 걷었다.
// 서버가 바깥 주소를 받아 오므로 내부망으로 새지 않게 막는다(안전받기).
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { request } from "node:https";

const UA = { "User-Agent": "myguardian-care/1.0 (magazine photo desk; https://app.insurguard.life)" };

// 사설·루프백·링크로컬·멀티캐스트 — 서버 자신과 내부망
const 막을주소 = new BlockList();
[["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]]
  .forEach(([a, p]) => 막을주소.addSubnet(a, p, "ipv4"));
[["::", 127], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]]
  .forEach(([a, p]) => 막을주소.addSubnet(a, p, "ipv6"));
export const 막힌주소 = (ip) => 막을주소.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");

// 통신사·사진 에이전시 — 고쳐 써도 금지(헌법). 공식 페이지라고 돌아와도 여기 걸리면 버린다
const 금지호스트 = /(^|\.)(yna\.co\.kr|yonhapnews\.co\.kr|newsis\.com|news1\.kr|nocutnews\.co\.kr|reuters\.com|apnews\.com|afp\.com|epa\.eu|gettyimages\.[a-z.]+|shutterstock\.com|alamy\.com|ap\.org)$/i;
const 호스트 = (h) => String(h || "").replace(/\.+$/, "").replace(/^\[|\]$/g, "");   // 끝 점(img.yna.co.kr.)·IPv6 괄호를 뗀다
export const 금지된곳 = (주소) => { try { return 금지호스트.test(호스트(new URL(주소).hostname)); } catch { return true; } };

// 한 번 받기 — 검사한 주소로 연결을 고정한다(DNS를 다시 물어 내부망 주소로 바뀌는 것을 막는다). 인증서·SNI는 원래 호스트 이름 그대로
function 한번받기(u, 고정, 한도, 형식검사) {
  return new Promise((끝, 실패) => {
    // 소켓 timeout은 무응답만 본다 — 조금씩 흘려 보내는 응답도 끊기게 전체 시간을 따로 잰다
    const 시계 = setTimeout(() => req.destroy(new Error("응답이 늦습니다.")), 20000);
    const ok = (v) => { clearTimeout(시계); 끝(v); }, no = (e) => { clearTimeout(시계); 실패(e); };
    const 고정주소 = (_h, opts, cb) => (opts && opts.all ? cb(null, [고정]) : cb(null, 고정.address, 고정.family));
    const req = request(u, { headers: UA, lookup: 고정주소, timeout: 15000 }, (res) => {
      const 끊기 = (e) => { res.destroy(); no(e); };
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return ok({ 다음: res.headers.location }); }
      if (res.statusCode !== 200) return 끊기(new Error(`받지 못했습니다(${res.statusCode}).`));
      const 형식 = String(res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (형식검사 && !형식검사(형식)) return 끊기(new Error(`받을 수 없는 형식입니다(${형식 || "없음"}).`));
      if (Number(res.headers["content-length"] || 0) > 한도) return 끊기(new Error("파일이 너무 큽니다."));
      const 조각 = []; let 합 = 0;
      res.on("data", (c) => { 합 += c.length; if (합 > 한도) 끊기(new Error("파일이 너무 큽니다.")); else 조각.push(c); });
      res.on("end", () => ok({ 형식, bytes: Buffer.concat(조각) }));
      res.on("error", no);
    });
    req.on("timeout", () => req.destroy(new Error("응답이 늦습니다.")));
    req.on("error", no);
    req.end();
  });
}

// https 바깥 주소만, 받기 전 DNS로 내부망인지 보고 그 주소로 연결한다. 넘겨주기(리다이렉트)는 매번 다시 본다
export async function 안전받기(주소, 한도, 형식검사) {
  let u = new URL(주소);
  for (let k = 0; k <= 3; k++) {
    if (u.protocol !== "https:" || (u.port && u.port !== "443")) throw new Error("https 주소만 받습니다.");
    const h = 호스트(u.hostname);
    if (금지호스트.test(h)) throw new Error("통신사·사진 에이전시 이미지는 쓸 수 없습니다.");
    const 주소들 = isIP(h) ? [{ address: h, family: isIP(h) }] : await lookup(h, { all: true });
    if (!주소들.length || 주소들.some((a) => 막힌주소(a.address))) throw new Error("받을 수 없는 주소입니다.");
    const r = await 한번받기(u, 주소들[0], 한도, 형식검사);
    if (r.다음) { u = new URL(r.다음, u); continue; }
    return { 형식: r.형식, bytes: r.bytes, 주소: u.href };
  }
  throw new Error("넘겨주기가 너무 많습니다.");
}

// 형식 머리표만 믿지 않는다 — 실제 파일 첫 바이트가 그 그림 형식인지 본다
export function 그림인가(b, 형식) {
  if (!b || b.length < 12) return false;
  if (형식 === "image/jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (형식 === "image/png") return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (형식 === "image/gif") return b.subarray(0, 4).toString("latin1") === "GIF8";
  if (형식 === "image/webp") return b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
  return false;
}

// 공식 페이지 HTML에서 대표 그림(og:image·twitter:image)을 뽑는다
export function 대표그림(html, 페이지) {
  const 찾은 = [];
  for (const [태그] of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const 이름 = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(태그);
    const 값 = /content\s*=\s*["']([^"']+)["']/i.exec(태그);
    if (!이름 || !값 || !/^(og:image(:secure_url|:url)?|twitter:image(:src)?)$/i.test(이름[1])) continue;
    try {
      const u = new URL(값[1].replace(/&amp;/g, "&").trim(), 페이지);
      if (u.protocol === "https:" && !찾은.includes(u.href)) 찾은.push(u.href);
    } catch { /* 깨진 주소는 건너뛴다 */ }
  }
  return 찾은;
}

// ── 공용 사진(현장·사건) — 위키미디어 공용 + Openverse, 키 없이. 상업 이용·수정 허용만(cc0·pdm·by·by-sa) ──
// Pexels — 상업 이용·수정 허용(Pexels 라이선스). 키가 서버 환경변수에 있을 때만 찾는다. 개념 기사의 일반 장면 사진은 위키미디어에 거의 없다
// Pixabay — 상업 이용·수정 허용(Pixabay 콘텐츠 라이선스). 오래 걸어 두는 핫링크는 안 되고 받아서 쓰라는 규칙 — 우리는 미디어 창고에 받는다.
// Pexels가 새 API 키 발급을 멈춰서(2026-11-01) 개념 기사의 일반 장면은 이쪽이 주력이다. 키(PIXABAY_KEY)가 있을 때만 찾는다.
const PB = "https://pixabay.com/api/";
async function 픽사베이(q) {
  const key = process.env.PIXABAY_KEY;
  if (!key) return [];
  const r = await fetch(PB + "?" + new URLSearchParams({ key, q, image_type: "photo", orientation: "horizontal", safesearch: "true",
    min_width: "1000", per_page: "10", lang: "en" }), { headers: UA, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error("Pixabay 응답 " + r.status);
  return ((await r.json()).hits || []).filter((p) => p.largeImageURL && p.webformatURL).map((p) => ({
    받을주소: p.largeImageURL, 미리보기: p.webformatURL, 가로: p.imageWidth, 세로: p.imageHeight, 제목: 글만(p.tags) || "Pixabay 사진", 원본: p.pageURL,
    라이선스: "pixabay", 출처문구: `사진 ${글만(p.user) || "작자 미상"} · Pixabay`
  }));
}
const PX = "https://api.pexels.com/v1/search";
async function 펙셀(q) {
  const key = process.env.PEXELS_KEY;
  if (!key) return [];
  const r = await fetch(PX + "?" + new URLSearchParams({ query: q, per_page: "10", orientation: "landscape" }),
    { headers: { ...UA, Authorization: key }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error("Pexels 응답 " + r.status);
  return ((await r.json()).photos || []).filter((p) => p.width >= 1000 && p.src?.large2x).map((p) => ({
    받을주소: p.src.large2x, 미리보기: p.src.medium, 가로: p.width, 세로: p.height, 제목: 글만(p.alt) || "Pexels 사진", 원본: p.url,
    라이선스: "pexels", 출처문구: `사진 ${글만(p.photographer) || "작자 미상"} · Pexels`
  }));
}
const WM = "https://commons.wikimedia.org/w/api.php";
const 라이선스이름 = { cc0: "CC0", pdm: "퍼블릭 도메인", by: "CC BY", "by-sa": "CC BY-SA" };
const wmLic = (s) => { s = String(s || "").toLowerCase(); return /^(pd|public domain)/.test(s) ? "pdm" : /^cc0/.test(s) ? "cc0" : /^cc-by-sa-\d/.test(s) ? "by-sa" : /^cc-by-\d/.test(s) ? "by" : null; };
const 글만 = (s) => String(s || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
const 판 = (s) => (/([\d.]+)/.exec(String(s || "")) || [])[1] || "";

async function 받아JSON(url) {
  for (let k = 0; ; k++) {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
    // 위키미디어는 몰아 받으면 429 — 짧게 쉬고 두 번까지(모션보드에서 겪은 것)
    if (r.status === 429 && k < 2) { await new Promise((ok) => setTimeout(ok, 2000 * (k + 1))); continue; }
    if (!r.ok) throw new Error("사진 검색 응답 " + r.status);
    return r.json();
  }
}

export async function 공용사진(검색어) {
  const q = String(검색어 || "").trim().slice(0, 100);
  if (!q) return [];
  const [wm, px, pb] = await Promise.allSettled([
    받아JSON(WM + "?" + new URLSearchParams({ action: "query", format: "json", prop: "imageinfo", iiprop: "url|size|extmetadata",
      generator: "search", gsrsearch: q + " filetype:bitmap", gsrnamespace: "6", gsrlimit: "12", iiurlwidth: "1600" })),
    펙셀(q),
    픽사베이(q)
  ]);
  const 위키 = wm.status === "fulfilled" ? Object.values(wm.value.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0)).map((p) => {
    const ii = p.imageinfo?.[0] || {}, m = ii.extmetadata || {};
    const lic = wmLic(m.License?.value || m.LicenseShortName?.value);
    if (!lic || (ii.width || 0) < 1000 || !ii.thumburl) return null;
    const 이름 = 글만(m.Artist?.value) || "작자 미상";
    // 미리보기는 500px — 위키미디어는 정해진 폭(250·330·500·960…)만 준다. 480은 400으로 거절(2026-11-01)
    return { 받을주소: ii.thumburl, 미리보기: ii.thumburl.replace(/\/\d+px-/, "/500px-"), 가로: ii.width, 세로: ii.height,
      제목: 글만(p.title).replace(/^File:|\.\w+$/g, ""), 원본: ii.descriptionurl, 라이선스: lic,
      출처문구: `사진 ${이름} · ${(라이선스이름[lic] + " " + (lic.startsWith("by") ? 판(m.LicenseShortName?.value) : "")).trim()} · 위키미디어 공용` };
  }).filter(Boolean) : [];
  const 펙 = px.status === "fulfilled" ? px.value : [], 픽 = pb.status === "fulfilled" ? pb.value : [];
  if (px.status === "rejected") console.warn("Pexels 검색 실패:", px.reason.message);
  if (pb.status === "rejected") console.warn("Pixabay 검색 실패:", pb.reason.message);
  if (!위키.length && !펙.length && !픽.length && wm.status === "rejected") throw new Error(wm.reason.message);
  // 번갈아 놓는다 — 눈 확인은 앞 12장만 보므로 한쪽이 앞을 다 차지하지 않게
  const 섞음 = [];
  for (let i = 0; i < Math.max(위키.length, 펙.length, 픽.length); i++) [위키[i], 픽[i], 펙[i]].forEach((x) => x && 섞음.push(x));
  return 섞음.filter((x) => !금지된곳(x.받을주소));
}

// 직접 실행: node photo.js — 주소 막기·대표그림 뽑기 점검(네트워크 없이)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const assert = (await import("node:assert")).default;
  ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.0.10", "169.254.169.254", "100.100.1.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0"]
    .forEach((ip) => assert.ok(막힌주소(ip), ip + " 는 막혀야 한다"));
  ["8.8.8.8", "142.250.1.1", "172.66.153.86", "2606:4700::1111"].forEach((ip) => assert.ok(!막힌주소(ip), ip + " 는 열려야 한다"));
  assert.deepEqual(대표그림(`<meta content="/a.jpg?x=1&amp;y=2" property="og:image"><meta name="twitter:image" content="https://cdn.x.com/b.png"><meta property="og:title" content="t">`,
    "https://maker.com/game/"), ["https://maker.com/a.jpg?x=1&y=2", "https://cdn.x.com/b.png"]);
  assert.ok(금지된곳("https://img.yna.co.kr/a.jpg") && 금지된곳("https://img.yna.co.kr./a.jpg") && 금지된곳("https://media.gettyimages.com/x") && !금지된곳("https://www.callofduty.com/x"));
  assert.ok(그림인가(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]), "image/jpeg") && !그림인가(Buffer.from("<html>not-an-image</html>"), "image/jpeg"));
  await assert.rejects(안전받기("https://[::1]/a.jpg", 1000), /받을 수 없는/);
  await assert.rejects(안전받기("http://example.com/a.jpg", 1000), /https/);
  await assert.rejects(안전받기("https://127.0.0.1/a.jpg", 1000), /받을 수 없는/);
  console.log("photo.js 점검 통과");
}
