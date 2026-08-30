// 고객 금고 — 2026-08-31 잠금문구를 없앴다.
// 감싸고 푸는 일은 서버가 한다(서버 보관 열쇠). 설계사는 아무것도 입력하지 않는다.
// FC는 자기 고객만 본다. 남의 고객은 총관리자가 열람 비밀번호를 넣을 때만 열린다.
// 경위와 대가는 docs/decisions.md「잠금문구 폐지」 항목에 있다.
(function () {
  "use strict";

  function api(path, opts) { return window.mgAuth.api(path, opts); }

  // 내 고객 — 로그인만 돼 있으면 바로 열린다
  function 내려받기() {
    return api("/clients").then(function (d) {
      return { 고객: d["고객"] || [], 못푼건수: d["못푼건수"] || 0 };
    });
  }

  // 평문 그대로 올린다. 감싸는 일은 서버가 한다.
  function 올리기(레코드들) {
    var 목록 = Array.isArray(레코드들) ? 레코드들 : [레코드들];
    return api("/clients", { method: "PUT", body: 목록 });
  }

  // 총관리자가 다른 FC 몫으로 올린다 (새 팀원이 왔을 때·인수인계)
  function 대신올리기(레코드들, 대상) {
    var 목록 = Array.isArray(레코드들) ? 레코드들 : [레코드들];
    if (!대상 || !대상.계정) return Promise.reject(new Error("누구 몫으로 올릴지 정해야 합니다."));
    return api("/clients", { method: "PUT", body: { "소유": 대상.계정, "레코드": 목록 } });
  }

  // 남의 고객 보기 — 총관리자 + 열람 비밀번호. 퇴사·인수인계·점검이 여기서 끝난다.
  function 남의것보기(계정, 비밀번호) {
    return api("/clients/of/" + Number(계정), { method: "POST", body: { "비밀번호": 비밀번호 } });
  }

  function 열람비번상태() { return api("/admin/viewpw"); }
  function 열람비번정하기(새것, 지금것) {
    return api("/admin/viewpw", { method: "PUT", body: { "비밀번호": 새것, "지금것": 지금것 || "" } });
  }

  window.mgVaultUI = {
    내려받기: 내려받기,
    올리기: 올리기,
    대신올리기: 대신올리기,
    남의것보기: 남의것보기,
    열람비번상태: 열람비번상태,
    열람비번정하기: 열람비번정하기
  };
})();
