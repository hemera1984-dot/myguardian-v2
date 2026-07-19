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

  // 모바일 사이드바 토글 (+ Escape 닫기)
  document.addEventListener("DOMContentLoaded", function () {
    var button = document.getElementById("mobile-menu");
    var sidebar = document.getElementById("platform-sidebar");
    var overlay = document.getElementById("platform-overlay");
    if (!button || !sidebar || !overlay) return;
    function closeMenu() {
      sidebar.classList.remove("open");
      overlay.classList.remove("show");
      button.setAttribute("aria-expanded", "false");
    }
    button.addEventListener("click", function () {
      var open = sidebar.classList.toggle("open");
      overlay.classList.toggle("show", open);
      button.setAttribute("aria-expanded", String(open));
    });
    overlay.addEventListener("click", closeMenu);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeMenu();
    });
  });
})();
