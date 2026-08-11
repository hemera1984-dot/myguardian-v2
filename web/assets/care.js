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

  function issueUrl(issue, edition) {
    var query = "issue.html?id=" + encodeURIComponent(issue.id)
      + (edition ? "&fc=" + encodeURIComponent(edition["코드"]) : "");
    return new URL(query, window.location.href).href;
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
    if (issue["채널"] === "일일") {
      // 일일은 한 꼭지다. 안부인사를 매일 붙이면 금방 상투가 되므로 바로 본론으로 간다.
      lines.push(mag + " " + (issue["주차라벨"] || "") + " (통권 " + issue["호수"] + "호)", "");
      if (toc.length) {
        lines.push(toc[0]["제목"]);
        if (toc[0]["부제"]) lines.push(toc[0]["부제"]);
        lines.push("");
      }
    } else if (issue["채널"] === "주간") {
      lines.push(greet, "");
      lines.push(mag + " " + (issue["주차라벨"] || "") + " (통권 " + issue["호수"] + "호)");
      // 주간은 시사가 아니라 보험·자산·세무를 다룬다(2026-08-05 역할 분리) — 시사는 일일 몫이다
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

  function loadIssueList() {
    var staticP = fetch(new URL("../../data/care/issues.json", window.location.href))
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (d) { return Array.isArray(d) ? d : (d.data || []); })
      .catch(function () { return []; });
    var base = apiBase();
    var serverP = !base ? Promise.resolve([]) : fetch(base + "/care/issues")
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (d) { return Array.isArray(d) ? d : []; })
      .catch(function () { return []; });
    return Promise.all([serverP, staticP]).then(function (res) {
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

  // ── 바우하우스 조판 (2026-08-03 채택) ─────────────────────────────
  // 시안: docs/design/care-bauhaus-시안.html. 삼원색 색면·기하 도형·비대칭 격자.
  // 훑는 독자를 위해 형광·대형 수치·색면 문단을 뽑되, 원문 문장만 다시 배치한다.
  // 없는 사실·수치는 만들지 않는다.

  var NAV_HEADS = { "다음 칼럼": 1, "이전 칼럼": 1, "목록으로": 1 };
  var SIGNALS = /\d|핵심|중요|필수|반드시|결국|문제|위험|제한|보장|세금|상속|부도|보험|자산|연쇄|현실|전략|변화/;
  var SPOT_SIGNALS = /결국|결론적으로|핵심|중요한 것은|정리하면|따라서|진정한|단순히/;
  var hlTurn = 0; // 형광 간격 카운터 — 칼럼마다 0으로 되돌린다

  function isStat(t) { var p = t.indexOf(" — "); return p > 0 && /\d/.test(t.slice(0, p)); }
  function isAdvice(t) { return /^(첫째|둘째|셋째|넷째|다섯째|마지막으로),/.test(t); }
  function isExample(t) { return /^(예를 들어|다른 예시로)/.test(t); }
  function isCaution(t) { return !isAdvice(t) && !isExample(t) && /(반드시|꼼꼼히 확인|정확히 이해|주의해야|유의해야)/.test(t); }
  function isStatement(t) { return t.length <= 58 && !/[.!?。]$/.test(t) && !isAdvice(t); }

  // 긴 문단은 문장 경계로 잘라 덩어리로 나눈다 (형광 간격의 단위)
  function splitProse(text) {
    if (text.length < 190) return [text];
    var sentences = text.match(/.*?(?:[.!?。]+["'’”)]*(?=\s|$)|$)/g) || [text];
    var chunks = [];
    var current = "";
    sentences.forEach(function (s) {
      var part = String(s).trim();
      if (!part) return;
      if (current && current.length + part.length > 175) { chunks.push(current); current = part; }
      else current += (current ? " " : "") + part;
    });
    if (current) chunks.push(current);
    return chunks;
  }

  // 형광 대상 절 고르기 — 수치·핵심어가 있는 절을 우선한다
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
    return best;
  }

  function markPhrase(text, phrase) {
    var i = phrase ? text.indexOf(phrase) : -1;
    if (i < 0) return esc(text);
    return esc(text.slice(0, i))
      + '<mark class="key-hit">' + esc(phrase) + "</mark>"
      + esc(text.slice(i + phrase.length));
  }

  // 문단 — 문단 걸러 하나씩만 형광. 매 문단이면 강조가 무의미해지고, 없으면 훑을 게 없다.
  function prose(tag, cls, text) {
    var parts = splitProse(text).map(function (part) {
      hlTurn += 1;
      var html = (hlTurn % 2 === 1 && part.trim().length >= 60)
        ? markPhrase(part, keyPhrase(part))
        : esc(part);
      return '<span class="paragraph-chunk">' + html + "</span>";
    });
    return "<" + tag + ' class="' + cls + '">' + parts.join(" ") + "</" + tag + ">";
  }

  // 대형 수치 블록 — "12회 제한 — 설명" 꼴의 원문 문장을 그대로 쓴다
  function statHtml(text, extra, peakLabel) {
    var p = text.indexOf(" — ");
    return '<aside class="stat' + (extra ? " " + extra : "") + '"'
      + (peakLabel ? ' data-peak="' + esc(peakLabel) + '"' : "") + ">"
      + '<strong class="stat__value">' + esc(text.slice(0, p)) + "</strong>"
      + '<span class="stat__copy">' + esc(text.slice(p + 3)) + "</span></aside>";
  }

  function tableHtml(headers, rows) {
    var h = ['<figure class="comparison"><p class="swipe">표는 옆으로 넘겨 보실 수 있습니다</p><div class="table-scroll"><table><thead><tr>'];
    headers.forEach(function (v) { h.push("<th>" + esc(v) + "</th>"); });
    h.push("</tr></thead><tbody>");
    rows.forEach(function (row) {
      h.push("<tr>");
      row.forEach(function (v) { h.push("<td>" + esc(v) + "</td>"); });
      h.push("</tr>");
    });
    h.push("</tbody></table></div></figure>");
    return h.join("");
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
        while (i < blocks.length && blocks[i].t === "p" && blocks[i].x.indexOf("\t") >= 0) { rows.push(blocks[i].x.split("\t")); i++; }
        toks.push({ k: "table", headers: headers, rows: rows });
        continue;
      }
      if (b.t === "p" && b.x.indexOf("\t") >= 0) {
        var rows2 = [];
        while (i < blocks.length && blocks[i].t === "p" && blocks[i].x.indexOf("\t") >= 0) { rows2.push(blocks[i].x.split("\t")); i++; }
        toks.push({ k: "table", headers: rows2[0], rows: rows2.slice(1) });
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

  // 본문 지면 — 대형 수치(peak/impact)·전환 지면(turning-point)·색면 문단(spotlight)을
  // 원문 안에서 골라 배치한다. 고를 대상이 없으면 그냥 안 넣는다.
  function bodyHtml(blocks, arts, catLabel) {
    var navAt = -1;
    blocks.forEach(function (b, i) { if (navAt < 0 && b.t === "h" && NAV_HEADS[b.x]) navAt = i; });
    var content = navAt < 0 ? blocks : blocks.slice(0, navAt);
    var navBlocks = navAt < 0 ? [] : blocks.slice(navAt);
    var toks = tokenize(content);
    if (!toks.length) return "";

    // 대형 수치 — 첫 수치는 전면(peak), 이후는 한 칸 걸러 확대(impact)
    var statSeen = 0;
    toks.forEach(function (t) {
      if (t.k !== "stat") return;
      if (statSeen === 0) t.cls = "peak";
      else if (statSeen % 2 === 1) t.cls = "impact";
      statSeen += 1;
    });

    // 전환 지면 — 소제목이 셋 이상이면 가운데 소제목에 힘을 준다
    var heads = [];
    toks.forEach(function (t, i) { if (t.k === "h") heads.push(i); });
    if (heads.length >= 3) toks[heads[Math.floor(heads.length / 2)]].cls = "turning-point";

    // 색면 문단 — 결론·핵심 신호가 있는 긴 문단 (본문이 길면 둘)
    var cands = [];
    toks.forEach(function (t, i) {
      if (t.k !== "p" && t.k !== "advice" && t.k !== "note") return;
      var len = t.x.length;
      if (len < 90) return;
      cands.push({ i: i, s: (SPOT_SIGNALS.test(t.x) ? 100 : 0) + Math.min(len, 320) - Math.abs(len - 210) * 0.4 });
    });
    cands.sort(function (a, b) { return b.s - a.s; });
    cands.slice(0, toks.length > 24 ? 2 : 1).forEach(function (c) { toks[c.i].cls = "spotlight"; });

    var h = ['<div class="article-body"><div class="body-grid"><div class="reading-column">'];
    toks.forEach(function (t) {
      if (t.k === "table") { h.push(tableHtml(t.headers, t.rows)); return; }
      if (t.k === "h") {
        h.push('<section class="body-section' + (t.cls ? " " + t.cls : "") + '">'
          + '<h2 class="body-heading">' + esc(t.x) + "</h2></section>");
        return;
      }
      if (t.k === "stat") { h.push(statHtml(t.x, t.cls, t.cls === "peak" ? catLabel : "")); return; }
      var cls = { advice: "advice", note: "note", statement: "statement", p: "body-paragraph" }[t.k];
      var tag = (t.k === "advice" || t.k === "note") ? "aside" : "p";
      h.push(prose(tag, cls + (t.cls ? " " + t.cls : ""), t.x));
    });
    h.push(articleNavHtml(navBlocks, arts));
    h.push('<a class="bh-back" href="#contents">목록으로</a>');
    h.push("</div></div></div>");
    return h.join("");
  }

  // 칼럼 진입 포스터 — 번호(원)·제목·부제 + 기하 도형
  function posterHtml(a, no) {
    return '<header class="poster">'
      + '<p class="poster__band">' + esc(displayCat(a["카테고리"])) + "</p>"
      + '<div class="poster__core">'
      + '<div class="poster__number">' + esc(no) + "</div>"
      + '<h2 class="poster__title">' + esc(a["제목"]) + "</h2>"
      + (a["부제"] ? '<p class="poster__subtitle">' + esc(a["부제"]) + "</p>" : "")
      + '<div class="poster__square" aria-hidden="true"></div>'
      + '<div class="poster__triangle" aria-hidden="true"></div>'
      + "</div>"
      + '<div class="poster__foot"><div class="poster__rule"></div><div class="poster__block"></div></div>'
      + "</header>";
  }

  // 기사 도입 — 이미지 → 리드(요약 첫 줄) → 나머지 요약 → 발행인 한마디
  function introHtml(a, pub) {
    var h = ['<section class="article-intro"><div class="article-intro__inner">'];
    if (a["이미지"]) {
      h.push('<figure class="bh-figure"><img src="' + esc(mediaSrc(a["이미지"])) + '" alt="" loading="lazy">');
      if (a["이미지캡션"]) h.push("<figcaption>" + esc(a["이미지캡션"]) + "</figcaption>");
      h.push("</figure>");
    }
    (a["요약"] || []).forEach(function (text, i) {
      if (i === 0) h.push(prose("p", "lead" + (text.length > 220 ? " lead--long" : ""), text));
      else if (isStat(text)) h.push(statHtml(text, "impact", ""));
      else h.push(prose("p", "summary-note", text));
    });
    var say = a["한마디"] || [];
    if (say.length) {
      h.push('<aside class="fc-take"><p class="fc-take__label">' + esc(pub) + " FC의 한마디</p>");
      say.forEach(function (t) { h.push('<blockquote class="quote-block">' + esc(t) + "</blockquote>"); });
      h.push('<p class="fc-take__sign">' + esc(pub) + " FC</p></aside>");
    }
    h.push("</div></section>");
    return h.join("");
  }

  // ── 표지 자동 생성 ────────────────────────────────────────────────
  // 표지 이미지가 없는 호도 서가에서 표지로 보이게 한다. 호수에 따라 색·도형이 바뀌어
  // 호마다 다른 표지가 된다. 외부 이미지 파일을 만들지 않는다(인라인 SVG).
  var COVER_SETS = [
    { bg: "#F5C518", ink: "#111111", a: "#E63329", b: "#005BBB" },
    { bg: "#E63329", ink: "#FFFFFF", a: "#F5C518", b: "#005BBB" },
    { bg: "#005BBB", ink: "#FFFFFF", a: "#F5C518", b: "#E63329" }
  ];

  // 커버라인 색 — 호마다 액센트가 바뀐다(균질하면 실패, 헌법). 제호는 늘 같다.
  var COVER_ACCENT = [
    { line: "#E63329", ink: "#FFFFFF" },
    { line: "#005BBB", ink: "#FFFFFF" },
    { line: "#F5C518", ink: "#111111" }
  ];

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

  // 표지 도형 — 커버이미지가 없는 호가 까는 그림. 제호(위)·커버라인(아래) 자리를 피해
  // 가운데 띠에만 놓는다. 자리는 고정이고 도형만 호마다 바뀐다.
  function coverArt(v, c) {
    return v === 0
      ? '<circle cx="222" cy="150" r="64" fill="' + c.a + '"/>'
        + '<rect x="26" y="176" width="84" height="84" fill="' + c.b + '" transform="rotate(-12 68 218)"/>'
      : v === 1
        ? '<polygon points="150,74 232,206 68,206" fill="' + c.a + '"/>'
          + '<circle cx="62" cy="232" r="42" fill="' + c.b + '"/>'
        : '<rect x="168" y="86" width="104" height="104" fill="' + c.a + '"/>'
          + '<polygon points="26,254 138,254 82,148" fill="' + c.b + '"/>';
  }

  // 표지 — 고정 틀 + 갈아끼우는 이미지 (2026-08-03 사용자 확정).
  // 틀(제호·커버라인 자리·호수 줄)은 코드에 박혀 매 호 같고, 배경 이미지와 문구만 바뀐다.
  // 그래야 사진이 달라져도 서가에서 한눈에 같은 잡지로 읽힌다. 지면 첫 장(style.css의
  // .masthead)도 같은 구성이며, 여기는 그 축소판이다.
  //
  // 어두운 층은 장식이 아니라 가독 장치다 — 어떤 사진이 깔려도 제호·커버라인이 읽혀야 한다.
  // (헌법의 그라데이션 금지는 플랫폼 업무 화면 규칙이고 발행물은 독립 브랜드다.)
  // 뒷날 자리: 올린 사진을 바우하우스 화풍으로 변환하는 층은 이미지 생성 API가 붙으면
  // 이 ground 자리에서 갈아끼운다.
  function coverSvg(issue, pub) {
    var n = Number(issue["호수"]) || 0;
    var v = n % 3;
    var c = COVER_SETS[v];
    var publisher = pub || issue["발행인"] || "안창민";
    var mast = (issue["채널"] || "") + " " + publisher;
    var uid = "cv" + String(issue.id || n).replace(/[^a-zA-Z0-9]/g, "");

    // ── 갈아끼우는 층 — 올린 사진 · 자동 생성 도형 표지 · 없으면 색면
    var ground = issue["커버이미지"]
      ? '<image href="' + esc(mediaSrc(issue["커버이미지"])) + '" x="0" y="0" width="300" height="400" preserveAspectRatio="xMidYMid slice"/>'
      // 색면은 늘 잉크다 — 밝은 색면 위에 흰 글자를 얹으면 어떤 어두운 층을 깔아도 탁해진다.
      // 도형만 호마다 바뀐다.
      : '<rect width="300" height="400" fill="#111111"/>' + coverArt(v, c);

    // ── 고정 층 — 자리는 늘 같고 글자만 바뀐다
    var lines = wrapLines(issue["제목"], 13, 3);
    var also = (issue["꼭지"] || []).map(function (t) { return t["제목"]; })
      .filter(function (t) { return t && t !== issue["제목"]; }).slice(0, 1);
    var coverline = lines.map(function (l, i) {
      // 마지막 줄이 늘 같은 높이에 오도록 아래에서 위로 쌓는다
      var y = 336 - (lines.length - 1 - i) * 25;
      return '<text x="14" y="' + y + '" fill="#FFFFFF" font-family="Paperlogy, sans-serif" font-size="22" font-weight="900" letter-spacing="-1.2">' + esc(l) + "</text>";
    }).join("");

    return '<svg class="shelf-svg" viewBox="0 0 300 400" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="' + esc(mast + " " + n + "호 표지") + '">'
      + "<defs>"
      + '<linearGradient id="' + uid + 't" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="#111111" stop-opacity="0.78"/><stop offset="1" stop-color="#111111" stop-opacity="0"/></linearGradient>'
      + '<linearGradient id="' + uid + 'b" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="#111111" stop-opacity="0"/><stop offset="0.55" stop-color="#111111" stop-opacity="0.72"/><stop offset="1" stop-color="#111111" stop-opacity="0.92"/></linearGradient>'
      + "</defs>"
      + '<rect width="300" height="400" fill="#111111"/>'
      + ground
      + '<rect x="0" y="0" width="300" height="132" fill="url(#' + uid + 't)"/>'
      + '<rect x="0" y="188" width="300" height="212" fill="url(#' + uid + 'b)"/>'
      + '<text x="14" y="46" fill="#FFFFFF" font-family="Paperlogy, sans-serif" font-size="32" font-weight="900" letter-spacing="-2">'
      + esc(issue["채널"] || "") + '<tspan fill="#F5C518"> ' + esc(publisher) + "</tspan></text>"
      + '<rect x="14" y="58" width="54" height="5" fill="#E63329"/>'
      + coverline
      + (also.length
          ? '<text x="14" y="356" fill="#FFFFFF" fill-opacity="0.82" font-family="Paperlogy, sans-serif" font-size="11" font-weight="700">' + esc(wrapLines(also[0], 24, 1)[0] || "") + "</text>"
          : "")
      + '<rect x="14" y="366" width="272" height="1" fill="#FFFFFF" fill-opacity="0.45"/>'
      + '<text x="14" y="386" fill="#FFFFFF" font-family="Paperlogy, sans-serif" font-size="11.5" font-weight="800" letter-spacing="0.4">통권 ' + esc(n) + "호</text>"
      + '<text x="286" y="386" text-anchor="end" fill="#FFFFFF" fill-opacity="0.85" font-family="Paperlogy, sans-serif" font-size="10.5" font-weight="700">' + esc(displayDate(issue["발행일"], issue["주차라벨"])) + "</text>"
      + "</svg>";
  }

  // 표지 — 이미지 유무와 무관하게 같은 틀. 이미지는 3:4로 자동 크롭돼(slice) 깔린다.
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
    var h = ['<section class="past"><div class="past__inner">'];
    h.push('<div class="past__head"><h2 class="past__title">지난 호</h2><div class="past__shape" aria-hidden="true"></div></div>');
    h.push('<div class="past__grid">');
    past.forEach(function (i) {
      h.push('<a class="past__item" href="issue.html?id=' + encodeURIComponent(i.id) + (fc ? "&fc=" + encodeURIComponent(fc) : "") + '">');
      h.push('<span class="past__cover">' + coverHtml(i, pub) + "</span>");
      h.push('<span class="past__no">' + esc(i["호수"]) + "호</span>");
      h.push('<span class="past__name">' + esc(i["제목"]) + "</span>");
      h.push('<span class="past__date">' + esc(displayDate(i["발행일"], i["주차라벨"])) + "</span></a>");
    });
    h.push("</div>");
    h.push('<a class="bh-back bh-back--home" href="./' + (fc ? "?fc=" + encodeURIComponent(fc) : "") + '">서재에서 전체 보기</a>');
    h.push("</div></section>");
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
    var h = [];

    h.push('<div class="bh">');

    // 표지 — 고정 틀 + 갈아끼우는 이미지 (2026-08-03 사용자 확정).
    // 서재 표지 카드(coverSvg)와 같은 구성이다. 여기가 원본이고 서재가 축소판이므로
    // 틀을 고칠 때는 두 곳을 함께 고친다.
    var cover = meta["커버이미지"];
    var also = arts.map(function (a) { return a["제목"]; })
      .filter(function (t) { return t && t !== meta["제목"]; }).slice(0, 2);
    h.push('<section class="masthead' + (cover ? " masthead--photo" : " masthead--art") + '" id="a0">');
    // 갈아끼우는 층 — 올린 사진 · 자동 생성 도형 표지 · 없으면 색면 + 도형
    if (cover) {
      h.push('<img class="masthead__photo" src="' + esc(mediaSrc(cover)) + '" alt="">');
    } else {
      h.push('<div class="masthead__circle" aria-hidden="true"></div>');
      h.push('<div class="masthead__triangle" aria-hidden="true"></div>');
    }
    // 고정 층 — 자리는 늘 같고 글자만 바뀐다
    h.push('<div class="masthead__scrim" aria-hidden="true"></div>');
    h.push('<div class="masthead__brand"><h1 class="masthead__title">' + esc(meta["채널"]) + "<span>" + esc(pub) + "</span></h1>");
    h.push('<span class="masthead__rule" aria-hidden="true"></span></div>');
    h.push('<div class="masthead__lines">');
    h.push('<p class="masthead__deck">' + esc(meta["제목"] || "") + "</p>");
    if (also.length) {
      h.push('<ul class="masthead__also">');
      also.forEach(function (t) { h.push("<li>" + esc(t) + "</li>"); });
      h.push("</ul>");
    }
    h.push("</div>");
    h.push('<div class="masthead__foot"><span class="masthead__no">통권 ' + esc(meta["호수"]) + "호</span>");
    h.push('<span class="masthead__issued">' + esc(displayDate(meta["발행일"], meta["주차라벨"])) + " 발행 · " + esc(editorLine) + "</span></div>");
    h.push("</section>");

    // 편집장의 말
    if (note.length) {
      h.push('<section class="front front--editor"><div class="front__grid">');
      // eyebrow와 제목이 같은 말을 두 번 하지 않게, 위쪽 라벨은 호 표기를 맡는다
      h.push('<p class="eyebrow">' + esc(mast + " " + meta["호수"] + "호") + "</p>");
      h.push('<h2 class="front__heading">편집장의 말</h2>');
      h.push('<div class="editor-copy">');
      note.forEach(function (p) { h.push("<p>" + esc(p) + "</p>"); });
      h.push('<p class="editor-sign">편집장 안창민' + (tagline ? " · " + esc(tagline) : "") + "</p>");
      h.push("</div></div></section>");
    }

    // 차례 — 번호(원)·카테고리 띠·제목·부제
    if (arts.length) {
      h.push('<nav class="contents" id="contents" aria-label="이번 호 기사"><div class="contents__inner">');
      h.push('<div class="contents__head"><h2 class="contents__title">기사</h2><div class="contents__shape" aria-hidden="true"></div></div>');
      h.push('<ol class="toc">');
      arts.forEach(function (a, i) {
        h.push('<li class="toc__item"><a class="toc__link" href="#a' + (i + 1) + '">');
        h.push('<div class="toc__number">' + esc(a["번호"] || (i + 1)) + "</div>");
        h.push('<div class="toc__copy"><div class="toc__category">' + esc(displayCat(a["카테고리"])) + "</div>");
        h.push('<div class="toc__name">' + esc(a["제목"]) + "</div>");
        if (a["부제"]) h.push('<p class="toc__sub">' + esc(a["부제"]) + "</p>");
        h.push("</div></a></li>");
      });
      h.push("</ol></div></nav>");
    }

    // 칼럼 — 1번 빨강 · 2번 파랑 · 3번 노랑 (넷째부터 다시 순환)
    arts.forEach(function (a, i) {
      hlTurn = 0; // 칼럼마다 리드부터 형광이 걸리게 초기화
      h.push('<article class="article article-' + (i % 3 + 1) + '" id="a' + (i + 1) + '">');
      h.push(posterHtml(a, a["번호"] || (i + 1)));
      h.push(introHtml(a, pub));
      h.push(bodyHtml(a["본문"] || [], arts, displayCat(a["카테고리"])));
      h.push("</article>");
    });

    // 판권 — 편집장·발행 병기 (헌법) + 다음 호 + 서재 복귀
    h.push('<footer class="bh-footer"><div class="footer__copy">');
    h.push('<p class="footer__title">' + esc(mast) + "</p>");
    h.push('<p class="footer__meta">통권 ' + esc(meta["호수"]) + "호 · " + esc(meta["주차라벨"]) + " · " + esc(displayDate(meta["발행일"], meta["주차라벨"])) + " 발행</p>");
    h.push('<p class="footer__role">' + esc(editorLine) + " · " + esc(edition ? (edition["소속"] || "") : "신한라이프 하랑지점") + "</p>");

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

    h.push('<p class="footer__note">본 콘텐츠는 정보 제공 목적이며 개별 상품 권유가 아닙니다. 문의는 담당 설계사에게 연락해 주십시오.</p>');
    // 지난 호 — 다 읽은 독자가 갈 곳. 같은 채널의 발행분만, 목록이 없으면(미리보기) 생략한다.
    var pastSec = pastHtml(meta, list, edition);
    if (!pastSec) h.push('<a class="bh-back bh-back--home" href="./">케어센터 서재로</a>');
    h.push('</div><div class="footer__shape" aria-hidden="true"></div></footer>');
    h.push(pastSec);

    h.push("</div>");
    return h.join("");
  }

  // 호별 카톡 미리보기용 OG 페이지 — 카톡은 자바스크립트를 실행하지 않으므로
  // issue.html?id=X 로는 호마다 다른 미리보기가 안 나온다. 발행 시 이 함수로
  // 호별 정적 페이지를 떠서 그 주소를 공유한다. (생성·저장은 다음 단계)
  var SITE = "https://app.insurguard.life";

  function ogPageHtml(meta, data) {
    var pub = meta["발행인"] || "안창민";
    var title = "『" + meta["채널"] + " " + pub + "』 " + (meta["주차라벨"] || "") + " 통권 " + meta["호수"] + "호";
    var arts = (data && data["기사"]) || [];
    var desc = meta["요약"] || arts.map(function (a) { return a["제목"]; }).join(" · ");
    desc = String(desc).slice(0, 150);
    // 카톡은 SVG를 미리보기로 그리지 않는다 — 삽화 표지인 호는 기본 이미지로 돌린다
    var cover = /\.svg$/i.test(meta["커버이미지"] || "") ? "" : meta["커버이미지"];
    var img = cover
      ? (/^https?:/.test(cover) ? cover : SITE + "/" + cover)
      : SITE + "/web/assets/img/hero-care.jpg";
    var url = SITE + "/web/care/issue.html?id=" + encodeURIComponent(meta.id);
    return '<!DOCTYPE html>\n<html lang="ko">\n<head>\n<meta charset="UTF-8">\n'
      + '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
      + "<title>" + esc(title) + "</title>\n"
      + '<meta name="description" content="' + esc(desc) + '">\n'
      + '<meta property="og:type" content="article">\n'
      + '<meta property="og:site_name" content="안창민 케어센터">\n'
      + '<meta property="og:title" content="' + esc(title) + '">\n'
      + '<meta property="og:description" content="' + esc(desc) + '">\n'
      + '<meta property="og:image" content="' + esc(img) + '">\n'
      + '<meta property="og:url" content="' + esc(url) + '">\n'
      + '<meta name="twitter:card" content="summary_large_image">\n'
      + '<meta http-equiv="refresh" content="0; url=' + esc(url) + '">\n'
      + '<script>location.replace("' + esc(url) + '");<\/script>\n'
      + "</head>\n<body>\n<p><a href=\"" + esc(url) + '">' + esc(title) + "를 여는 중입니다.</a></p>\n</body>\n</html>\n";
  }

  // ── 기사 넘기기 (2026-08-03)
  // 기사 셋을 한 판에 이어 붙이면 스크롤이 끝없이 길어져 읽기 전에 지친다.
  // 기사 하나만 펼치고, 다 읽으면 옆으로 넘긴다 — 폰은 스와이프, 노트북은 좌우 화살표.
  // 기사 안은 그대로 세로로 읽는다. 화면 크기와 무관하게 같은 방식으로 동작한다.
  function initDeck(root) {
    var bh = root.querySelector(".bh");
    if (!bh) return;
    var arts = [].slice.call(bh.querySelectorAll(".article"));
    if (arts.length < 2) return;
    var cur = 0;

    // 기사 끝 넘김 막대 — 스와이프를 모르는 사람도 여기서 넘어간다.
    // 다음 기사 제목을 함께 걸어 무엇으로 넘어가는지 보이게 한다.
    function titleOf(art) {
      var t = art.querySelector(".poster__title");
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

    // 넘어간 뒤에는 기사 첫머리(포스터)에서 다시 읽기 시작한다
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

    // 노트북·데스크톱은 좌우 화살표로 넘긴다. 글자 입력 중일 때는 넘기지 않는다.
    document.addEventListener("keydown", function (e) {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      var t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === "ArrowRight") { e.preventDefault(); show(cur + 1, 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); show(cur - 1, -1); }
    });
  }

  window.care = {
    CAT_LABEL: CAT_LABEL,
    initDeck: initDeck,
    displayCat: displayCat,
    mediaSrc: mediaSrc,
    issueHtml: issueHtml,
    ogPageHtml: ogPageHtml,
    coverHtml: coverHtml,
    loadSender: loadSender,
    saveSender: saveSender,
    bindSenderRow: bindSenderRow,
    kakaoText: kakaoText,
    openCompose: openCompose,
    bindCompose: bindCompose,
    loadPublishers: loadPublishers,
    loadIssueList: loadIssueList,
    loadIssueBody: loadIssueBody,
    sortByDate: sortByDate,
    published: published,
    drafts: drafts,
    latestByChannel: latestByChannel,
    esc: esc
  };
})();
