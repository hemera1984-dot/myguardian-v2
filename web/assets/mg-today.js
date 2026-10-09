/* 연락할 고객 규칙 — 홈 「오늘」과 고객관리 「연락할 고객」 보기가 같이 쓴다(2026-10-10, 두 곳에 따로 있던 것을 합침).
   규칙은 이 파일 한 곳에서만 고친다. 우선순위: 다시 전화 > 연락일(오늘·지남) > 후속 연락(미팅 끝난 지 3~14일, 잡힌 미팅 없음). */
(function () {
  "use strict";
  var DAYS = "일월화수목금토";
  function today() { var d = new Date(); return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }
  function dayDiff(iso) { return Math.round((new Date(String(iso).slice(0, 10) + "T00:00:00") - new Date(today() + "T00:00:00")) / 864e5); }
  function md(iso) { var x = new Date(String(iso).slice(0, 10) + "T00:00:00"); return (x.getMonth() + 1) + "." + x.getDate() + " " + DAYS.charAt(x.getDay()); }

  // profile = 고객 레코드의 profile (다음 연락일은 v1원본 안에 산다)
  function callReason(profile) {
    var p = profile || {}, o = p["v1원본"] || p, st = p["진행상태"], nc = o.nextContactDate;
    var mts = p["미팅"] || [];
    if (st === "다시 전화") return { kind: "다시 전화", text: nc ? "다음 연락 " + md(nc) : "다시 연락하기로 함" };
    if (nc && dayDiff(nc) <= 0) return { kind: "연락일", text: (dayDiff(nc) === 0 ? "오늘" : -dayDiff(nc) + "일 지남") + " · " + md(nc) };
    if (st === "거절" || st === "보류") return null;
    var done = null;
    mts.forEach(function (m) { if (m && m["상태"] === "완료" && m["일자"] && (!done || m["일자"] > done)) done = m["일자"]; });
    if (!done || mts.some(function (m) { return m && m["상태"] === "예정"; })) return null;
    var ago = -dayDiff(done);
    return ago >= 3 && ago <= 14 ? { kind: "후속 연락", text: "미팅 끝난 지 " + ago + "일" } : null;
  }
  var ORDER = { "다시 전화": 0, "연락일": 1, "후속 연락": 2 };

  window.mgToday = { callReason: callReason, order: ORDER };
})();
