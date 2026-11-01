// 케어센터 공용 로직 — 서재·발행 데스크가 함께 쓴다
// (발신 서명, 카톡 문구 생성, 작성함 열기, 발행물 정렬)
(function () {
  "use strict";

  // 고객 서재는 platform.js를 부르지 않는다 — window.mg가 없으면 자체 이스케이프를 쓴다
  var esc = (window.mg && window.mg.esc) || function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  };
  var SENDER_KEY = "mg_care_sender";

  // 주간 카테고리 → 카톡 표기 (v1 실사용 양식)
  var CAT_LABEL = { "시사": "정치/사회", "경제": "경제/상속", "교양": "지식/교양", "보험": "보험/건강" };
  var BAR = "─────────────";

  function loadSender() {
    try {
      var saved = JSON.parse(localStorage.getItem(SENDER_KEY));
      if (saved && saved["이름"]) return saved;
    } catch (e) {}
    return { "이름": "안창민 FC", "소속": "신한라이프 하랑지점" };
  }

  function saveSender(s) {
    localStorage.setItem(SENDER_KEY, JSON.stringify(s));
  }

  // 서명 입력 줄 초기화 — sender-row가 있는 화면에서만 호출
  function bindSenderRow() {
    var nameInput = document.getElementById("sender-name");
    var orgInput = document.getElementById("sender-org");
    if (!nameInput || !orgInput) return;
    var s = loadSender();
    nameInput.value = s["이름"];
    orgInput.value = s["소속"];
    // 이 기기에서 서명을 정한 적이 없으면 로그인 계정으로 채운다 (FC마다 자기 이름으로 나가게)
    if (!s["이름"] && window.mgAuth && window.mgAuth.me) {
      window.mgAuth.me().then(function (info) {
        var acc = info && info["계정"];
        if (!acc || nameInput.value.trim()) return;
        nameInput.value = (acc["이름"] || "") + (acc["이름"] ? " FC" : "");
        if (!orgInput.value.trim()) orgInput.value = acc["소속"] || "신한라이프 하랑지점";
        saveSender({ "이름": nameInput.value.trim(), "소속": orgInput.value.trim() });
      }).catch(function () {});
    }
    var mark = document.getElementById("sender-saved");
    var t;
    function onChange() {
      saveSender({ "이름": nameInput.value.trim(), "소속": orgInput.value.trim() });
      if (mark) {
        mark.hidden = false;
        clearTimeout(t);
        t = setTimeout(function () { mark.hidden = true; }, 1200);
      }
    }
    nameInput.addEventListener("input", onChange);
    orgInput.addEventListener("input", onChange);
  }

  // 카톡에 붙일 주소 — 서버의 호별 표지 페이지로 보낸다.
  // 카톡 미리보기 로봇은 자바스크립트를 실행하지 않아서 issue.html?id=X 를 보내면
  // 호와 무관하게 정적으로 박힌 기본 표지만 읽는다(2026-08-17). 표지 페이지가
  // 호마다 다른 og 태그를 내주고 사람은 곧바로 지면으로 넘어간다.
  // 에디션(팀원 발행분)은 표지가 같으므로 지면 주소를 그대로 쓴다.
  function issueUrl(issue, edition) {
    if (edition) {
      return new URL("issue.html?id=" + encodeURIComponent(issue.id)
        + "&fc=" + encodeURIComponent(edition["코드"]), window.location.href).href;
    }
    return apiBase() + "/r/" + encodeURIComponent(issue.id);
  }

  // 공유 발행 에디션(결정 2026-07-20): edition을 주면 발행인·링크·서명이 그 FC로 바뀐다.
  // 내용은 원본 그대로, 편집장은 항상 안창민.
  // 발행월에 맞는 안부인사. 호 데이터에 "인사"가 없을 때만 쓰인다.
  // 고정 문장 하나로 두면 8월에 "환절기 건강 챙기세요"가 나간다.
  function seasonGreeting(발행일) {
    var m = Number(String(발행일 || "").slice(5, 7)) || (new Date().getMonth() + 1);
    if (m === 12 || m <= 2) return "추운 날씨에 건강 잘 챙기고 계신가요?";
    if (m <= 5) return "볕이 좋아지는 계절입니다. 잘 지내고 계신가요?";
    if (m <= 8) return "무더위에 건강 잘 챙기고 계신가요?";
    return "아침저녁으로 선선해졌습니다. 잘 지내고 계신가요?";
  }

  function kakaoText(issue, edition) {
    var s = edition
      ? { "이름": edition["이름"] + " FC", "소속": edition["소속"] }
      : loadSender();
    var url = issueUrl(issue, edition);
    var toc = issue["꼭지"] || [];
    var pubName = edition ? edition["이름"] : (issue["발행인"] || "안창민");
    var mag = "『" + issue["채널"] + " " + pubName + "』";
    var lines = ["안녕하세요, " + s["이름"] + "입니다.", ""];
    // 계절·시기 안부인사는 호마다 다르다 — 호 데이터의 "인사"를 쓰고, 없으면 발행월에 맞춘 문장.
    var greet = issue["인사"] || seasonGreeting(issue["발행일"]);
    if (issue["채널"] === "일간") {
      // 일간은 한 꼭지다. 안부인사를 매일 붙이면 금방 상투가 되므로 바로 본론으로 간다.
      lines.push(mag + " " + (issue["주차라벨"] || "") + " (통권 " + issue["호수"] + "호)", "");
      if (toc.length) {
        lines.push(toc[0]["제목"]);
        if (toc[0]["부제"]) lines.push(toc[0]["부제"]);
        lines.push("");
      }
    } else if (issue["채널"] === "주간") {
      lines.push(greet, "");
      lines.push(mag + " " + (issue["주차라벨"] || "") + " (통권 " + issue["호수"] + "호)");
      // 주간의 기본 꼭지는 보험·자산·세무다. 소재에 따라 칼럼마다 바꿀 수 있다(2026-08-17).
      lines.push("이번 주 칼럼이 발행되었습니다.", "");
      lines.push("[이번 주 칼럼]", BAR);
      toc.forEach(function (t) {
        lines.push((CAT_LABEL[t["카테고리"]] || t["카테고리"]) + " | " + t["제목"]);
      });
      lines.push(BAR, "");
      if (toc.length) lines.push("먼저 읽어보실 것: " + toc[0]["제목"], "");
    } else {
      lines.push(greet, "");
      lines.push(mag + " " + (issue["주차라벨"] || "") + "(통권 " + issue["호수"] + "호)가");
      lines.push("발행되었습니다.", "");
      lines.push("이번 호 주요 칼럼", BAR);
      toc.forEach(function (t, i) {
        lines.push((i + 1) + ". " + t["제목"]);
      });
      lines.push(BAR, "");
    }
    lines.push("아래 링크에서 바로 읽어보실 수 있습니다.");
    lines.push(url, "");
    lines.push("보험·절세·상속 관련 궁금한 점이 있으시면");
    lines.push("언제든 편하게 연락 주세요.", "");
    lines.push(s["이름"] + " | " + s["소속"]);
    return lines.join("\n");
  }

  // 카톡 작성함 열기 — compose 패널이 있는 화면에서만 동작
  function openCompose(issue, edition) {
    var panel = document.getElementById("compose");
    if (!panel) return;
    var pubName = edition ? edition["이름"] : (issue["발행인"] || "안창민");
    document.getElementById("compose-title").textContent =
      "카톡 문구 — " + issue["채널"] + " " + pubName + " " + issue["호수"] + "호 (수정 후 복사하세요)";
    document.getElementById("compose-text").value = kakaoText(issue, edition);
    panel.hidden = false;
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function bindCompose() {
    var copyBtn = document.getElementById("compose-copy");
    var closeBtn = document.getElementById("compose-close");
    if (!copyBtn) return;
    copyBtn.addEventListener("click", function () {
      window.mg.copy(document.getElementById("compose-text").value, this);
    });
    closeBtn.addEventListener("click", function () {
      document.getElementById("compose").hidden = true;
    });
  }

  // 발행인 명단 (공유 발행 에디션 대상). 실패 시 빈 배열 — 에디션 기능만 조용히 꺼진다.
  function loadPublishers() {
    return fetch(new URL("../../data/care/publishers.json", window.location.href))
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) { return Array.isArray(list) ? list : []; })
      .catch(function () { return []; });
  }

  function sortByDate(list) {
    return list.slice().sort(function (a, b) { return (b["발행일"] || "") < (a["발행일"] || "") ? -1 : 1; });
  }

  // ── 발행물 읽기 — 서버 우선, 정적 폴백 (2026-07-31 발행 버튼)
  // 서버 발행분은 API에만 있고, 과거 호는 정적 저장소에만 있다.
  // 목록은 둘을 id 기준으로 병합(서버 우선)하고, 서버가 죽어도 정적 열람은 그대로다.
  // 고객 서재에는 auth.js를 싣지 않는다(로그인 기능을 고객 화면에 들이지 않는다).
  // 그래서 서버 주소를 여기서도 판단한다 — 안 그러면 서버에 발행한 호가 고객 서재에 뜨지 않는다.
  function apiBase() {
    if (window.mgAuth) return window.mgAuth.apiBase();
    var h = location.hostname;
    return (h === "localhost" || h === "127.0.0.1") ? "http://localhost:8787" : "https://api.insurguard.life";
  }

  // 서버가 안 되면 서버 발행분이 목록에서 조용히 빠진다. 그 상태로 지면을 열면
  // 실제로 발행된 호를 "발행되지 않은 호"라고 안내하게 된다 — 장애 여부를 함께 돌려준다.
  var 목록장애 = false;
  function loadIssueList() {
    var staticP = fetch(new URL("../../data/care/issues.json", window.location.href))
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (d) { return Array.isArray(d) ? d : (d.data || []); })
      .catch(function () { return []; });
    var base = apiBase();
    var 서버실패 = false;
    var serverP = !base ? Promise.resolve([]) : fetch(base + "/care/issues")
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (d) { return Array.isArray(d) ? d : []; })
      .catch(function () { 서버실패 = true; return []; });
    return Promise.all([serverP, staticP]).then(function (res) {
      목록장애 = 서버실패;
      var seen = {};
      var merged = [];
      res[0].concat(res[1]).forEach(function (i) {
        if (!i || !i.id || seen[i.id]) return;
        seen[i.id] = 1;
        merged.push(i);
      });
      return sortByDate(merged);
    });
  }

  // 마지막 목록 조회에서 서버가 응답하지 않았는가
  function listHadTrouble() { return 목록장애; }

  // 본문 — 서버에 있으면 서버, 없거나(404) 죽었으면 정적 경로
  function loadIssueBody(meta) {
    function fromStatic() {
      if (!meta["본문파일"]) return Promise.reject(new Error("본문 없음"));
      return fetch(new URL("../../" + meta["본문파일"], window.location.href))
        .then(function (r) { if (!r.ok) throw new Error("본문 없음"); return r.json(); });
    }
    var base = apiBase();
    if (!base) return fromStatic();
    return fetch(base + "/care/issues/" + encodeURIComponent(meta.id))
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .catch(fromStatic);
  }

  // 발행된 호만 (초안 제외) — 서재·홈·최신호 공통 규칙
  function published(list) {
    return list.filter(function (i) { return i["상태"] !== "초안"; });
  }

  function drafts(list) {
    return list.filter(function (i) { return i["상태"] === "초안"; });
  }

  function latestByChannel(list, ch) {
    var sorted = sortByDate(published(list).filter(function (i) { return i["채널"] === ch; }));
    return sorted.length ? sorted[0] : null;
  }

  // ── 지면 조판 (2026-08-02 발행 데스크 재건)
  // issue.html(고객 지면)과 발행 데스크 미리보기가 같은 조판을 쓰도록 여기로 옮겼다.
  // 미리보기가 지면과 어긋나면 검토가 무의미해진다.
  var CAT_DISPLAY = { "HOT ISSUE": "주요 이슈", "LIFESTYLE": "생활", "INSIGHT": "통찰" };

  function displayCat(cat) {
    return CAT_DISPLAY[String(cat || "").toUpperCase()] || cat;
  }


  // 이미지 경로 — 저장소 상대경로는 지면 기준(../../)으로, 업로드 주소(/media/… · https://…)는 그대로
  function mediaSrc(path) {
    var s = String(path || "");
    if (s.charAt(0) === "/" || /^https?:\/\//.test(s)) return s;
    return "../../" + s;
  }

  // 발행일 "2026-07-27" → "2026년 7월 27일". 주차라벨이 이미 연도를 실었으면 연도를 생략한다.
  function displayDate(iso, weekLabel) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!m) return iso || "";
    var year = String(weekLabel || "").indexOf(m[1] + "년") === 0 ? "" : m[1] + "년 ";
    return year + Number(m[2]) + "월 " + Number(m[3]) + "일";
  }

  // ── 타임지풍 표지 + 고급 칼럼, 흰 바탕 (2026-11-01 케어센터 고도화) ──────
  // 헌법 「케어 지면 양식」. 시안: drafts/care-time/index.html. 스타일: assets/care-time.css.
  // 폰 가독성 우선 — 본문은 산세리프, 명조는 제목·인용·수치·드롭캡. 「졸리면 실패다」 —
  // 기사마다 섹션 색과 머리 틀이 다르고, 형광·큰 수치·인용·순서 번호가 한 화면마다 멈출 자리를 만든다.
  // 원문 문장만 다시 배치한다. 없는 사실·수치는 만들지 않는다.

  var NAV_HEADS = { "다음 칼럼": 1, "이전 칼럼": 1, "목록으로": 1 };
  var SIGNALS = /\d|핵심|중요|필수|반드시|결국|문제|위험|제한|보장|세금|상속|부도|보험|자산|연쇄|현실|전략|변화/;
  var ORDINALS = { "첫째": 1, "둘째": 2, "셋째": 3, "넷째": 4, "다섯째": 5 };
  var hlTurn = 0; // 자동 형광 간격 — 칼럼마다 0으로 되돌린다

  function isStat(t) { var p = t.indexOf(" — "); return p > 0 && /\d/.test(t.slice(0, p)); }
  function isAdvice(t) { return /^(첫째|둘째|셋째|넷째|다섯째|마지막으로),/.test(t); }
  function isExample(t) { return /^(예를 들어|다른 예시로)/.test(t); }
  function isCaution(t) { return !isAdvice(t) && !isExample(t) && /(반드시|꼼꼼히 확인|정확히 이해|주의해야|유의해야)/.test(t); }
  function isStatement(t) { return t.length <= 58 && !/[.!?。]$/.test(t) && !isAdvice(t); }

  // 섹션 색 (07-18 결정: 시사 레드 · 경제 블루 · 교양 바이올렛 · 보험 그린)
  var SEC_COLORS = [
    { c: "#b3261e", soft: "#f7dcd8" },
    { c: "#1f4e9c", soft: "#dbe6f7" },
    { c: "#5b3f8c", soft: "#e7def4" },
    { c: "#1d6b4c", soft: "#d6eee2" }
  ];
  var SEC_OF = {
    "시사": 0, "정치": 0, "사회": 0, "국제": 0, "주요 이슈": 0,
    "경제": 1, "부동산": 1, "세무": 1, "금융": 1, "증시": 1, "투자": 1,
    "교양": 2, "AI": 2, "기술": 2, "과학": 2, "문화": 2, "생활": 2, "통찰": 2,
    "보험": 3, "건강": 3, "상속": 3, "증여": 3, "연금": 3, "의료": 3
  };
  // 같은 호에서 이미 쓴 색이면 안 쓴 색으로 넘긴다 — 기사마다 색이 달라야 한다(헌법 「졸리면 실패다」 ④)
  function sectionColors(arts) {
    var used = {};
    return arts.map(function (a) {
      var cat = String(displayCat(a["카테고리"]) || "");
      var i = Object.prototype.hasOwnProperty.call(SEC_OF, cat) ? SEC_OF[cat] : -1;
      if (i < 0) Object.keys(SEC_OF).some(function (k) { if (cat.indexOf(k) >= 0) { i = SEC_OF[k]; return true; } return false; });
      if (i < 0 || used[i]) {
        for (var j = 0; j < SEC_COLORS.length; j++) {
          var n = ((i < 0 ? 0 : i) + j) % SEC_COLORS.length;
          if (!used[n]) { i = n; break; }
        }
      }
      if (i < 0) i = 0;
      used[i] = true;
      return SEC_COLORS[i];
    });
  }

  // 자동 형광 대상 절 — 편집장이 고른 형광이 없는 호(지난 호)에서만 쓴다
  function keyPhrase(text) {
    var clauses = (text.match(/[^,.;:!?。]+(?:[,.;:!?。]|$)/g) || [text])
      .map(function (v) { return v.trim(); })
      .filter(function (v) { return v.length >= 8; });
    var best = clauses[0] || text.trim();
    var score = -Infinity;
    clauses.forEach(function (clause, index) {
      var value = (SIGNALS.test(clause) ? 8 : 0)
        + (clause.length >= 12 && clause.length <= 44 ? 4 : 0) - index * 0.15;
      if (/^(예를 들어|또한|하지만|따라서|이러한|이는|특히),?/.test(clause)) value -= 2;
      if (value > score) { score = value; best = clause; }
    });
    if (best.length > 42) {
      var cut = best.slice(0, 42);
      var space = cut.lastIndexOf(" ");
      if (space >= 18) cut = cut.slice(0, space);
      best = cut;
    }
    return best.replace(/[,.;:!?。]$/, "");
  }

  // 문단 글 — 형광은 문단당 한 곳까지(헌법). marks가 배열이면 편집장 선택만, 없으면 문단 걸러 자동.
  function proseHtml(text, marks) {
    var html = esc(text);
    var phrases = marks ? marks : [];
    if (!marks) {
      hlTurn += 1;
      if (hlTurn % 2 === 1 && text.length >= 60) phrases = [keyPhrase(text)];
    }
    phrases.some(function (m) {
      var e = esc(m || "");
      var k = e ? html.indexOf(e) : -1;
      if (k < 0) return false;
      html = html.slice(0, k) + "<mark>" + e + "</mark>" + html.slice(k + e.length);
      return true;
    });
    return html.replace(/^(첫째|둘째|셋째|넷째|다섯째|마지막으로),/, "<b>$1,</b>");
  }

  function statHtml(text) {
    var p = text.indexOf(" — ");
    return '<div class="stat"><b>' + esc(text.slice(0, p)) + "</b><span>" + esc(text.slice(p + 3)) + "</span></div>";
  }

  function tableHtml(headers, rows) {
    var h = ['<div class="table-wrap table-scroll" tabindex="0" role="region" aria-label="표">'];
    if (headers.length >= 4) h.push('<p class="swipe">표는 옆으로 밀어 보실 수 있습니다</p>');
    h.push('<table class="tbl"><thead><tr>');
    headers.forEach(function (v) { h.push("<th>" + esc(v) + "</th>"); });
    h.push("</tr></thead><tbody>");
    rows.forEach(function (row) {
      h.push("<tr>");
      row.forEach(function (v) { h.push("<td>" + esc(v) + "</td>"); });
      h.push("</tr>");
    });
    h.push("</tbody></table></div>");
    return h.join("");
  }

  // 표 행 — 탭 문단이 이어진 것이든, 한 문단 안에 줄바꿈으로 든 것이든 줄마다 한 행
  function tableRows(text) {
    return String(text).split("\n").filter(function (r) { return r.trim(); })
      .map(function (r) { return r.split("\t"); });
  }

  // 본문 블록 → 토큰. 표(탭 구조)·소제목·수치·조언·주의·단문·문단으로 가른다.
  function tokenize(blocks) {
    var toks = [];
    var i = 0;
    while (i < blocks.length) {
      var b = blocks[i];
      if (b.t === "h" && b.x.indexOf("\t") >= 0) {
        var headers = b.x.split("\t");
        var rows = [];
        i++;
        while (i < blocks.length && blocks[i].t === "p" && blocks[i].x.indexOf("\t") >= 0) { rows = rows.concat(tableRows(blocks[i].x)); i++; }
        toks.push({ k: "table", headers: headers, rows: rows });
        continue;
      }
      if (b.t === "p" && b.x.indexOf("\t") >= 0) {
        var rows2 = [];
        while (i < blocks.length && blocks[i].t === "p" && blocks[i].x.indexOf("\t") >= 0) { rows2 = rows2.concat(tableRows(blocks[i].x)); i++; }
        toks.push({ k: "table", headers: rows2[0] || [], rows: rows2.slice(1) });
        continue;
      }
      if (b.t === "h") toks.push({ k: "h", x: b.x });
      else if (isStat(b.x)) toks.push({ k: "stat", x: b.x });
      else if (isAdvice(b.x)) toks.push({ k: "advice", x: b.x });
      else if (isExample(b.x) || isCaution(b.x)) toks.push({ k: "note", x: b.x });
      else if (isStatement(b.x)) toks.push({ k: "statement", x: b.x });
      else toks.push({ k: "p", x: b.x });
      i++;
    }
    return toks;
  }

  // 기사 이동 — 본문 말미의 "다음 칼럼/이전 칼럼" 헤딩을 링크로 바꾼다
  function articleNavHtml(navBlocks, arts) {
    var h = [];
    var type = "";
    navBlocks.forEach(function (b) {
      if (b.t !== "h") return;
      if (b.x === "다음 칼럼" || b.x === "이전 칼럼") { type = b.x; return; }
      if (b.x === "목록으로") return;
      if (!type) return;
      var at = -1;
      arts.forEach(function (a, i) { if (a["제목"] === b.x) at = i; });
      h.push('<a href="' + (at >= 0 ? "#a" + (at + 1) : "#contents") + '">'
        + '<span class="nav-type">' + esc(type) + "</span>"
        + '<span class="nav-title">' + esc(b.x) + "</span></a>");
      type = "";
    });
    return h.length ? '<nav class="article-nav" aria-label="기사 이동">' + h.join("") + "</nav>" : "";
  }

  // 본문 — 편집장이 고른 형광(a.형광)·뽑은 인용(a.뽑은글)을 원문 자리에 놓는다
  function bodyHtml(a, arts) {
    var blocks = a["본문"] || [];
    var navAt = -1;
    blocks.forEach(function (b, i) { if (navAt < 0 && b.t === "h" && NAV_HEADS[b.x]) navAt = i; });
    var content = navAt < 0 ? blocks : blocks.slice(0, navAt);
    var navBlocks = navAt < 0 ? [] : blocks.slice(navAt);
    var toks = tokenize(content);
    var marks = Array.isArray(a["형광"]) ? a["형광"] : null;
    var pulls = (Array.isArray(a["뽑은글"]) ? a["뽑은글"] : []).filter(Boolean);
    var first = true;
    var h = [];
    hlTurn = 0;

    toks.forEach(function (t) {
      if (t.k === "table") { h.push(tableHtml(t.headers, t.rows)); return; }
      if (t.k === "h") { h.push('<h3 class="ct-h">' + esc(t.x) + "</h3>"); return; }
      if (t.k === "stat") { h.push(statHtml(t.x)); return; }
      if (t.k === "statement") { h.push('<blockquote class="pull">' + esc(t.x) + "</blockquote>"); return; }
      if (t.k === "note") { h.push('<aside class="ct-note">' + proseHtml(t.x, marks) + "</aside>"); return; }
      // 첫 문단은 리드 — 크게, 첫 글자가 한글·영숫자면 드롭캡
      var cls = "t";
      if (first) { cls += " lead" + (/^[가-힣A-Za-z0-9]/.test(t.x) && t.x.length >= 40 ? " drop" : ""); first = false; }
      var m = /^(첫째|둘째|셋째|넷째|다섯째),/.exec(t.x);
      h.push('<p class="' + cls + (m ? ' ord" data-n="' + ORDINALS[m[1]] : "") + '">' + proseHtml(t.x, marks) + "</p>");
      // 뽑은 인용 — 그 문장이 든 문단 바로 뒤에 한 번
      pulls = pulls.filter(function (q) {
        if (t.x.indexOf(q) < 0) return true;
        h.push('<blockquote class="pull">' + esc(q) + "</blockquote>");
        return false;
      });
    });
    // 마지막 문단 끝에 끝 표시
    for (var i = h.length - 1; i >= 0; i--) {
      if (/^<p class="t/.test(h[i])) { h[i] = h[i].replace(/<\/p>$/, '<span class="end" aria-hidden="true"></span></p>'); break; }
    }
    h.push(articleNavHtml(navBlocks, arts));
    return h.join("");
  }

  // 읽는 시간 — 한국어 분당 약 550자
  function readMinutes(a) {
    var n = 0;
    (a["본문"] || []).forEach(function (b) { n += String(b.x || "").length; });
    (a["요약"] || []).forEach(function (t) { n += String(t).length; });
    return Math.max(1, Math.round(n / 550));
  }

  function figcaptionHtml(cap, credit) {
    if (!cap && !credit) return "";
    return "<figcaption>" + (cap ? "<span>" + esc(cap) + "</span>" : "")
      + (credit ? '<span class="credit">' + esc(credit) + "</span>" : "") + "</figcaption>";
  }

  // 칼럼 머리 — 기사마다 틀이 다르다(헌법 ⑤). a.틀(사진·오프너·색면)이 있으면 그것, 없으면 차례로 돈다.
  var HEAD_KINDS = { "사진": "photo", "오프너": "opener", "색면": "band" };
  var HEAD_CYCLE = ["photo", "opener", "band"];
  function headHtml(a, i, n, dateText) {
    var kind = HEAD_KINDS[a["틀"]] || HEAD_CYCLE[i % HEAD_CYCLE.length];
    var img = a["이미지"] ? esc(mediaSrc(a["이미지"])) : "";
    if (!img && kind === "opener") kind = "band";
    var cap = a["이미지캡션"] || "";
    var credit = a["이미지출처"] || "";
    var head = '<p class="sect">' + esc(displayCat(a["카테고리"])) + " <span>" + (i + 1) + " / " + n + "</span></p>"
      + '<h2 class="ct-title">' + esc(a["제목"]) + "</h2>"
      + (a["부제"] ? '<p class="story-dek">' + esc(a["부제"]) + "</p>" : "");
    var byline = '<p class="byline"><span>글 <b>안창민 FC</b></span><span>' + esc(dateText) + "</span>"
      + "<span>읽는 데 약 " + readMinutes(a) + "분</span></p>";
    var alt = esc(cap || a["제목"] || "");

    if (kind === "opener") {
      return '<div class="opener"><img src="' + img + '" alt="' + alt + '">'
        + '<header class="story-head">' + head + "</header></div>"
        + '<div class="opener-meta">' + byline + figcaptionHtml(cap, credit) + "</div>";
    }
    if (kind === "band") {
      return '<div class="band"><header class="story-head">' + head + byline + "</header></div>"
        + (img ? '<figure class="band-fig"><img src="' + img + '" alt="' + alt + '" loading="lazy">' + figcaptionHtml(cap, credit) + "</figure>" : "");
    }
    return '<header class="story-head">' + head + byline + "</header>"
      + (img ? '<figure class="lead-fig"><img src="' + img + '" alt="' + alt + '" loading="lazy">' + figcaptionHtml(cap, credit) + "</figure>" : "");
  }

  // 칼럼 하나 — 머리 → 이 기사 한눈에 → 본문 → 설계사의 한 줄
  function articleHtml(a, i, arts, color, pub, dateText) {
    var h = ['<article class="article" id="a' + (i + 1) + '" style="--sec:' + color.c + ";--sec-soft:" + color.soft + '">'];
    h.push(headHtml(a, i, arts.length, dateText));
    h.push('<div class="body">');
    var sum = (a["요약"] || []).filter(Boolean);
    if (sum.length) {
      h.push('<aside class="brief"><h3>이 기사 한눈에</h3><ul>');
      sum.forEach(function (t) { h.push("<li>" + esc(t) + "</li>"); });
      h.push("</ul></aside>");
    }
    h.push(bodyHtml(a, arts));
    var say = (a["한마디"] || []).filter(Boolean);
    if (say.length) {
      h.push('<aside class="fc-note"><span>' + esc(pub) + " FC의 한 줄</span>");
      say.forEach(function (t) { h.push("<p>" + esc(t) + "</p>"); });
      h.push("</aside>");
    }
    h.push('<a class="ct-back" href="#contents">이번 호 차례로</a>');
    h.push("</div></article>");
    return h.join("");
  }

  // 제목 줄바꿈 — SVG는 자동 줄바꿈이 없어 글자 수로 끊는다
  function wrapLines(s, max, maxLines) {
    var out = [];
    var cur = "";
    String(s || "").split(/\s+/).filter(Boolean).forEach(function (w) {
      if (!cur) { cur = w; }
      else if ((cur + " " + w).length <= max) { cur += " " + w; }
      else { out.push(cur); cur = w; }
    });
    if (cur) out.push(cur);
    var cut = [];
    out.forEach(function (l) {
      while (l.length > max) { cut.push(l.slice(0, max)); l = l.slice(max); }
      if (l) cut.push(l);
    });
    if (cut.length > maxLines) {
      cut = cut.slice(0, maxLines);
      cut[maxLines - 1] = cut[maxLines - 1].slice(0, max - 1) + "…";
    }
    return cut;
  }

  // 표지 사진 — 올린 커버이미지, 없으면 첫 기사 이미지. 둘 다 없으면 글 표지(채널 색 면).
  function coverPhoto(meta, arts) {
    if (meta["커버이미지"]) return meta["커버이미지"];
    var a0 = arts && arts[0];
    return (a0 && a0["이미지"]) || "";
  }

  // 표지 제목 크기 — 길이에 따라 세 단. 편집장이 줄인 커버제목이 있으면 그것을 쓴다.
  function coverHeadClass(t) {
    var n = String(t || "").length;
    return n <= 14 ? "" : n <= 24 ? " is-mid" : " is-long";
  }

  // 서재·지난 호 표지 카드(축소판 SVG). 날짜·주차는 카드 아래 글이 맡는다(축소하면 7px 아래로 줄어 못 읽는다). 지면 첫 장(.cover)과 같은 구성 — 틀을 고칠 때는 두 곳을 함께.
  // 어두운 층은 장식이 아니라 가독 장치다 — 어떤 사진이 깔려도 제호·제목이 읽혀야 한다.
  function coverSvg(issue, pub) {
    var n = Number(issue["호수"]) || 0;
    var publisher = pub || issue["발행인"] || "안창민";
    var frame = issue["채널"] === "월간" ? "#7a1f2b" : "#16296a";
    var uid = "cv" + String(issue.id || n).replace(/[^a-zA-Z0-9]/g, "");
    var photo = issue["커버이미지"];   // 목록 항목엔 기사 그림이 없다 — 커버이미지가 없으면 채널 색 표지
    var ground = photo
      ? '<image href="' + esc(mediaSrc(photo)) + '" x="8" y="8" width="284" height="384" preserveAspectRatio="xMidYMid slice"/>'
      : '<rect x="8" y="8" width="284" height="384" fill="' + frame + '"/>';
    var title = issue["커버제목"] || issue["제목"] || "";
    var lines = wrapLines(title, 11, 3);
    var head = lines.map(function (l, i) {
      var y = 340 - (lines.length - 1 - i) * 30;
      return '<text x="22" y="' + y + '" fill="#FFFFFF" font-family="Noto Serif KR, serif" font-size="25" font-weight="900" letter-spacing="-1">' + esc(l) + "</text>";
    }).join("");
    var nameSize = publisher.length > 3 ? 46 : 58;
    return '<svg class="shelf-svg" viewBox="0 0 300 400" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="' + esc((issue["채널"] || "") + " " + publisher + " " + n + "호 표지") + '">'
      + "<defs>"
      + '<linearGradient id="' + uid + 't" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#080c1e" stop-opacity="0.62"/><stop offset="1" stop-color="#080c1e" stop-opacity="0"/></linearGradient>'
      + '<linearGradient id="' + uid + 'b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#080c1e" stop-opacity="0"/><stop offset="0.5" stop-color="#080c1e" stop-opacity="0.6"/><stop offset="1" stop-color="#080c1e" stop-opacity="0.92"/></linearGradient>'
      + "</defs>"
      + '<rect width="300" height="400" fill="' + frame + '"/>'
      + ground
      + (photo ? '<rect x="8" y="8" width="284" height="130" fill="url(#' + uid + 't)"/><rect x="8" y="200" width="284" height="192" fill="url(#' + uid + 'b)"/>' : "")
      + '<rect x="11.5" y="11.5" width="277" height="377" fill="none" stroke="#b08a4a" stroke-width="1"/>'
      + '<text x="22" y="40" fill="#FFFFFF" font-family="Noto Serif KR, serif" font-size="13" font-weight="700">' + esc(issue["채널"] || "") + "</text>"
      + '<text x="18" y="' + (40 + nameSize) + '" fill="#FFFFFF" font-family="Noto Serif KR, serif" font-size="' + nameSize + '" font-weight="900" letter-spacing="-3">' + esc(publisher) + "</text>"
      + '<text x="278" y="' + (24 + nameSize) + '" text-anchor="end" fill="#FFFFFF" font-family="Pretendard, sans-serif" font-size="14" font-weight="800">통권 ' + esc(n) + "호</text>"
      + head
      + "</svg>";
  }

  function coverHtml(issue, pub) {
    return coverSvg(issue, pub);
  }

  // 지난 호 구획 — 같은 채널의 발행된 이전 호 4건. 없으면 통째로 생략한다.
  function pastHtml(meta, list, edition) {
    if (!list || !list.length) return "";
    var fc = edition ? edition["코드"] : "";
    var past = sortByDate(published(list).filter(function (i) {
      return i["채널"] === meta["채널"] && i.id !== meta.id
        && (i["발행일"] || "") < (meta["발행일"] || "");
    })).slice(0, 4);
    if (!past.length) return "";
    var pub = edition ? edition["이름"] : (meta["발행인"] || "안창민");
    var h = ['<section class="past"><h2 class="past__title">지난 호</h2><div class="past__grid">'];
    past.forEach(function (i) {
      h.push('<a class="past__item" href="issue.html?id=' + encodeURIComponent(i.id) + (fc ? "&fc=" + encodeURIComponent(fc) : "") + '">');
      h.push('<span class="past__cover">' + coverHtml(i, pub) + "</span>");
      h.push('<span class="past__no">통권 ' + esc(i["호수"]) + "호</span>");
      h.push('<span class="past__name">' + esc(i["제목"]) + "</span>");
      h.push('<span class="past__date">' + esc(displayDate(i["발행일"], i["주차라벨"])) + "</span></a>");
    });
    h.push('</div><a class="ct-back" href="./' + (fc ? "?fc=" + encodeURIComponent(fc) : "") + '">서재에서 전체 보기</a></section>');
    return h.join("");
  }

  // 지면 전체 HTML. meta = 목록항목, data = 본문({편집장의말, 기사}).
  // list·edition은 없으면 다음 호 안내·발행인 치환만 빠진다(미리보기 경로).
  function issueHtml(meta, data, list, edition) {
    var pub = meta["발행인"] || "안창민";
    var mast = meta["채널"] + " " + pub;
    var editorLine = "편집장 안창민 FC" + (pub !== "안창민" ? " · 발행 " + pub + " FC" : "");
    var arts = (data && data["기사"]) || [];
    var note = ((data && data["편집장의말"]) || []).slice();
    // 마지막 줄이 짧으면 서명용 태그라인으로 쓴다 (예: "상속 · 증여 · 절세 전문")
    var tagline = (note.length > 1 && note[note.length - 1].length <= 30) ? note.pop() : "";
    var dateText = displayDate(meta["발행일"], meta["주차라벨"]);
    var colors = sectionColors(arts);
    var h = [];

    h.push('<div class="ct' + (meta["채널"] === "월간" ? " ch-monthly" : "") + '">');

    // 표지 — 전면 사진 + 큰 제호 + 커버 스토리 + 커버 라인. 서재 카드(coverSvg)가 축소판이다.
    var photo = coverPhoto(meta, arts);
    var headText = meta["커버제목"] || meta["제목"] || "";
    var a0 = arts[0] || {};
    var dek = meta["커버덱"] || a0["부제"] || "";
    var lines = arts.slice(1, 4);
    h.push('<div class="cover-wrap" id="a0"><section class="cover' + (photo ? "" : " cover--text") + '" aria-label="표지"><div class="cover-in">');
    if (photo) h.push('<img class="cover-photo" src="' + esc(mediaSrc(photo)) + '" alt="" style="object-position:' + esc(meta["커버위치"] || "50% 50%") + '">');
    h.push('<div class="cover-shade"></div>');
    h.push('<header class="mast"><h1 class="mast-name' + (pub.length > 3 ? " is-long" : "") + '"><small>' + esc(meta["채널"]) + "</small>" + esc(pub) + "</h1>");
    h.push('<p class="mast-meta"><b>통권 ' + esc(meta["호수"]) + "호</b>" + esc(dateText) + "</p></header>");
    h.push('<div class="cover-low">');
    if (a0["카테고리"]) h.push('<span class="cover-kicker">이번 호 · ' + esc(displayCat(a0["카테고리"])) + "</span>");
    h.push('<h2 class="cover-head' + coverHeadClass(headText) + '">' + esc(headText) + "</h2>");
    if (dek) h.push('<p class="cover-dek">' + esc(dek) + "</p>");
    if (lines.length) {
      h.push('<ul class="cover-lines">');
      lines.forEach(function (b) { h.push("<li><span>" + esc(displayCat(b["카테고리"])) + "</span>" + esc(b["제목"]) + "</li>"); });
      h.push("</ul>");
    }
    h.push("</div></div></section></div>");

    // 편집장의 말 + 차례
    if (note.length || arts.length) {
      h.push('<section class="page letter">');
      if (note.length) {
        h.push('<div class="letter-copy"><p class="eyebrow">편집장의 말</p>');
        h.push('<h2 class="letter-title">' + esc(mast) + " " + esc(meta["호수"]) + "호를 보내며</h2>");
        note.forEach(function (p) { h.push('<p class="t">' + esc(p) + "</p>"); });
        h.push('<p class="sign">편집장 <b>안창민</b>' + (tagline ? " · " + esc(tagline) : "") + "</p></div>");
      }
      if (arts.length) {
        h.push('<nav class="toc" id="contents" aria-label="이번 호 기사"><p class="eyebrow">이번 호</p><ol>');
        arts.forEach(function (a, i) {
          var img = a["이미지"] ? esc(mediaSrc(a["이미지"])) : "";
          h.push('<li><a class="toc__link' + (img ? "" : " no-img") + '" href="#a' + (i + 1) + '">');
          h.push('<span class="toc__n">' + (i + 1) + "</span>");
          h.push('<span><span class="toc__c" style="color:' + colors[i].c + '">' + esc(displayCat(a["카테고리"])) + "</span>");
          h.push('<span class="toc__t">' + esc(a["제목"]) + "</span></span>");
          if (img) h.push('<img src="' + img + '" alt="" loading="lazy">');
          h.push("</a></li>");
        });
        h.push("</ol></nav>");
      }
      h.push("</section>");
    }

    // 칼럼
    arts.forEach(function (a, i) { h.push(articleHtml(a, i, arts, colors[i], pub, dateText)); });

    // 판권 — 편집장·발행 병기(헌법) + 사진 출처 + 다음 호 + 서재 복귀
    h.push('<footer class="colophon">');
    h.push('<p class="colophon__title">' + esc(mast) + "</p>");
    h.push("<p>통권 " + esc(meta["호수"]) + "호 · " + esc(meta["주차라벨"] || "") + " · " + esc(dateText) + " 발행</p>");
    h.push("<p>" + esc(editorLine) + " · " + esc(edition ? (edition["소속"] || "") : "신한라이프 하랑지점") + "</p>");
    // 원본 주소가 있으면 출처를 원본으로 잇는다 — CC BY 계열은 원본·라이선스 링크가 조건이다
    var credits = [];
    if (meta["커버출처"]) credits.push(["표지 — " + meta["커버출처"], meta["커버원본"]]);
    arts.forEach(function (a, i) { if (a["이미지출처"]) credits.push([(i + 1) + "번 기사 — " + a["이미지출처"], a["이미지원본"]]); });
    if (credits.length) {
      h.push('<ul class="colophon__credits">');
      credits.forEach(function (c) {
        h.push("<li>" + (/^https:\/\//.test(c[1] || "")
          ? '<a href="' + esc(c[1]) + '" target="_blank" rel="noopener noreferrer">' + esc(c[0]) + "</a>" : esc(c[0])) + "</li>");
      });
      h.push("</ul>");
    }

    // 다음 호 — 같은 채널의 실제 다음 발행분이 서재에 있을 때만
    var next = null;
    (list || []).forEach(function (i) {
      if (i["상태"] === "초안" || i["채널"] !== meta["채널"]) return;
      if ((i["발행일"] || "") <= (meta["발행일"] || "")) return;
      if (!next || (i["발행일"] || "") < (next["발행일"] || "")) next = i;
    });
    if (next) {
      var fc = new URLSearchParams(window.location.search).get("fc");
      var href = "issue.html?id=" + encodeURIComponent(next.id)
        + (edition && fc ? "&fc=" + encodeURIComponent(fc) : "");
      h.push('<a class="next-issue" href="' + esc(href) + '">');
      h.push('<span class="next-label">다음 호</span>');
      h.push('<span class="next-title">' + esc(next["제목"]) + "</span>");
      h.push('<span class="next-meta">통권 ' + esc(next["호수"]) + "호 · " + esc(next["주차라벨"]) + "</span></a>");
    }
    h.push('<p class="colophon__note">본 콘텐츠는 정보 제공 목적이며 개별 상품 권유가 아닙니다. 문의는 담당 설계사에게 연락해 주십시오.</p>');
    // 지난 호 — 다 읽은 독자가 갈 곳. 목록이 없으면(미리보기) 생략한다.
    var pastSec = pastHtml(meta, list, edition);
    if (!pastSec) h.push('<a class="ct-back" href="./">케어센터 서재로</a>');
    h.push("</footer>");
    h.push(pastSec);

    h.push("</div>");
    return h.join("");
  }

  // ── 기사 넘기기 (2026-08-03)
  // 기사 셋을 한 판에 이어 붙이면 스크롤이 끝없이 길어져 읽기 전에 지친다.
  // 기사 하나만 펼치고, 다 읽으면 옆으로 넘긴다 — 폰은 스와이프, 노트북은 좌우 화살표.
  // 기사 안은 그대로 세로로 읽는다. 화면 크기와 무관하게 같은 방식으로 동작한다.
  function initDeck(root) {
    var bh = root.querySelector(".ct");
    if (!bh) return;
    var arts = [].slice.call(bh.querySelectorAll(".article"));
    if (arts.length < 2) return;
    var cur = 0;

    // 기사 끝 넘김 막대 — 스와이프를 모르는 사람도 여기서 넘어간다.
    // 다음 기사 제목을 함께 걸어 무엇으로 넘어가는지 보이게 한다.
    function titleOf(art) {
      var t = art.querySelector(".ct-title");
      return t ? t.textContent.trim() : "";
    }
    arts.forEach(function (art, i) {
      var nav = document.createElement("nav");
      nav.className = "deck-nav";
      nav.setAttribute("aria-label", "기사 넘기기");
      var next = arts[i + 1];
      nav.innerHTML =
        '<button type="button" class="deck-nav__btn" data-deck="prev"'
          + (i === 0 ? " disabled" : "") + ">이전 기사</button>"
        + '<span class="deck-nav__pos">' + (i + 1) + " / " + arts.length + "</span>"
        + '<button type="button" class="deck-nav__btn deck-nav__btn--next" data-deck="next"'
          + (!next ? " disabled" : "") + ">다음 기사</button>"
        + (next
          ? '<button type="button" class="deck-nav__title" data-deck="next">'
            + esc(titleOf(next)) + "</button>"
          : '<a class="deck-nav__title" href="#contents">이번 호 목차로</a>')
        + '<p class="deck-nav__hint">좌우 화살표 키로도 넘길 수 있습니다.</p>';
      art.appendChild(nav);
    });

    // 넘어간 뒤에는 기사 첫머리에서 다시 읽기 시작한다
    function show(next, move) {
      if (next < 0 || next >= arts.length) return;
      cur = next;
      arts.forEach(function (a, i) {
        a.classList.toggle("is-current", i === cur);
        a.classList.remove("from-right", "from-left");
      });
      if (move) arts[cur].classList.add(move > 0 ? "from-right" : "from-left");
      // 좌표를 직접 계산하면 문서 높이가 바뀌는 순간과 엇갈린다. 상단바를 비키는 여백은
      // 기사에 걸린 scroll-margin-top이 이미 맡고 있으므로 브라우저에 맡긴다.
      arts[cur].scrollIntoView({ block: "start", behavior: "auto" });
    }

    bh.classList.add("deck-on");
    arts.forEach(function (a, i) { a.classList.toggle("is-current", i === cur); });

    bh.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-deck]");
      if (btn && !btn.disabled) {
        e.preventDefault();
        show(cur + (btn.dataset.deck === "next" ? 1 : -1), btn.dataset.deck === "next" ? 1 : -1);
        return;
      }
      // 목차에서 고른 기사로 바로 간다
      var link = e.target.closest(".toc__link");
      if (!link) return;
      var idx = arts.indexOf(bh.querySelector(link.getAttribute("href")));
      if (idx < 0) return;
      e.preventDefault();
      show(idx, idx > cur ? 1 : -1);
    });

    // 좌우 스와이프. 세로로 읽는 동작을 가로채지 않도록 가로 이동이 확실할 때만 넘긴다.
    var x0 = 0, y0 = 0, live = false;
    bh.addEventListener("touchstart", function (e) {
      if (e.touches.length !== 1) { live = false; return; }
      // 표는 옆으로 밀어 읽는다 — 표 안에서 시작한 밀기는 기사 넘기기가 아니다
      if (e.target.closest && e.target.closest(".table-scroll")) { live = false; return; }
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
      live = true;
    }, { passive: true });
    bh.addEventListener("touchend", function (e) {
      if (!live) return;
      live = false;
      var t = e.changedTouches[0];
      var dx = t.clientX - x0;
      var dy = t.clientY - y0;
      if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
      show(cur + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);
    }, { passive: true });

    // 노트북·데스크톱은 좌우 화살표로 넘긴다. 글자 입력 중이거나 표에 포커스가 있으면
    // (표를 화살표로 옆으로 미는 중) 넘기지 않는다. 지면이 가려져 있을 때(미리보기 닫힘)도 넘기지 않는다.
    function onKey(e) {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (!bh.isConnected || !bh.getClientRects().length) return;
      var t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (t && t.closest && t.closest(".table-scroll")) return;
      if (e.key === "ArrowRight") { e.preventDefault(); show(cur + 1, 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); show(cur - 1, -1); }
    }
    document.addEventListener("keydown", onKey);
    // 같은 화면에서 지면을 여러 번 까는 곳(발행 데스크 미리보기)이 듣기를 걷을 수 있게 돌려준다
    return function () { document.removeEventListener("keydown", onKey); };
  }

  // 글만 이어지는 구간의 글자 수 — 멈출 자리(소제목·수치·인용·표·상자·뽑은 인용) 사이 평문. 발행 데스크의 「졸리면 실패다」 경고가 쓴다
  function quietRuns(a) {
    var pulls = (Array.isArray(a["뽑은글"]) ? a["뽑은글"] : []).filter(Boolean);
    var runs = [], run = 0;
    tokenize(a["본문"] || []).forEach(function (t) {
      if (t.k === "p") {
        run += t.x.length;
        if (!pulls.some(function (q) { return t.x.indexOf(q) >= 0; })) return;
      }
      if (run) runs.push(run);
      run = 0;
    });
    if (run) runs.push(run);
    return runs;
  }

  window.care = {
    CAT_LABEL: CAT_LABEL,
    quietRuns: quietRuns,
    initDeck: initDeck,
    displayCat: displayCat,
    mediaSrc: mediaSrc,
    issueHtml: issueHtml,
    coverHtml: coverHtml,
    loadSender: loadSender,
    saveSender: saveSender,
    bindSenderRow: bindSenderRow,
    kakaoText: kakaoText,
    openCompose: openCompose,
    bindCompose: bindCompose,
    loadPublishers: loadPublishers,
    loadIssueList: loadIssueList,
    listHadTrouble: listHadTrouble,
    loadIssueBody: loadIssueBody,
    sortByDate: sortByDate,
    published: published,
    drafts: drafts,
    latestByChannel: latestByChannel,
    esc: esc
  };
})();
