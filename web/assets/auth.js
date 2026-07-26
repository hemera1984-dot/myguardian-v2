// 마이가디언 인증 클라이언트 — 구글 로그인 + 세션 + 화면 게이트
//
// 원칙: 이 파일은 편의를 담당할 뿐 보안을 담당하지 않는다. 진짜 차단은 서버가 한다
// (승인되지 않은 계정에는 서버가 데이터를 주지 않는다). 여기서 화면을 가리는 것은
// 사용자가 헤매지 않게 하기 위한 것이며, 소스를 열면 보이는 값에 의존하지 않는다.

(function () {
  "use strict";

  // 구글 OAuth 웹 클라이언트 ID — 공개돼도 되는 값이다 (비밀키는 이 방식에서 쓰지 않는다)
  var CLIENT_ID = "370923160679-3h1hn1flheb4d01bq1amtutr992kldj1.apps.googleusercontent.com";

  // 인증 서버 주소. 로컬에서 개발할 때는 같은 PC의 서버를 본다.
  // NCP 배포 후 PROD 값을 실제 도메인으로 바꾼다.
  var PROD_API = "https://api.insurguard.life";
  var LOCAL_API = "http://localhost:8787";

  function apiBase() {
    var h = location.hostname;
    if (h === "localhost" || h === "127.0.0.1") return LOCAL_API;
    return PROD_API;
  }

  var TOKEN_KEY = "mg_session";
  // ponytail: 세션 토큰을 localStorage에 둔다. httpOnly 쿠키가 더 안전하지만
  //   교차 출처(Pages ↔ NCP) 쿠키 설정이 붙는다. 도메인을 합치게 되면 쿠키로 옮긴다.

  function token() {
    try { return localStorage.getItem(TOKEN_KEY) || null; } catch (e) { return null; }
  }

  function setToken(t) {
    try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }

  function api(path, options) {
    options = options || {};
    var base = apiBase();
    if (!base) return Promise.reject(new Error("인증 서버 주소가 설정되지 않았습니다."));
    var headers = { "Content-Type": "application/json" };
    var t = token();
    if (t) headers.Authorization = "Bearer " + t;
    return fetch(base + path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) {
          var err = new Error(data.error || "요청이 실패했습니다.");
          err.status = r.status;
          throw err;
        }
        return data;
      });
    });
  }

  // 구글 Identity Services 스크립트를 한 번만 싣는다
  var gisPromise = null;
  function loadGis() {
    if (gisPromise) return gisPromise;
    gisPromise = new Promise(function (resolve, reject) {
      if (window.google && window.google.accounts) return resolve();
      var s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("구글 로그인을 불러오지 못했습니다.")); };
      document.head.appendChild(s);
    });
    return gisPromise;
  }

  // 구글 버튼을 그리고, 로그인하면 서버에 토큰을 넘겨 세션을 받는다
  function renderButton(el, onDone, onError) {
    return loadGis().then(function () {
      window.google.accounts.id.initialize({
        client_id: CLIENT_ID,
        callback: function (resp) {
          api("/auth/google", { method: "POST", body: { credential: resp.credential } })
            .then(function (data) {
              setToken(data["토큰"]);
              onDone(data["계정"]);
            })
            .catch(function (err) { if (onError) onError(err); });
        }
      });
      window.google.accounts.id.renderButton(el, {
        theme: "outline", size: "large", shape: "rectangular",
        text: "signin_with", locale: "ko", width: 280
      });
    });
  }

  function me() {
    if (!token()) return Promise.resolve(null);
    return api("/me").catch(function (err) {
      if (err.status === 401) { setToken(null); return null; }  // 만료·폐기된 세션 정리
      throw err;
    });
  }

  function signOut() {
    var done = token() ? api("/auth/logout", { method: "POST" }).catch(function () {}) : Promise.resolve();
    return done.then(function () {
      setToken(null);
      try { if (window.google && window.google.accounts) window.google.accounts.id.disableAutoSelect(); } catch (e) {}
    });
  }

  // 플랫폼 화면 게이트 — 로그인 안 했거나 미승인이면 진입 화면으로 보낸다.
  // 다시 말하지만 이것은 안내이지 차단이 아니다. 차단은 서버가 한다.
  function guard(introPath) {
    return me().then(function (info) {
      if (!info || info["계정"]["상태"] !== "승인") {
        location.replace(introPath || "intro.html");
        return null;
      }
      return info;
    }).catch(function () {
      return null;  // 서버가 꺼져 있어도 화면은 막지 않는다 (공개 데이터는 그대로 열람)
    });
  }

  window.mgAuth = {
    CLIENT_ID: CLIENT_ID,
    apiBase: apiBase,
    api: api,
    token: token,
    renderButton: renderButton,
    me: me,
    signOut: signOut,
    guard: guard
  };
})();
