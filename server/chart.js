// 데이터 그림 — 기사 안의 실제 수치로 그린다.
//
// 종전 삽화(artwork.js)는 네모·원·삼각을 아무 데나 놓는 것이라 기사와 아무 상관이 없었다.
// 그래서 지면에 붙여 놓으면 오히려 이상했다. 코드로 그려서 값어치가 나오는 건 추상 도형이
// 아니라 **기사가 실제로 든 숫자**다 — 경제지가 쓰는 그림이 그것이다.
//
// AI에게는 «어떤 수치를 어떤 모양으로» 만 받고 SVG 원문은 여기서 만든다.
// 색은 팔레트 밖으로 나가지 못한다(헌법). 값이 둘 미만이면 아예 그리지 않는다 —
// 가짜 수치로 채운 그림을 만들지 않는다(헌법: 밀도는 실데이터로만).

const 색 = { 빨강: "#E63329", 파랑: "#005BBB", 노랑: "#F5C518", 잉크: "#111111", 종이: "#F4F1EA" };
const W = 1600, H = 900;
const 여백 = { 좌: 150, 우: 90, 상: 190, 하: 150 };

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n1 = (v) => Number(v).toFixed(1);

// 사람이 읽는 축 눈금 — 1·2·5 배수로 올린다
function 눈금(최대) {
  if (!(최대 > 0)) return [0, 1];
  const 자리 = Math.pow(10, Math.floor(Math.log10(최대)));
  const 단 = [1, 2, 2.5, 5, 10].map((m) => m * 자리).find((v) => 최대 <= v * 4) || 자리 * 10;
  const out = [];
  for (let v = 0; v <= 최대 + 단 / 2; v += 단) out.push(v);
  return out.length > 1 ? out : [0, 최대];
}

const 축표기 = (v) => {
  const a = Math.abs(v);
  if (a >= 10000) return (v / 10000).toLocaleString("ko-KR", { maximumFractionDigits: 1 }) + "만";
  return v.toLocaleString("ko-KR", { maximumFractionDigits: 1 });
};

function 머리(제목, 단위) {
  return `<text x="${여백.좌}" y="96" font-size="52" font-weight="700" fill="${색.잉크}">${esc(제목)}</text>`
    + (단위 ? `<text x="${여백.좌}" y="146" font-size="30" fill="#5b5b5b">단위: ${esc(단위)}</text>` : "");
}

function 꼬리(출처) {
  return 출처 ? `<text x="${여백.좌}" y="${H - 46}" font-size="26" fill="#7a7a7a">${esc(출처)}</text>` : "";
}

// 막대 — 몇 개를 나란히 견줄 때
function 막대(항목, 강조) {
  const 최대 = Math.max(...항목.map((i) => i.값));
  const ticks = 눈금(최대);
  const 상한 = ticks[ticks.length - 1];
  const 폭 = W - 여백.좌 - 여백.우;
  const 높 = H - 여백.상 - 여백.하;
  const 칸 = 폭 / 항목.length;
  const 막 = Math.min(칸 * 0.56, 170);
  const y0 = 여백.상 + 높;

  let out = ticks.map((t) => {
    const y = y0 - (t / 상한) * 높;
    return `<line x1="${여백.좌}" y1="${n1(y)}" x2="${W - 여백.우}" y2="${n1(y)}" stroke="#d8d3c8" stroke-width="${t === 0 ? 3 : 1}"/>`
      + `<text x="${여백.좌 - 18}" y="${n1(y + 10)}" font-size="26" fill="#7a7a7a" text-anchor="end">${축표기(t)}</text>`;
  }).join("");

  out += 항목.map((it, i) => {
    const h = (it.값 / 상한) * 높;
    const x = 여백.좌 + 칸 * i + (칸 - 막) / 2;
    const y = y0 - h;
    const c = (강조 === i) ? 색.빨강 : 색.파랑;
    return `<rect x="${n1(x)}" y="${n1(y)}" width="${n1(막)}" height="${n1(h)}" fill="${c}"/>`
      + `<text x="${n1(x + 막 / 2)}" y="${n1(y - 20)}" font-size="34" font-weight="700" fill="${c}" text-anchor="middle">${esc(it.표기 || 축표기(it.값))}</text>`
      + `<text x="${n1(x + 막 / 2)}" y="${n1(y0 + 46)}" font-size="28" fill="${색.잉크}" text-anchor="middle">${esc(it.이름)}</text>`;
  }).join("");
  return out;
}

