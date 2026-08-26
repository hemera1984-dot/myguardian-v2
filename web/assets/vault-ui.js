// 금고 열기 — 잠금문구를 받아 FC 열쇠를 만든다. 화면들이 이것만 부르면 된다.
//
// 잠금문구는 어디에도 저장하지 않는다. 서버는 물론이고 이 브라우저에도 남기지 않는다.
// 탭을 닫으면 사라지고 다시 물어본다 — 남의 자리에서 열어 두고 간 상태를 만들지 않는다.
//
// 맞는 문구인지는 따로 저장한 확인표로 검사하지 않는다. 확인표를 두면 그것만 빼내
// 오프라인에서 문구를 두들겨 볼 수 있기 때문이다. 대신 이미 올라간 레코드 하나를
// 실제로 풀어 본다 — 레코드가 없으면 검사할 것도 없다.
(function () {
  "use strict";

  var V = window.mgVault;
  var 열쇠 = null;          // 이 탭에서만 산다
  var 공개키 = null, 지문 = "";

  function api(path, opts) {
    return window.mgAuth.api(path, opts);
  }

  // 지점 비상 공개키 — 감쌀 때마다 필요하므로 한 번 받아 들고 있는다
  function 비상키받기() {
    if (공개키) return Promise.resolve({ 키: 공개키, 지문: 지문 });
    return api("/vault/pubkey").then(function (d) {
      지문 = d["지문"] || "";
      return V.비상공개키(d["공개키"]).then(function (k) {
        공개키 = k;
        return { 키: k, 지문: 지문 };
      });
    });
  }

  function 상자(제목, 설명, 확인글) {
    return new Promise(function (resolve, reject) {
      var wrap = document.createElement("div");
      wrap.className = "vault-veil";
      wrap.innerHTML =
        '<form class="vault-box">'
        + '<h2>' + 제목 + '</h2>'
        + '<p class="vault-why">' + 설명 + '</p>'
        + '<label for="vault-pw">잠금문구</label>'
        + '<input type="password" id="vault-pw" autocomplete="current-password" required>'
        + (확인글 ? '<label for="vault-pw2">한 번 더</label>'
            + '<input type="password" id="vault-pw2" autocomplete="new-password" required>' : "")
        + '<p class="vault-err" hidden></p>'
        + '<div class="vault-row"><button type="submit" class="btn btn-primary">'
        + (확인글 || "열기") + '</button>'
        + '<button type="button" class="btn" data-close>취소</button></div>'
        + '</form>';
      document.body.appendChild(wrap);
      var form = wrap.querySelector("form");
      var pw = wrap.querySelector("#vault-pw");
      var pw2 = wrap.querySelector("#vault-pw2");
      var err = wrap.querySelector(".vault-err");
      pw.focus();
      function 닫기() { wrap.remove(); }
      function 알림(m) { err.hidden = false; err.textContent = m; }
      wrap.querySelector("[data-close]").addEventListener("click", function () {
        닫기(); reject(new Error("취소"));
      });
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var v = pw.value;
        if (확인글) {
          if (v.length < 8) return 알림("잠금문구는 8자 이상으로 정하세요.");
          if (v !== pw2.value) return 알림("두 번 넣은 값이 다릅니다.");
        } else if (!v) {
          return 알림("잠금문구를 넣으세요.");
        }
        닫기();
        resolve(v);
      });
    });
  }

  // 화면이 부르는 것 — 열쇠가 이미 있으면 그대로, 없으면 물어본다.
  // 이미 올라간 레코드가 있으면 하나를 실제로 풀어 문구가 맞는지 확인한다.
  function 열기(opts) {
    opts = opts || {};
    if (열쇠 && !opts.다시) return Promise.resolve(열쇠);
    if (!V.쓸수있나()) {
      return Promise.reject(new Error("이 브라우저에서는 암호 기능을 쓸 수 없습니다(HTTPS 필요)."));
    }
    var 나;
    return window.mgAuth.me().then(function (info) {
      나 = (info && info["계정"]) || {};
      return api("/clients/stamps");
    }).then(function (목록) {
      var 처음 = !Array.isArray(목록) || !목록.length;
      // 소금은 계정 이메일이다. 여기가 어긋나면 같은 문구라도 다른 열쇠가 나와
      // 기기마다 안 열린다 — 값이 없으면 아예 진행하지 않는다.
      var 메일 = String(나["이메일"] || "").trim();
      if (!메일) throw new Error("계정 정보를 받지 못했습니다. 다시 로그인해 주세요.");
      return 상자(
        처음 ? "잠금문구 정하기" : "금고 열기",
        처음
          ? "고객 정보는 이 문구로 잠급니다. 서버에는 잠긴 채로만 올라가고 문구는 어디에도 저장되지 않습니다."
            + " <b>잊으면 본인은 열 수 없습니다</b> — 그때는 지점 비상 열쇠로만 복구됩니다."
          : "고객 정보를 열려면 잠금문구가 필요합니다. 다른 기기에서도 같은 문구를 넣으면 열립니다.",
        처음 ? "정하기" : ""
      ).then(function (문구) {
        return V.fc열쇠(문구, 메일).then(function (k) {
          if (처음) { 열쇠 = k; return k; }
          // 맞는 문구인지 실제 레코드로 확인한다
          return api("/clients").then(function (행들) {
            if (!행들.length) { 열쇠 = k; return k; }
            return V.풀기(행들[0], k).then(function () { 열쇠 = k; return k; })
              .catch(function () { throw new Error("잠금문구가 맞지 않습니다."); });
          });
        });
      });
    });
  }

  function 잠그기() { 열쇠 = null; }

  // 레코드를 올린다 — 감싸는 일은 전부 여기서 끝난다. 화면은 평문만 넘기면 된다.
  function 올리기(레코드들) {
    var 목록 = Array.isArray(레코드들) ? 레코드들 : [레코드들];
    return Promise.all([열기(), 비상키받기()]).then(function (a) {
      var fc = a[0], 비상 = a[1];
      return Promise.all(목록.map(function (r) {
        return V.감싸기(r, { fc열쇠: fc, 비상공개키: 비상.키, 지문: 비상.지문 });
      }));
    }).then(function (봉투들) {
      return api("/clients", { method: "PUT", body: 봉투들 });
    });
  }

  // 전부 내려받아 푼다. 못 푸는 레코드는 건너뛰고 몇 건이었는지 알린다.
  function 내려받기() {
    return 열기().then(function (fc) {
      return api("/clients").then(function (행들) {
        var 못푼것 = 0;
        return Promise.all(행들.map(function (행) {
          return V.풀기(행, fc).catch(function () { 못푼것++; return null; });
        })).then(function (목록) {
          return { 고객: 목록.filter(Boolean), 못푼건수: 못푼것 };
        });
      });
    });
  }

  // 총관리자가 다른 FC 몫으로 올린다. 그 사람 이메일과 첫 잠금문구로 열쇠를 만들어
  // 감싸므로, 그 사람은 자기 기기에서 그 문구로 바로 열 수 있다.
  // 총관리자는 지점 비상 개인키로 어차피 전부 열 수 있으므로 새로 생기는 권한은 없다.
  function 대신올리기(레코드들, 대상) {
    var 목록 = Array.isArray(레코드들) ? 레코드들 : [레코드들];
    if (!대상 || !대상.계정 || !대상.이메일) {
      return Promise.reject(new Error("누구 몫으로 올릴지 정해야 합니다."));
    }
    if (!대상.잠금문구 || 대상.잠금문구.length < 8) {
      return Promise.reject(new Error("그 사람이 처음 쓸 잠금문구를 8자 이상으로 정하세요."));
    }
    return Promise.all([
      V.fc열쇠(대상.잠금문구, String(대상.이메일).toLowerCase()),
      비상키받기()
    ]).then(function (a) {
      var 남의열쇠 = a[0], 비상 = a[1];
      return Promise.all(목록.map(function (r) {
        return V.감싸기(r, { fc열쇠: 남의열쇠, 비상공개키: 비상.키, 지문: 비상.지문 });
      }));
    }).then(function (봉투들) {
      return api("/clients", { method: "PUT", body: { "소유": 대상.계정, "레코드": 봉투들 } });
    });
  }

  // 잠금문구 바꾸기 — 전부 내려 풀고 새 문구로 다시 감싸 올린다.
  // 총관리자가 정해 준 첫 문구를 본인 것으로 바꾸는 자리다.
  function 문구바꾸기() {
    var 나;
    return window.mgAuth.me().then(function (info) {
      나 = (info && info["계정"]) || {};
      return 열기();
    }).then(function (옛열쇠) {
      return api("/clients").then(function (행들) {
        return Promise.all(행들.map(function (행) { return V.풀기(행, 옛열쇠); }));
      });
    }).then(function (고객들) {
      return 상자("잠금문구 바꾸기",
        "새 문구로 " + 고객들.length + "명을 모두 다시 잠급니다."
        + " 바꾸고 나면 옛 문구로는 열리지 않습니다.", "바꾸기"
      ).then(function (새문구) {
        return Promise.all([
          V.fc열쇠(새문구, String(나["이메일"] || "").toLowerCase()),
          비상키받기()
        ]).then(function (a) {
          return Promise.all(고객들.map(function (r) {
            return V.감싸기(r, { fc열쇠: a[0], 비상공개키: a[1].키, 지문: a[1].지문 });
          })).then(function (봉투들) {
            if (!봉투들.length) { 열쇠 = a[0]; return { 건수: 0 }; }
            return api("/clients", { method: "PUT", body: 봉투들 }).then(function (r) {
              열쇠 = a[0];   // 이제부터 새 문구가 이 탭의 열쇠다
              return r;
            });
          });
        });
      });
    });
  }

  window.mgVaultUI = {
    대신올리기: 대신올리기,
    문구바꾸기: 문구바꾸기,
    열기: 열기,
    잠그기: 잠그기,
    올리기: 올리기,
    내려받기: 내려받기,
    비상키받기: 비상키받기,
    잠겼나: function () { return !열쇠; }
  };
})();
