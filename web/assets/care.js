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

  function issueUrl(issue) {
    return new URL("issue.html?id=" + encodeURIComponent(issue.id), window.location.href).href;
  }

  function kakaoText(issue) {
    var s = loadSender();
    var url = issueUrl(issue);
    var toc = issue["꼭지"] || [];
    var mag = "『" + issue["채널"] + " " + (issue["발행인"] || "안창민") + "』";
    var lines = ["안녕하세요, " + s["이름"] + "입니다.", ""];
    if (issue["채널"] === "주간") {
      lines.push("건강 유의하시고 좋은 한 주 보내세요.", "");
      lines.push(mag + " " + (issue["주차라벨"] || "") + " (통권 " + issue["호수"] + "호)");
      lines.push("이번 주 뉴스 브리핑이 발행되었습니다.", "");
      lines.push("[이번 주 주요 뉴스]", BAR);
      toc.forEach(function (t) {
        lines.push((CAT_LABEL[t["카테고리"]] || t["카테고리"]) + " | " + t["제목"]);
      });
      lines.push(BAR, "");
      if (toc.length) lines.push("이번 주 핵심: " + toc[0]["제목"], "");
    } else {
      lines.push("환절기 건강 잘 챙기고 계신가요?", "");
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
  function openCompose(issue) {
    var panel = document.getElementById("compose");
    if (!panel) return;
    document.getElementById("compose-title").textContent =
      "카톡 문구 — " + issue["채널"] + " " + (issue["발행인"] || "안창민") + " " + issue["호수"] + "호 (수정 후 복사하세요)";
    document.getElementById("compose-text").value = kakaoText(issue);
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

  function sortByDate(list) {
    return list.slice().sort(function (a, b) { return (b["발행일"] || "") < (a["발행일"] || "") ? -1 : 1; });
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

  window.care = {
    CAT_LABEL: CAT_LABEL,
    loadSender: loadSender,
    saveSender: saveSender,
    bindSenderRow: bindSenderRow,
    kakaoText: kakaoText,
    openCompose: openCompose,
    bindCompose: bindCompose,
    sortByDate: sortByDate,
    published: published,
    drafts: drafts,
    latestByChannel: latestByChannel,
    esc: esc
  };
})();
