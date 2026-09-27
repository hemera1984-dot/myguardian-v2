// 지면 삽화 — AI가 SVG를 직접 그리고, 서버는 허용 목록으로 다시 조립해서 저장한다(2026-09-27).
// 종전(2026-08)은 도형 3~6개의 좌표만 받아 흩어 놓았더니 기사와 상관없는 추상화가 됐다.
// 지금은 기사의 핵심을 사물·장면 하나로 그리게 한다. 받은 원문은 믿지 않는다 —
// 태그·속성을 목록에 있는 것만 옮겨 적고, 글자·스크립트·외부 참조는 버리고, 색은 팔레트로 끌어온다.

export const ART_COLORS = {
  "빨강": "#E63329", "파랑": "#005BBB", "노랑": "#F5C518",
  "잉크": "#111111", "종이": "#F4F1EA"
};
export const ART_SIZE = { "칼럼": [1600, 900], "표지": [1200, 1600] };

const PALETTE = Object.values(ART_COLORS).map((h) => [h, parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
const TAGS = new Set(["g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "defs", "clipPath", "linearGradient", "radialGradient", "stop"]);
const DRAWN = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);
const NUM = /^[-+0-9.eE,\s%]{1,2000}$/;
const ATTRS = {
  "id": /^[A-Za-z][\w-]{0,40}$/,
  "d": /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]{1,40000}$/,
  "points": NUM, "x": NUM, "y": NUM, "width": NUM, "height": NUM, "cx": NUM, "cy": NUM, "r": NUM,
  "rx": NUM, "ry": NUM, "x1": NUM, "y1": NUM, "x2": NUM, "y2": NUM, "fx": NUM, "fy": NUM, "fr": NUM,
  "offset": NUM, "stroke-width": NUM, "stroke-dasharray": NUM, "stroke-miterlimit": NUM,
  "opacity": NUM, "fill-opacity": NUM, "stroke-opacity": NUM, "stop-opacity": NUM,
  "stroke-linecap": /^(butt|round|square)$/, "stroke-linejoin": /^(miter|round|bevel)$/,
  "fill-rule": /^(nonzero|evenodd)$/, "clip-rule": /^(nonzero|evenodd)$/,
  "gradientUnits": /^(userSpaceOnUse|objectBoundingBox)$/, "clipPathUnits": /^(userSpaceOnUse|objectBoundingBox)$/,
  "transform": /^((translate|rotate|scale|matrix|skewX|skewY)\([-+0-9.eE,\s]*\)\s*,?\s*){1,8}$/,
  "gradientTransform": /^((translate|rotate|scale|matrix|skewX|skewY)\([-+0-9.eE,\s]*\)\s*,?\s*){1,8}$/,
  "clip-path": /^url\(#[A-Za-z][\w-]{0,40}\)$/
};
const COLOR_ATTRS = new Set(["fill", "stroke", "stop-color"]);
const NAMED = { black: "#111111", white: "#F4F1EA", red: "#E63329", blue: "#005BBB", yellow: "#F5C518" };

// 팔레트 밖 색은 가장 가까운 팔레트 색으로 끌어온다 — 거부하면 그림이 통째로 비어 버린다
function paletteColor(v) {
  const s = String(v).trim();
  if (s === "none" || s === "transparent") return "none";
  if (/^url\(#[A-Za-z][\w-]{0,40}\)$/.test(s)) return s;
  let hex = NAMED[s.toLowerCase()] || s;
  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  if (m3) hex = "#" + m3[1] + m3[1] + m3[2] + m3[2] + m3[3] + m3[3];
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return ART_COLORS["잉크"];
  const [r, g, b] = [1, 2, 3].map((i) => parseInt(m[i], 16));
  let best = PALETTE[0], bd = Infinity;
  for (const p of PALETTE) {
    const d = (p[1] - r) ** 2 + (p[2] - g) ** 2 + (p[3] - b) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best[0];
}

// AI가 쓴 SVG를 받아 안전한 SVG로 다시 쓴다. 그릴 것이 셋 미만이면 null.
export function cleanArt(raw, 종류) {
  const [W, H] = ART_SIZE[종류] || ART_SIZE["칼럼"];
  const src = String(raw || "").slice(0, 300000)
    .replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "").replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  const out = [], stack = [];
  let drawn = 0;
  const tagRe = /<\s*(\/)?\s*([A-Za-z][\w:-]*)((?:\s+[\w:-]+\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*)\s*(\/)?\s*>/g;
  let t;
  while ((t = tagRe.exec(src))) {
    const [, close, name, attrText, self] = t;
    if (!TAGS.has(name)) continue;               // svg·text·image·script·style·use·filter… 전부 버린다
    if (close) {
      const at = stack.lastIndexOf(name);
      if (at < 0) continue;
      while (stack.length > at) out.push("</" + stack.pop() + ">");
      continue;
    }
    const attrs = [];
    const aRe = /([\w:-]+)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/g;
    let a;
    while ((a = aRe.exec(attrText))) {
      const k = a[1], v = (a[2] ?? a[3] ?? "").trim();
      if (COLOR_ATTRS.has(k)) { attrs.push(`${k}="${paletteColor(v)}"`); continue; }
      const rule = ATTRS[k];
      if (rule && rule.test(v)) attrs.push(`${k}="${v}"`);
    }
    if (DRAWN.has(name)) drawn += 1;
    if (self) out.push(`<${name}${attrs.length ? " " + attrs.join(" ") : ""}/>`);
    else { out.push(`<${name}${attrs.length ? " " + attrs.join(" ") : ""}>`); stack.push(name); }
  }
  while (stack.length) out.push("</" + stack.pop() + ">");
  if (drawn < 3) return null;
  // width·height를 박아 두어야 <img>로 실었을 때 고유 비율이 잡힌다
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + `<rect width="${W}" height="${H}" fill="${ART_COLORS["종이"]}"/>${out.join("")}</svg>`;
}

// 채널마다 무게를 다르게 준다 — 일간은 가볍게, 월간은 공들여
const CHANNEL_TONE = {
  "일간": "일간은 매일 나가는 한 꼭지다. 사물 하나를 크게, 요소는 적게(15~30개) 가볍게 그린다.",
  "주간": "주간은 바우하우스 포스터처럼 그린다. 사물 하나에 큰 색면 둘셋을 받쳐 강하게(20~50개).",
  "월간": "월간은 유통기한이 긴 주제를 다룬다. 사물 둘셋이 관계를 이루는 장면으로 공들여(30~70개)."
};

export function artPrompt({ 종류, 채널, 제목, 카테고리, 요약, 본문, 제목들 }) {
  const [W, H] = ART_SIZE[종류] || ART_SIZE["칼럼"];
  const 톤 = CHANNEL_TONE[Object.keys(CHANNEL_TONE).find((k) => String(채널).startsWith(k))] || CHANNEL_TONE["주간"];
  const 표지 = 종류 === "표지";
  return [
    표지
      ? `보험 설계사가 고객에게 보내는 잡지 "${채널}"의 표지 그림을 SVG로 그린다. 세로 판형 ${W}×${H}다.`
      : `보험 설계사가 고객에게 보내는 잡지 "${채널}"의 칼럼 삽화를 SVG로 그린다. 가로 판형 ${W}×${H}다.`,
    "",
    ...(표지
      ? ["이번 호 칼럼:", ...제목들.map((t) => "- " + t), "", "이 가운데 이번 호를 대표할 주제 하나를 골라 그린다."]
      : [`칼럼 제목: ${제목}`, 카테고리 ? `분야: ${카테고리}` : "", 요약 ? `요약: ${요약}` : "",
         본문 ? "본문(앞부분):\n" + 본문 : ""]),
    "",
    "가장 중요한 것 — 무엇에 관한 글인지 제목을 가려도 짐작되게 그린다.",
    "먼저 글의 핵심을 **구체적인 사물 하나나 장면 하나**로 정한다(장면 칸에 적는다). 도형을 흩어 놓는 추상화는",
    "안 된다 — 예전에 그렇게 했다가 「주제와 상관없어 보인다」는 평을 들었다.",
    "예) 상가를 사려고 친척에게 돈을 빌린 이야기 → 상가 건물 한 채와 그리로 이어지는 동전 줄.",
    "    연금을 언제 받을지 → 모래시계와 그 아래 쌓이는 동전. 상속 순위 → 계단 위 크기가 다른 사람 셋.",
    "    실손보험 청구 → 병원 건물 십자 표시와 서류 한 장. 건강보험료 → 우산 아래 집.",
    "돋보기·전구·물음표·체크 표시·톱니바퀴처럼 어느 글에나 붙는 소품은 쓰지 않는다 — 이 글에만 있는 사물을 찾는다.",
    "사물은 한눈에 그것으로 읽혀야 한다(뇌는 나무처럼 보이지 않게, 주름진 뇌 모양 그대로).",
    "",
    "양식 — 바우하우스 평면 그래픽:",
    "- 색은 다섯뿐: 빨강 #E63329, 파랑 #005BBB, 노랑 #F5C518, 잉크 #111111, 종이 #F4F1EA. 다른 색을 쓰지 않는다.",
    "- 사물은 원·사각·삼각·굵은 선으로 짓는다. 평면이다(그림자·질감·원근 없음). 윤곽선을 쓰면 잉크색, 굵기 8~16.",
    "- 사람은 얼굴 없는 기하 인형이다(원 머리 + 사다리꼴 몸). 실존 인물을 닮게 그리지 않는다.",
    "- 주인공 사물이 화면의 40~60%를 차지한다. 비대칭으로 앉히고, 큰 색면 하나는 화면 밖으로 걸쳐 나가게 한다.",
    "- 받침 색면의 자리·모양은 장면에 맞춰 매번 새로 정한다. 왼쪽 아래 파란 네모 같은 버릇을 되풀이하지 않는다.",
    표지
      ? "- 표지 위 25%에는 제호가, 아래 40%에는 표제 글자가 얹힌다. 주인공 사물은 세로 15~60% 사이에 두고 아래쪽은 단순한 색면으로 둔다."
      : "- 가장자리 여백을 살려 지면 본문 옆에 놓였을 때 숨이 트이게 한다.",
    "- " + 톤,
    "",
    "쓸 수 있는 것: g, path, rect, circle, ellipse, line, polyline, polygon, defs, clipPath, linearGradient, radialGradient, stop.",
    "속성은 좌표·fill·stroke·stroke-width·opacity·transform·clip-path 정도만. 좌표는 viewBox 기준 정수.",
    "쓰지 않는 것: 글자(text)·숫자·로고·통화 기호, image, filter, style, script, use, 외부 참조. 넣어도 서버가 지운다.",
    `svg 칸에는 <svg viewBox="0 0 ${W} ${H}"> 로 시작하는 완결된 SVG 원문만 넣는다. 배경은 첫 요소로 화면 전체를 덮는 rect.`,
    "의도 칸에는 무엇을 왜 그렸는지 한국어 한 줄."
  ].filter((l) => l !== "").join("\n");
}

export const ART_SCHEMA = {
  type: "object",
  properties: {
    장면: { type: "string" },
    svg: { type: "string" },
    의도: { type: "string" }
  },
  required: ["장면", "svg", "의도"],
  additionalProperties: false
};
