(function () {
  "use strict";

  var number = function (value) { return Number(value || 0).toLocaleString("ko-KR"); };
  var side = document.getElementById("side");
  var overlay = document.getElementById("side-overlay");
  var menu = document.getElementById("menu-button");

  function setMenu(open) {
    side.classList.toggle("open", open);
    overlay.classList.toggle("open", open);
    menu.setAttribute("aria-expanded", String(open));
  }

  menu.addEventListener("click", function () { setMenu(!side.classList.contains("open")); });
  overlay.addEventListener("click", function () { setMenu(false); });

  document.getElementById("master-search").addEventListener("submit", function (event) {
    event.preventDefault();
    var query = document.getElementById("master-q").value.trim();
    if (query) location.href = "../cases/?q=" + encodeURIComponent(query);
  });

  var today = new Date();
  var dateText = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(today);
  document.getElementById("today-label").textContent = dateText + " · 자료 현황과 최근 발행물을 확인하고 필요한 업무로 바로 이동하세요.";

  var due = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  var add = (8 - due.getDay()) % 7;
  due.setDate(due.getDate() + add);
  var diff = Math.round((due - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
  document.getElementById("publication-label").textContent = diff === 0 ? "오늘은 주간 케어 발행일입니다" : diff === 1 ? "내일은 주간 케어 발행일입니다" : "다음 주간 케어 발행까지 D-" + diff;
  document.getElementById("publication-copy").textContent = (due.getMonth() + 1) + "월 " + due.getDate() + "일 발행 예정 · 발행 전 원고와 카톡 문구를 확인하세요.";

  fetch("../../data/stats.json")
    .then(function (response) { return response.json(); })
    .then(function (stats) {
      var cases = Number(stats["사례"] || 0);
      var terms = Number(stats["용어"] || 0);
      var diseases = Number(stats["질병"] || 0);
      document.getElementById("total-count").textContent = number(cases + terms + diseases) + "건";
      document.getElementById("metric-cases").textContent = number(cases);
      document.getElementById("metric-terms").textContent = number(terms);
      document.getElementById("metric-diseases").textContent = number(diseases);
      document.getElementById("raw-count").textContent = number(stats["사례_원본레코드"]) + "건";

      var sources = stats["사례_출처별"] || {};
      document.getElementById("metric-cases-detail").textContent = Object.keys(sources).slice(0, 2).map(function (key) { return key + " " + number(sources[key]); }).join(" · ");
      var max = Math.max.apply(null, Object.keys(sources).map(function (key) { return Number(sources[key] || 0); }).concat([1]));
      document.getElementById("source-table").innerHTML = Object.keys(sources).map(function (key) {
        var count = Number(sources[key] || 0);
        return '<div class="source-row"><span>' + key + '</span><div class="source-bar"><i style="width:' + Math.max(3, Math.round(count / max * 100)) + '%"></i></div><strong>' + number(count) + '</strong></div>';
      }).join("");
    })
    .catch(function () {
      document.getElementById("source-table").innerHTML = "<p>자료 현황을 불러오지 못했습니다.</p>";
    });

  fetch("../../data/care/issues.json")
    .then(function (response) { return response.json(); })
    .then(function (issues) {
      var list = Array.isArray(issues) ? issues.slice() : (issues.data || []).slice();
      list.sort(function (left, right) { return String(right["발행일"] || "").localeCompare(String(left["발행일"] || "")); });
      document.getElementById("metric-care").textContent = number(list.length);
      if (!list.length) return;
      var latest = list[0];
      var link = "../care/issue.html?id=" + encodeURIComponent(latest.id);
      document.getElementById("latest-care").href = link;
      document.getElementById("latest-cover").src = "../../" + latest["커버이미지"];
      document.getElementById("latest-channel").textContent = latest["채널"];
      document.getElementById("latest-meta").textContent = latest["발행일"] + " · " + latest["채널"] + " " + latest["호수"] + "호";
      document.getElementById("latest-title").textContent = latest["제목"];
      document.getElementById("latest-summary").textContent = latest["요약"] || "최근 발행물";
    })
    .catch(function () {
      document.getElementById("latest-title").textContent = "발행 정보를 불러오지 못했습니다";
    });
})();
