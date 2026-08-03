// 삽화 조립 — AI에게 도형 배치만 받고 SVG 원문은 여기서 만든다.
// (AI에게 SVG를 통째로 시키면 토큰이 크고 깨진 마크업이 섞인다.)
// 색은 바우하우스 삼원색 팔레트 밖으로 나갈 수 없다 — 이름표를 화이트리스트로 쓴다(헌법).

export const ART_COLORS = {
  "빨강": "#E63329", "파랑": "#005BBB", "노랑": "#F5C518",
  "잉크": "#111111", "종이": "#F4F1EA"
};
export const ART_SIZE = { "칼럼": [1600, 900], "표지": [1200, 1600] };

export function artworkSvg(spec, 종류) {
  const [W, H] = ART_SIZE[종류] || ART_SIZE["칼럼"];
  const pct = (v, d) => {
    const n = Number(v);
    return Math.max(-20, Math.min(120, Number.isFinite(n) ? n : d));
  };
  const size = (v, d) => {
    const n = Number(v);
    return Math.max(2, Math.min(140, Number.isFinite(n) ? n : d));
  };
  const col = (v) => ART_COLORS[String(v)] || ART_COLORS["잉크"];
  const n1 = (v) => v.toFixed(1);
  const bg = ART_COLORS[String(spec && spec["배경"])] || ART_COLORS["종이"];

  const parts = (Array.isArray(spec && spec["도형"]) ? spec["도형"] : []).slice(0, 6).map((s) => {
    const x = pct(s["x"], 50) / 100 * W;
    const y = pct(s["y"], 50) / 100 * H;
    const w = size(s["w"], 20) / 100 * W;
    const h = size(s["h"], 20) / 100 * H;
    const f = col(s["색"]);
    const deg = Math.max(-180, Math.min(180, Number(s["회전"]) || 0));
    const rot = deg ? ` transform="rotate(${n1(deg)} ${n1(x + w / 2)} ${n1(y + h / 2)})"` : "";
    if (s["형"] === "원") {
      const r = size(s["w"], 20) / 100 * Math.min(W, H) / 2;
      return `<circle cx="${n1(x + r)}" cy="${n1(y + r)}" r="${n1(r)}" fill="${f}"/>`;
    }
    if (s["형"] === "삼각") {
      const pts = `${n1(x)},${n1(y + h)} ${n1(x + w)},${n1(y + h)} ${n1(x + w / 2)},${n1(y)}`;
      return `<polygon points="${pts}" fill="${f}"${rot}/>`;
    }
    return `<rect x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="${n1(h)}" fill="${f}"${rot}/>`;
  });

  // width·height를 박아 두어야 <img>로 실었을 때 고유 비율이 잡힌다
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + `<rect width="${W}" height="${H}" fill="${bg}"/>${parts.join("")}</svg>`;
}
