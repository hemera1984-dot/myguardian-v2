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

  // ---------- 설치 안내 ----------
  // 사이드바 하단의 업무공간 표시를 설치 버튼으로 대체한다. 설치는 화면을 떠나지 않고
  // 겹쳐서 띄운다 — 하던 일을 잃지 않게. (설치 전용 화면 install.html은 그대로 둔다:
  // 카톡으로 주소만 받은 팀원이 바로 여는 경로다.)

  var GUIDE = [
    ["아이폰·아이패드", ["사파리로 엽니다", "하단 공유 버튼을 누릅니다", '"홈 화면에 추가"를 선택합니다']],
    ["안드로이드", ["크롬으로 엽니다", '"이 기기에 바로 설치"를 누릅니다', "안내 창에서 설치를 확인합니다"]],
    ["데스크톱·노트북", ["크롬 또는 엣지로 엽니다", '"이 기기에 바로 설치"를 누르거나', "주소창 오른쪽 설치 아이콘을 누릅니다"]]
  ];

  function buildInstallModal(prompt) {
    var back = document.createElement("div");
    back.className = "install-modal-back";
    back.hidden = true;

    var box = document.createElement("div");
    box.className = "install-modal";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "install-modal-title");

    var head = document.createElement("div");
    head.className = "install-modal-head";
    var h = document.createElement("h2");
    h.id = "install-modal-title";
    h.textContent = "홈 화면에 바로가기 설치";
    var x = document.createElement("button");
    x.type = "button";
    x.className = "install-modal-x";
    x.setAttribute("aria-label", "닫기");
    x.textContent = "×";
    head.appendChild(h);
    head.appendChild(x);

    var desc = document.createElement("p");
    desc.className = "install-modal-desc";
    desc.textContent = "브라우저 주소 입력 없이 한 번에 열립니다. 새 계정이나 별도 데이터가 생기지 않습니다.";

    var actions = document.createElement("div");
    actions.className = "install-modal-actions";
    var go = document.createElement("button");
    go.type = "button";
    go.className = "install-primary";
    go.textContent = "이 기기에 바로 설치";
    var copy = document.createElement("button");
    copy.type = "button";
    copy.className = "install-secondary";
    copy.textContent = "앱 주소 복사";
    actions.appendChild(go);
    actions.appendChild(copy);

    var grid = document.createElement("div");
    grid.className = "install-modal-grid";
    GUIDE.forEach(function (g) {
      var card = document.createElement("div");
      var t = document.createElement("h3");
      t.textContent = g[0];
      var ol = document.createElement("ol");
      g[1].forEach(function (step) {
        var li = document.createElement("li");
        li.textContent = step;
        ol.appendChild(li);
      });
      card.appendChild(t);
      card.appendChild(ol);
      grid.appendChild(card);
    });

    var note = document.createElement("p");
    note.className = "install-modal-note";

    box.appendChild(head);
    box.appendChild(desc);
    box.appendChild(actions);
    box.appendChild(grid);
    box.appendChild(note);
    back.appendChild(box);
    document.body.appendChild(back);

    var lastFocus = null;
    function open() {
      lastFocus = document.activeElement;
      back.hidden = false;
      note.textContent = prompt.event
        ? "" : "이 브라우저에서는 자동 설치가 지원되지 않습니다. 위 기기별 안내를 따라 주세요.";
      go.disabled = !prompt.event;
      x.focus();
    }
    function close() {
      back.hidden = true;
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    x.addEventListener("click", close);
    back.addEventListener("click", function (e) { if (e.target === back) close(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !back.hidden) close();
    });
    go.addEventListener("click", function () {
      if (!prompt.event) return;
      prompt.event.prompt();
      prompt.event = null;
      go.disabled = true;
      note.textContent = "설치 안내 창에서 확인을 눌러 주세요.";
    });
    copy.addEventListener("click", function () {
      window.mg.copy(new URL("intro.html", window.location.href).href, copy);
    });

    return open;
  }

  document.addEventListener("DOMContentLoaded", function () {
    var sidebar = document.getElementById("platform-sidebar");
    if (!sidebar) return;

    // 설치 화면 자신에게는 붙이지 않는다
    if (/install\.html$/.test(window.location.pathname)) return;

    var prompt = { event: null };
    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault();
      prompt.event = e;
    });

    var status = sidebar.querySelector(".sidebar-status");
    var existing = sidebar.querySelector("#btn-install");
    if (existing) existing.remove();

    // 초대는 누구나 할 수 있다. 승인은 총관리자·팀장급만 (서버가 판정).
    var invite = document.createElement("button");
    invite.type = "button";
    invite.id = "btn-invite";
    invite.className = "install-btn invite-btn";
    invite.textContent = "팀원 초대하기";
    invite.addEventListener("click", function () {
      window.mg.copy(inviteText(), invite);
    });

    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = "btn-install";
    btn.className = "install-btn";
    btn.textContent = "홈 화면에 바로가기 설치";

    // 업무공간 표시를 걷어내고 그 자리(하단)에 초대·설치 버튼을 둔다
    if (status) status.replaceWith(invite);
    else sidebar.appendChild(invite);
    invite.after(btn);

    var open = buildInstallModal(prompt);
    btn.addEventListener("click", open);
  });

  // 초대 문구 — 받는 사람이 주소를 열고 구글로 로그인하면 승인 대기로 잡힌다
  function inviteText() {
    var sender = "";
    try {
      var s = JSON.parse(localStorage.getItem("mg_care_sender") || "{}");
      if (s["이름"]) sender = s["이름"];
    } catch (e) {}
    var url = new URL("intro.html", window.location.href).href;
    return [
      "[마이가디언 초대]",
      "",
      "안녕하세요" + (sender ? ", " + sender + "입니다" : "") + ".",
      "우리 팀 업무 플랫폼 마이가디언에 초대합니다.",
      "",
      "아래 주소를 열고 구글 계정으로 로그인해 주세요.",
      url,
      "",
      "로그인하면 승인 대기 상태가 됩니다.",
      "관리자가 승인하면 바로 이용할 수 있습니다."
    ].join("\n");
  }
})();
