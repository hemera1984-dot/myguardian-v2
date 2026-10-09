// 로컬 시험 서버 — 빈 DB에 계정 둘(총관리자·팀원)과 가상 고객 여덟 명을 심고 API를 8787에 띄운다.
// 화면은 따로 정적 서버로 띄운다(.claude/launch.json 「mg-web-8081」 또는 python -m http.server 8081 --directory web).
// localhost에서 열면 auth.js가 API를 http://localhost:8787 로 잡는다.
// 실행: node scripts/dev-server.mjs   (끄면 DB도 버린다 — 시험 데이터는 저장소 밖 임시 폴더에만 생긴다)
// 로그인: 띄운 뒤 콘솔에 찍히는 한 줄을 브라우저 콘솔에 붙이면 그 계정으로 들어가 있다.
//        자동 검사(Playwright)는 임시 폴더의 tokens.json 을 읽어 localStorage 「mg_session」에 넣는다.
// 고객 이름은 가운데를 가린 가상 이름, 번호는 010-0000-0000대 — 실데이터를 넣지 않는다(헌법 개인정보).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 8787);
const HERE = join(tmpdir(), "mg-dev").split(String.fromCharCode(92)).join("/");
rmSync(HERE, { recursive: true, force: true });
mkdirSync(HERE, { recursive: true });
Object.assign(process.env, {
  PORT: String(PORT), DB_FILE: HERE + "/mg.db", GOOGLE_CLIENT_ID: "dev.apps.googleusercontent.com",
  ALLOWED_ORIGINS: "http://localhost:8081,http://127.0.0.1:8081", BOOTSTRAP_ADMINS: "boss@dev.test",
  MEDIA_DIR: HERE + "/media", CARE_DIR: HERE + "/care", BRIEF_DIR: HERE + "/brief", REQ_DIR: HERE + "/req",
  MEDIA_BASE: `http://localhost:${PORT}/media`, BRANCH_API: "http://127.0.0.1:9",
  MG_DATA_KEY: randomBytes(32).toString("hex")   // 띄울 때마다 새 열쇠 — 임시 DB와 함께 버려진다
});

const ROOT = new URL("../server/", import.meta.url);
const d = await import(new URL("db.js", ROOT).href);
const db = d.openDb(process.env.DB_FILE);
d.seedGrades(db, [{ code: "BM", name: "지점장", rank: 1 }, { code: "SSL", name: "팀장", rank: 3 }, { code: "FC", name: "팀원", rank: 5 }]);
const boss = d.upsertAccount(db, { sub: "dev0", email: "boss@dev.test", name: "시험 총관리자" }, ["boss@dev.test"]);
const fc = d.upsertAccount(db, { sub: "dev1", email: "fc@dev.test", name: "시험 팀원" }, []);
d.approve(db, { targetId: fc.id, grade: "FC", parentId: boss.id, approverId: boss.id });
const tokens = { boss: d.createSession(db, boss.id).token, fc: d.createSession(db, fc.id).token };
db.close();
await import(new URL("server.js", ROOT).href);
await new Promise((r) => setTimeout(r, 300));

// 오늘 기준 날짜 — 홈 「오늘」·고객관리 보기 단추가 다 차게 어제·오늘·내일·다음 주로 흩는다
const day = (n) => { const t = new Date(); t.setDate(t.getDate() + n); return t.toISOString().slice(0, 10); };
const 고객 = [
  ["김*수", "transfer", "미팅 예정", [{ "차수": 2, "일자": day(0), "상태": "예정" }]],
  ["정*운", "valueup", "미팅 예정", [{ "차수": 1, "일자": day(0), "상태": "예정" }]],
  ["박*수", "contract", "미팅 예정", [{ "차수": 1, "일자": day(1), "상태": "예정" }]],
  ["오*진", "referral", "미팅 예정", [{ "차수": 1, "일자": day(3), "상태": "예정" }]],
  ["최*은", "transfer", "다시 전화", [{ "차수": 1, "일자": day(-2), "상태": "예정" }]],
  ["윤*호", "contract", "미팅 완료", [{ "차수": 1, "일자": day(-5), "상태": "완료" }]],
  ["이*희", "valueup", "다시 전화", []],
  ["한*람", "referral", "보류", []]
].map(([이름, cat, st, 미팅], i) => ({
  "고객코드": "C-2026-" + String(i + 1).padStart(3, "0"),
  profile: { customerName: 이름, category: cat, phone: "010-0000-" + String(1000 + i), age: 38 + i * 3,
    "진행상태": st, "미팅": 미팅, ...(이름 === "이*희" ? { nextContactDate: day(2) } : {}),
    ...(이름 === "한*람" ? { nextContactDate: day(-1) } : {}) },
  policies: { policies: i % 3 === 0 ? [{ productName: "종신보험", contractDate: "2021-03-02" }] : [] },
  memoText: "# 상담 메모\n"
}));
for (const who of ["boss", "fc"]) {
  const r = await fetch(`http://localhost:${PORT}/clients`, {
    method: "PUT", headers: { Authorization: "Bearer " + tokens[who], "Content-Type": "application/json" },
    body: JSON.stringify(고객)
  });
  if (!r.ok) throw new Error(`가상 고객 심기 실패(${who}): ${r.status}`);
}
writeFileSync(HERE + "/tokens.json", JSON.stringify(tokens));
console.log(`\n시험 API: http://localhost:${PORT}  (DB ${HERE}/mg.db)`);
console.log(`토큰 파일: ${HERE}/tokens.json`);
console.log(`브라우저 콘솔에 붙이기(총관리자): localStorage.setItem("mg_session", "${tokens.boss}"); location.reload()`);
