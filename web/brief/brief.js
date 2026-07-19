// 브리핑 공용 엔진 — 문서 로더 · 페이지 렌더러 · 동기화 프로토콜
//
// 계층 구조 (2차 공사에서 운반 계층만 교체한다):
//   운반 계층  createBroadcastTransport — 지금은 BroadcastChannel(한 기기 안 두 창).
//              2차에서 Cloudflare Workers WebSocket 운반체로 갈아끼운다.
//   규약 계층  createProtocol — 메시지 봉투 {v:1, type:...}를 만들고 해석한다.
//              운반체가 무엇이든 동일하게 동작한다.
//
// 메시지 규격 v1:
//   { v:1, type:"page",    page:3 }
//   { v:1, type:"pointer", x:0.42, y:0.61, on:true }   // 페이지 캔버스 기준 0~1 비율
//   { v:1, type:"video",   action:"play"|"pause"|"seek", time:12.5 }
//   { v:1, type:"hello" }                               // 청중 창이 현재 상태를 요청
//   { v:1, type:"state",   page:3, video:{playing:false, time:0} }
//   { v:1, type:"doc",     doc:{...} }                  // 로컬 문서 전달 (같은 기기 두 창 전용.
//                                                       // 2차 원격 운반체에서는 상담 문서 전송 금지)
(function () {
  "use strict";

  var CANVAS_W = 1280;
  var CANVAS_H = 800;

  // ---------- 문서 로더 ----------

  function assertDoc(doc) {
    if (!doc || typeof doc !== "object") throw new Error("문서 형식이 올바르지 않습니다.");
    if (!doc.id || !doc["제목"] || !Array.isArray(doc["페이지"]) || !doc["페이지"].length) {
      throw new Error("브리핑 문서가 아닙니다. (id·제목·페이지 필요)");
    }
    return doc;
  }

  // 공개 문서: data/brief/<id>.json (id 형식 검증으로 경로 이탈 차단)
  function loadDocById(id) {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) return Promise.reject(new Error("문서 ID 형식 오류"));
    return fetch("../../data/brief/" + id + ".json")
      .then(function (r) {
        if (!r.ok) throw new Error("문서를 찾을 수 없습니다: " + id);
        return r.json();
      })
      .then(assertDoc);
  }

  // 검증·개발용: 저장소 안 상대 경로 문서 (경로 이탈 차단)
  function loadDocBySrc(src) {
    if (/^([a-z]+:|\/\/)/i.test(src) || src.indexOf("..") !== -1 || src.charAt(0) === "/") {
      return Promise.reject(new Error("문서 경로 형식 오류"));
    }
    return fetch("../../" + src)
      .then(function (r) {
        if (!r.ok) throw new Error("문서를 찾을 수 없습니다: " + src);
        return r.json();
      })
      .then(assertDoc);
  }

  function parseDocText(text) {
    return assertDoc(JSON.parse(text));
  }

  // 문서 안 자산 경로(data/...) → 화면(web/brief/) 기준 URL
  function assetUrl(path) {
    if (!path || /^([a-z]+:|\/\/)/i.test(path) || path.indexOf("..") !== -1) return null;
    return "../../" + path.replace(/^\//, "");
  }

  // ---------- 페이지 렌더러 ----------
  // audience=true(청중 화면)에서는 스크립트를 절대 렌더링하지 않는다.
  // (스크립트는 렌더러 자체가 어느 모드에서도 그리지 않는다 — 발표자 화면의
  //  스크립트 패널이 문서에서 직접 읽는다. 청중 창으로는 DOM에 실릴 일이 없다.)

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function renderBody(blocks, root) {
    var list = null;
    (blocks || []).forEach(function (b) {
      if (!b || typeof b.x !== "string") return;
      if (b.t === "li") {
        if (!list) {
          list = el("ul", "pg-list");
          root.appendChild(list);
        }
        list.appendChild(el("li", null, b.x));
      } else {
        list = null;
        root.appendChild(el("p", "pg-para", b.x));
      }
    });
  }

  function renderPage(page, opts) {
    opts = opts || {};
    var type = page["유형"] || "본문";
    var root = el("article", "brief-page pg-" + ({ "표지": "cover", "본문": "text", "이미지": "image", "영상": "video" }[type] || "text"));

    var media = null;
    var imgSrc = assetUrl(page["이미지"]);
    var vidSrc = assetUrl(page["영상"]);

    if (type === "표지") {
      if (imgSrc) {
        media = el("div", "pg-cover-art");
        var img = el("img");
        img.src = imgSrc;
        img.alt = "";
        media.appendChild(img);
        root.appendChild(media);
      }
      var head = el("header", "pg-cover-head");
      if (page["킥커"]) head.appendChild(el("p", "pg-kicker", page["킥커"]));
      head.appendChild(el("h1", "pg-cover-title", page["제목"] || ""));
      if (page["부제"]) head.appendChild(el("p", "pg-cover-sub", page["부제"]));
      root.appendChild(head);
      return root;
    }

    var header = el("header", "pg-head");
    if (page["킥커"]) header.appendChild(el("p", "pg-kicker", page["킥커"]));
    if (page["제목"]) header.appendChild(el("h2", "pg-title", page["제목"]));
    if (page["부제"]) header.appendChild(el("p", "pg-sub", page["부제"]));
    root.appendChild(header);

    if (type === "이미지" && imgSrc) {
      media = el("figure", "pg-figure");
      var image = el("img");
      image.src = imgSrc;
      image.alt = page["제목"] || "";
      media.appendChild(image);
      if (page["캡션"]) media.appendChild(el("figcaption", "pg-caption", page["캡션"]));
      root.appendChild(media);
    }

    if (type === "영상" && vidSrc) {
      media = el("figure", "pg-figure pg-video-box");
      var video = el("video");
      video.src = vidSrc;
      video.preload = "auto";
      video.playsInline = true;
      if (opts.audience) {
        // 청중 창은 음소거 재생 (자동재생 허용 + 소리는 발표자 기기 담당)
        video.muted = true;
      } else {
        video.controls = true;
      }
      media.appendChild(video);
      if (page["캡션"]) media.appendChild(el("figcaption", "pg-caption", page["캡션"]));
      root.appendChild(media);
    }

    if (page["본문"] && page["본문"].length) {
      var body = el("div", "pg-body");
      renderBody(page["본문"], body);
      root.appendChild(body);
    }

    return root;
  }

  // 렌더 후 캔버스(1280×800)를 넘치면 조판 밀도를 단계적으로 높인다
  function fitPage(stageEl) {
    stageEl.removeAttribute("data-density");
    for (var level = 1; level <= 2; level += 1) {
      if (stageEl.scrollHeight <= stageEl.clientHeight + 1) return;
      stageEl.setAttribute("data-density", String(level));
    }
  }

  // 스테이지 캔버스를 감싸는 영역 크기에 맞춰 배율 조정
  function scaleStage(wrapEl, stageEl) {
    var w = wrapEl.clientWidth;
    var h = wrapEl.clientHeight;
    if (!w || !h) return;
    var s = Math.min(w / CANVAS_W, h / CANVAS_H);
    stageEl.style.transform = "scale(" + s + ")";
    stageEl.style.left = Math.max(0, (w - CANVAS_W * s) / 2) + "px";
    stageEl.style.top = Math.max(0, (h - CANVAS_H * s) / 2) + "px";
  }

  // ---------- 운반 계층 (1차: BroadcastChannel) ----------

  function createBroadcastTransport(channelName) {
    var channel = new BroadcastChannel(channelName);
    return {
      send: function (msg) { channel.postMessage(msg); },
      onMessage: function (fn) {
        channel.onmessage = function (e) { fn(e.data); };
      },
      close: function () { channel.close(); }
    };
  }

  // ---------- 규약 계층 ----------

  // 수신 검증 — 같은 origin의 다른 탭이 채널명만 맞춰 보낸 기형·위조 메시지를 폐기한다.
  // (Codex 검수 반영. 2차 원격 운반체에서도 이 검증층이 그대로 유효하다.)
  function isNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  var VALIDATORS = {
    page: function (m) { return isNum(m.page); },
    pointer: function (m) {
      if (m.on === false) return true;
      return m.on === true && isNum(m.x) && isNum(m.y)
        && m.x >= 0 && m.x <= 1 && m.y >= 0 && m.y <= 1;
    },
    video: function (m) {
      return (m.action === "play" || m.action === "pause" || m.action === "seek")
        && (m.time === undefined || isNum(m.time));
    },
    hello: function () { return true; },
    state: function (m) {
      if (!isNum(m.page)) return false;
      if (m.video == null) return true;
      return typeof m.video === "object" && (m.video.time === undefined || isNum(m.video.time));
    },
    doc: function (m) {
      try {
        assertDoc(m.doc);
        return true;
      } catch (err) {
        return false;
      }
    }
  };

  function createProtocol(transport, handlers) {
    handlers = handlers || {};
    transport.onMessage(function (msg) {
      if (!msg || msg.v !== 1 || typeof msg.type !== "string") return;
      var valid = VALIDATORS[msg.type];
      if (!valid || !valid(msg)) return;
      var fn = handlers[msg.type];
      if (fn) fn(msg);
    });
    return {
      sendPage: function (page) {
        transport.send({ v: 1, type: "page", page: page });
      },
      sendPointer: function (x, y, on) {
        transport.send({ v: 1, type: "pointer", x: x, y: y, on: on });
      },
      sendVideo: function (action, time) {
        transport.send({ v: 1, type: "video", action: action, time: time });
      },
      sendHello: function () {
        transport.send({ v: 1, type: "hello" });
      },
      sendState: function (page, video) {
        transport.send({ v: 1, type: "state", page: page, video: video });
      },
      sendDoc: function (doc) {
        transport.send({ v: 1, type: "doc", doc: doc });
      }
    };
  }

  function channelName(docId) {
    return "mg-brief-" + docId;
  }

  window.mgBrief = {
    CANVAS_W: CANVAS_W,
    CANVAS_H: CANVAS_H,
    loadDocById: loadDocById,
    loadDocBySrc: loadDocBySrc,
    parseDocText: parseDocText,
    validateDoc: assertDoc,
    renderPage: renderPage,
    fitPage: fitPage,
    scaleStage: scaleStage,
    createBroadcastTransport: createBroadcastTransport,
    createProtocol: createProtocol,
    channelName: channelName
  };
})();
