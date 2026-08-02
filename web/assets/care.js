// 케어센터 공용 로직 — 서재·발행 데스크가 함께 쓴다
// (발신 서명, 카톡 문구 생성, 작성함 열기, 발행물 정렬)
(function () {
  "use strict";

  var esc = window.mg.esc;
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
  function kakaoText(issue, edition) {
    var s = edition
      ? { "이름": edition["이름"] + " FC", "소속": edition["소속"] }
      : loadSender();
    var url = issueUrl(issue, edition);
    var toc = issue["꼭지"] || [];
    var pubName = edition ? edition["이름"] : (issue["발행인"] || "안창민");
    var mag = "『" + issue["채널"] + " " + pubName + "』";
    var lines = ["안녕하세요, " + s["이름"] + "입니다.", ""];
    // 계절·시기 안부인사는 호마다 다르다 — 호 데이터의 "인사"를 쓰고, 없으면 기본 문장.
    var greet = issue["인사"];
    if (issue["채널"] === "주간") {
      lines.push(greet || "건강 유의하시고 좋은 한 주 보내세요.", "");
      lines.push(mag + " " + (issue["주차라벨"] || "") + " (통권 " + issue["호수"] + "호)");
      lines.push("이번 주 뉴스 브리핑이 발행되었습니다.", "");
      lines.push("[이번 주 주요 뉴스]", BAR);
      toc.forEach(function (t) {
        lines.push((CAT_LABEL[t["카테고리"]] || t["카테고리"]) + " | " + t["제목"]);
      });
      lines.push(BAR, "");
      if (toc.length) lines.push("이번 주 핵심: " + toc[0]["제목"], "");
    } else {
      lines.push(greet || "환절기 건강 잘 챙기고 계신가요?", "");
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
  function apiBase() {
    return window.mgAuth ? window.mgAuth.apiBase() : "";
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

  function pad2(n) { return String(n).padStart(2, "0"); }

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

  // 기사 표제 블록 — 킥커(번호·카테고리) → 세리프 표제 → 부제
  function headBlock(a, i, tag) {
    var h = [];
    h.push('<p class="a-kicker"><span class="a-no">' + pad2(i + 1) + "</span>" + esc(displayCat(a["카테고리"])) + "</p>");
    h.push("<" + tag + ' class="a-head">' + esc(a["제목"]) + "</" + tag + ">");
    if (a["부제"]) h.push('<p class="a-standfirst">' + esc(a["부제"]) + "</p>");
    return h.join("");
  }

  // 기사 몸통 — 이미지(figure)·요약·본문·한마디(골드 칼럼 박스)
  function bodyBlock(a, pub) {
    var h = [];
    if (a["이미지"]) {
      h.push('<figure class="a-figure"><img src="' + esc(mediaSrc(a["이미지"])) + '" alt="" loading="lazy">');
      if (a["이미지캡션"]) h.push("<figcaption>" + esc(a["이미지캡션"]) + "</figcaption>");
      h.push("</figure>");
    }
    var segs = a["본문"] || [];
    var sum = a["요약"] || [];
    if (segs.length) {
      // 본문이 있는 호 — 요약은 표제 아래 요지 박스로
      if (sum.length) {
        h.push('<aside class="a-summary"><p class="label">요약</p>');
        sum.forEach(function (p) { h.push("<p>" + esc(p) + "</p>"); });
        h.push("</aside>");
      }
      h.push('<div class="a-body">');
      segs.forEach(function (seg) {
        h.push(seg.t === "h" ? "<h3>" + esc(seg.x) + "</h3>" : "<p>" + esc(seg.x) + "</p>");
      });
      h.push("</div>");
    } else if (sum.length) {
      // 요약만 있는 호 — 요약이 곧 기사 본문이다
      h.push('<div class="a-body">');
      sum.forEach(function (p) { h.push("<p>" + esc(p) + "</p>"); });
      h.push("</div>");
    }
    var comment = a["한마디"] || [];
    if (comment.length) {
      h.push('<aside class="a-note"><p class="a-note-label">' + esc(pub) + " FC의 한마디</p>");
      comment.forEach(function (p) { h.push("<p>" + esc(p) + "</p>"); });
      h.push('<p class="a-note-sign">' + esc(pub) + " FC</p></aside>");
    }
    return h.join("");
  }

  // 지면 전체 HTML. meta = 목록항목, data = 본문({편집장의말, 기사}).
  // list·edition은 없으면 다음 호 안내·발행인 치환만 빠진다(미리보기 경로).
  function issueHtml(meta, data, list, edition) {
    var pub = meta["발행인"] || "안창민";
    var mast = meta["채널"] + " " + pub;
    var editorLine = "편집장 안창민 FC" + (pub !== "안창민" ? " · 발행 " + esc(pub) + " FC" : "");
    var arts = (data && data["기사"]) || [];
    var note = (data && data["편집장의말"]) || [];
    var h = [];

    // 지면 헤더 — 제호 → 호수·발행일 → (대표 기사) 킥커 → 표제 → 부제 → 필자
    h.push('<header class="issue-head" id="a1">');
    h.push('<p class="issue-masthead">' + esc(mast) + "</p>");
    h.push('<p class="issue-line">통권 ' + esc(meta["호수"]) + "호 · " + esc(meta["주차라벨"]) + " · " + esc(displayDate(meta["발행일"], meta["주차라벨"])) + " 발행</p>");
    if (arts.length) {
      h.push(headBlock(arts[0], 0, "h1"));
      h.push('<p class="a-byline">' + editorLine + "</p>");
    }
    if (arts.length > 1) {
      h.push('<nav class="issue-toc" aria-label="이번 호 기사">');
      arts.forEach(function (a, i) {
        h.push('<a href="#a' + (i + 1) + '"><span class="a-no">' + pad2(i + 1) + "</span>" + esc(displayCat(a["카테고리"])) + "</a>");
      });
      h.push("</nav>");
    }
    // 표지 이미지는 폴드 직하 1장 — 대표 기사가 자체 이미지를 실으면 중복 질량이라 생략
    if (meta["커버이미지"] && !(arts[0] && arts[0]["이미지"])) {
      h.push('<figure class="a-figure issue-cover"><img src="' + esc(mediaSrc(meta["커버이미지"])) + '" alt="표지" fetchpriority="high"></figure>');
    }
    h.push("</header>");

    if (note.length) {
      h.push('<section class="issue-note"><p class="issue-note-label">편집장의 말</p>');
      note.forEach(function (p) { h.push("<p>" + esc(p) + "</p>"); });
      h.push('<p class="issue-note-sign">편집장 안창민</p></section>');
    }

    // 기사 — 대표 기사의 표제는 지면 헤더가 이미 실었다
    arts.forEach(function (a, i) {
      h.push('<article class="a' + (i === 0 ? " a-lead" : "") + '"' + (i > 0 ? ' id="a' + (i + 1) + '"' : "") + ">");
      if (i > 0) h.push(headBlock(a, i, "h2"));
      h.push(bodyBlock(a, pub));
      h.push("</article>");
    });

    // 지면 말미 — 필자 서명 → 다음 호 → 판권
    var org = edition ? (edition["소속"] || "") : "신한라이프 하랑지점";
    h.push('<footer class="issue-end">');
    h.push('<div class="sig-card"><p class="sig-name">' + esc(pub) + ' FC</p>');
    h.push('<p class="sig-role">' + (pub === "안창민" ? "편집장 · " : "발행 · ") + esc(org) + "</p></div>");

    // 다음 호 — 같은 채널의 실제 다음 발행분이 서재에 있을 때만 (실데이터 없으면 생략)
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
      h.push('<a class="next-issue" href="' + href + '">');
      h.push('<span class="next-label">다음 호</span>');
      h.push('<span class="next-title">' + esc(next["제목"]) + "</span>");
      h.push('<span class="next-meta">통권 ' + esc(next["호수"]) + "호 · " + esc(next["주차라벨"]) + "</span></a>");
    }

    h.push('<div class="colophon">');
    h.push('<p class="colophon-title">' + esc(mast) + "</p>");
    h.push("<p>통권 " + esc(meta["호수"]) + "호 · " + esc(meta["주차라벨"]) + " · " + editorLine + "</p>");
    h.push("<p>본 콘텐츠는 정보 제공 목적이며 개별 상품 권유가 아닙니다. 문의는 담당 설계사에게 연락해 주십시오.</p>");
    h.push('<a class="issue-return" href="./">케어센터 서재로</a>');
    h.push("</div></footer>");
    return h.join("");
  }

  window.care = {
    CAT_LABEL: CAT_LABEL,
    displayCat: displayCat,
    mediaSrc: mediaSrc,
    issueHtml: issueHtml,
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
