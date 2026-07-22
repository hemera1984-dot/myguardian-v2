// 마이가디언 공용 스크립트 — 전 화면 공유 유틸리티
// (사이드바 토글, HTML 이스케이프, 클립보드 복사)
(function () {
  "use strict";

  window.mg = {
    // HTML 이스케이프 — innerHTML 조립 전 필수
    esc: function (s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
      });
    },

    // JSON·수집 데이터에서 온 링크의 스킴 제한 (Codex 3차 제안) — http(s)만 허용.
    // javascript:·data: 등은 빈 링크(#)로 무력화한다. href에 넣기 전에 통과시킨다.
    safeUrl: function (u) {
      try {
        var p = new URL(String(u), window.location.href);
        return (p.protocol === "https:" || p.protocol === "http:") ? p.href : "#";
      } catch (e) {
        return "#";
      }
    },

    // 클립보드 복사 + 버튼 피드백
    copy: function (text, button) {
      function done() {
        if (!button) return;
        var original = button.textContent;
        button.textContent = "복사됨";
        setTimeout(function () { button.textContent = original; }, 1500);
      }
      function legacy() {
        var ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        done();
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(legacy); // 권한 거부 시 구식 복사로 폴백
      } else {
        legacy();
      }
    }
  };

  // 모바일 사이드바 토글 (+ Escape 닫기, 닫힘 시 inert로 탭 순서에서 제외 — Codex 3차 중요4)
  document.addEventListener("DOMContentLoaded", function () {
    var button = document.getElementById("mobile-menu");
    var sidebar = document.getElementById("platform-sidebar");
    var overlay = document.getElementById("platform-overlay");
    if (!button || !sidebar || !overlay) return;
    var mobile = window.matchMedia("(max-width: 767px)");

    // 데스크톱: 사이드바는 항상 보이고 접근 가능. 모바일: 닫혀 있으면 화면 밖이므로
    // inert·aria-hidden으로 키보드 탭 순서와 스크린리더에서 제외한다.
    function syncInert() {
      var hideFromA11y = mobile.matches && !sidebar.classList.contains("open");
      sidebar.inert = hideFromA11y;
      if (hideFromA11y) sidebar.setAttribute("aria-hidden", "true");
      else sidebar.removeAttribute("aria-hidden");
    }
    function closeMenu(focusButton) {
      sidebar.classList.remove("open");
      overlay.classList.remove("show");
      button.setAttribute("aria-expanded", "false");
      // inert를 걸기 전에 포커스를 먼저 햄버거로 옮긴다 — inert 적용 순간
      // 사이드바 안에 있던 포커스가 body로 튕겨 나가지 않도록.
      if (focusButton) button.focus();
      syncInert();
    }
    button.addEventListener("click", function () {
      var open = sidebar.classList.toggle("open");
      overlay.classList.toggle("show", open);
      button.setAttribute("aria-expanded", String(open));
      if (open) {
        syncInert(); // 먼저 inert 해제해야 포커스가 들어간다
        // 첫 포커스는 브랜드 로고가 아니라 첫 실제 메뉴 항목으로
        var firstMenu = sidebar.querySelector(".platform-nav a, .platform-nav button");
        if (firstMenu) firstMenu.focus();
      } else {
        closeMenu(true);
      }
    });
    overlay.addEventListener("click", function () { closeMenu(true); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && sidebar.classList.contains("open")) closeMenu(true);
    });
    mobile.addEventListener("change", syncInert);
    syncInert();
  });
})();