// 선 — 시간에 따른 흐름
function 선(항목, 강조) {
  const 값들 = 항목.map((i) => i.값);
  const 최대 = Math.max(...값들), 최소 = Math.min(0, Math.min(...값들));
  const ticks = 눈금(최대);
  const 상한 = ticks[ticks.length - 1];
  const 폭 = W - 여백.좌 - 여백.우;
  const 높 = H - 여백.상 - 여백.하;
  const y0 = 여백.상 + 높;
  const X = (i) => 여백.좌 + (항목.length === 1 ? 폭 / 2 : (폭 * i) / (항목.length - 1));
  const Y = (v) => y0 - ((v - 최소) / (상한 - 최소 || 1)) * 높;

  let out = ticks.map((t) => {
    const y = Y(t);
    return `<line x1="${여백.좌}" y1="${n1(y)}" x2="${W - 여백.우}" y2="${n1(y)}" stroke="#d8d3c8" stroke-width="${t === 0 ? 3 : 1}"/>`
      + `<text x="${여백.좌 - 18}" y="${n1(y + 10)}" font-size="26" fill="#7a7a7a" text-anchor="end">${축표기(t)}</text>`;
  }).join("");

  out += `<polyline points="${항목.map((it, i) => `${n1(X(i))},${n1(Y(it.값))}`).join(" ")}" fill="none" stroke="${색.파랑}" stroke-width="7" stroke-linejoin="round"/>`;
  out += 항목.map((it, i) => {
    const c = (강조 === i) ? 색.빨강 : 색.파랑;
    const r = (강조 === i) ? 18 : 12;
    return `<circle cx="${n1(X(i))}" cy="${n1(Y(it.값))}" r="${r}" fill="${c}"/>`
      + ((강조 === i || i === 0 || i === 항목.length - 1)
          ? `<text x="${n1(X(i))}" y="${n1(Y(it.값) - 32)}" font-size="34" font-weight="700" fill="${c}" text-anchor="middle">${esc(it.표기 || 축표기(it.값))}</text>` : "")
      + `<text x="${n1(X(i))}" y="${n1(y0 + 46)}" font-size="28" fill="${색.잉크}" text-anchor="middle">${esc(it.이름)}</text>`;
  }).join("");
  return out;
}

// 견줌 — 둘을 크게 맞세울 때 (막대보다 강하다)
function 견줌(항목) {
  const a = 항목[0], b = 항목[1];
  const 최대 = Math.max(a.값, b.값) || 1;
  const 폭 = W - 여백.좌 - 여백.우;
  const 줄높 = 150;
  const y = 여백.상 + 60;
  return [a, b].map((it, i) => {
    const w = (it.값 / 최대) * 폭;
    const c = i === 0 ? 색.파랑 : 색.빨강;
    const ty = y + i * (줄높 + 110);
    return `<text x="${여백.좌}" y="${n1(ty - 22)}" font-size="34" fill="${색.잉크}">${esc(it.이름)}</text>`
      + `<rect x="${여백.좌}" y="${n1(ty)}" width="${n1(w)}" height="${줄높}" fill="${c}"/>`
      + `<text x="${n1(여백.좌 + 30)}" y="${n1(ty + 저(줄높))}" font-size="66" font-weight="700" fill="${색.종이}">${esc(it.표기 || 축표기(it.값))}</text>`;
  }).join("");
}
const 저 = (h) => h / 2 + 24;

export function chartSvg(spec) {
  const 항목 = (Array.isArray(spec && spec["항목"]) ? spec["항목"] : [])
    .map((i) => ({ 이름: String(i["이름"] || "").slice(0, 24), 값: Number(i["값"]), 표기: i["표기"] ? String(i["표기"]).slice(0, 20) : "" }))
    .filter((i) => Number.isFinite(i.값))
    .slice(0, 12);
  // 값이 둘 미만이면 그리지 않는다 — 가짜로 채우지 않는다(헌법)
  if (항목.length < 2) return null;

  const 종류 = ["막대", "선", "견줌"].includes(spec["종류"]) ? spec["종류"] : "막대";
  let 강조 = Number(spec["강조"]);
  강조 = Number.isInteger(강조) && 강조 >= 0 && 강조 < 항목.length ? 강조 : -1;

  const 몸 = 종류 === "선" ? 선(항목, 강조)
    : 종류 === "견줌" && 항목.length >= 2 ? 견줌(항목.slice(0, 2))
    : 막대(항목, 강조);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + `<rect width="${W}" height="${H}" fill="${색.종이}"/>`
    + 머리(String(spec["제목"] || "").slice(0, 60), String(spec["단위"] || "").slice(0, 20))
    + 몸 + 꼬리(String(spec["출처"] || "").slice(0, 80))
    + `</svg>`;
}
