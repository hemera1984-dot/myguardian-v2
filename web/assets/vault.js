// 고객 금고 — 레코드를 기기에서 감싸고 푼다. 서버는 암호문만 본다(헌법: 종단간 암호화).
//
// 감싸는 모양 (2026-08-24 결정):
//   레코드 --AES-GCM(데이터열쇠)--> 암호문
//   데이터열쇠 --AES-GCM(FC열쇠)-------> 열쇠_fc    ... 평상시 이것으로 연다
//   데이터열쇠 --RSA-OAEP(비상공개키)--> 열쇠_비상   ... 분실·퇴사 때만
//
// 비상열쇠가 비대칭인 이유: 대칭이면 감싸기 위해 FC 기기마다 그 열쇠가 있어야 하고,
// 그러면 비상열쇠가 아니라 공용 열쇠가 된다. 공개키만 심으면 FC는 혼자 감쌀 수 있고
// 푸는 것은 개인키를 가진 사람뿐이다.
//
// 외부 라이브러리를 쓰지 않는다 — 브라우저 표준 WebCrypto만 쓴다(헌법: 의존성 0).
(function () {
  "use strict";

  var C = (window.crypto && window.crypto.subtle) || null;
  var 반복 = 310000;   // PBKDF2 반복. OWASP 2023 권고치(SHA-256)

  function b64(buf) {
    var b = new Uint8Array(buf), s = "";
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  }
  function un64(s) {
    var raw = atob(s), b = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) b[i] = raw.charCodeAt(i);
    return b;
  }
  function 무작위(n) { return window.crypto.getRandomValues(new Uint8Array(n)); }

  // FC 열쇠 — 잠금문구에서 파생한다. 서버는 잠금문구도 이 열쇠도 받지 않는다.
  // 소금은 계정마다 고정이어야 다른 기기에서 같은 열쇠가 나온다 — 이메일을 쓴다.
  function fc열쇠(잠금문구, 이메일) {
    var enc = new TextEncoder();
    return C.importKey("raw", enc.encode(잠금문구), "PBKDF2", false, ["deriveKey"])
      .then(function (base) {
        return C.deriveKey(
          { name: "PBKDF2", salt: enc.encode("mg-vault-v1:" + String(이메일 || "").toLowerCase()),
            iterations: 반복, hash: "SHA-256" },
          base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      });
  }

  function 비상공개키(pemOrJwk) {
    return C.importKey("jwk", pemOrJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  }

  // 열쇠 지문 — 어느 비상열쇠로 감쌌는지 남긴다. 비상키를 새로 만들면 여기서 갈린다.
  function 지문(jwk) {
    return C.digest("SHA-256", new TextEncoder().encode(jwk.n || ""))
      .then(function (h) { return b64(h).slice(0, 22); });
  }

  // 레코드 하나를 감싼다. 돌려주는 것이 그대로 서버에 올라간다.
  function 감싸기(레코드, opts) {
    var 평문 = new TextEncoder().encode(JSON.stringify(레코드));
    var iv = 무작위(12);
    var 데이터열쇠;
    return C.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"])
      .then(function (k) {
        데이터열쇠 = k;
        return C.encrypt({ name: "AES-GCM", iv: iv }, k, 평문);
      })
      .then(function (ct) {
        var 암호문 = b64(iv) + "." + b64(ct);
        return C.exportKey("raw", 데이터열쇠).then(function (raw) {
          var iv2 = 무작위(12);
          return Promise.all([
            C.encrypt({ name: "AES-GCM", iv: iv2 }, opts.fc열쇠, raw)
              .then(function (w) { return b64(iv2) + "." + b64(w); }),
            C.encrypt({ name: "RSA-OAEP" }, opts.비상공개키, raw).then(b64),
            암호문
          ]);
        });
      })
      .then(function (a) {
        return {
          "고객코드": 레코드["고객코드"],
          "암호문": a[2],
          "열쇠_fc": a[0],
          "열쇠_비상": a[1],
          "비상키지문": opts.지문 || ""
        };
      });
  }

  // 서버에서 받은 레코드를 FC 열쇠로 푼다. 비상 경로는 여기 없다 — 별도 도구로만 연다.
  function 풀기(행, fc키) {
    var w = String(행["열쇠_fc"] || "").split(".");
    var c = String(행["암호문"] || "").split(".");
    if (w.length !== 2 || c.length !== 2) return Promise.reject(new Error("레코드 형식 오류"));
    return C.decrypt({ name: "AES-GCM", iv: un64(w[0]) }, fc키, un64(w[1]))
      .then(function (raw) {
        return C.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
      })
      .then(function (dk) {
        return C.decrypt({ name: "AES-GCM", iv: un64(c[0]) }, dk, un64(c[1]));
      })
      .then(function (pt) { return JSON.parse(new TextDecoder().decode(pt)); });
  }

  // 비상 열쇠쌍 만들기 — 안창민이 한 번만 돌린다. 개인키는 내려받아 오프라인 보관하고
  // 공개키만 서버에 올린다. 개인키가 새면 전원의 데이터가 새는 유일한 급소다.
  function 비상열쇠만들기() {
    return C.generateKey(
      { name: "RSA-OAEP", modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["encrypt", "decrypt"]
    ).then(function (쌍) {
      return Promise.all([C.exportKey("jwk", 쌍.publicKey), C.exportKey("jwk", 쌍.privateKey)])
        .then(function (j) {
          return 지문(j[0]).then(function (f) {
            return { 공개키: j[0], 개인키: j[1], 지문: f };
          });
        });
    });
  }

  // 비상 복구 — 개인키 파일을 들고 있을 때만 된다.
  function 비상풀기(행, 개인키jwk) {
    return C.importKey("jwk", 개인키jwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"])
      .then(function (pk) {
        return C.decrypt({ name: "RSA-OAEP" }, pk, un64(행["열쇠_비상"]));
      })
      .then(function (raw) {
        return C.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
      })
      .then(function (dk) {
        var c = String(행["암호문"] || "").split(".");
        return C.decrypt({ name: "AES-GCM", iv: un64(c[0]) }, dk, un64(c[1]));
      })
      .then(function (pt) { return JSON.parse(new TextDecoder().decode(pt)); });
  }

  window.mgVault = {
    쓸수있나: function () { return !!C && !!window.isSecureContext; },
    fc열쇠: fc열쇠,
    비상공개키: 비상공개키,
    지문: 지문,
    감싸기: 감싸기,
    풀기: 풀기,
    비상열쇠만들기: 비상열쇠만들기,
    비상풀기: 비상풀기
  };
})();
