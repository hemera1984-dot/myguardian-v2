// 브리핑 공용 엔진 — 문서 로더 · 페이지 렌더러 · 동기화 프로토콜
//
// 계층 구조 (2차 공사에서 운반 계층만 교체한다):
//   운반 계층  createBroadcastTransport — 지금은 BroadcastChannel(한 기기 안 두 창).
//              2차에서 Cloudflare Workers WebSocket 운반체로 갈아끼운다.
//   규약 계층  createProtocol — 메시지 봉투 {v:1, type:...}를 만들고 해석한다.
//              운반체가 무엇이든 동일하게 동작한다.
//
// 메시지 규격 v1.1:
//   { v:1, type:"page",    page:3 }
//   { v:1, type:"pointer", x:0.42, y:0.61, on:true }   // 페이지 캔버스 기준 0~1 비율
//   { v:1, type:"video",   action:"play"|"pause"|"seek", time:12.5 }
//   { v:1, type:"scroll",  y:0.35 }                     // HTML 자료 스크롤 위치 (0~1 비율)
//   { v:1, type:"hello" }                               // 청중 창이 현재 상태를 요청
//   { v:1, type:"state",   page:3, video:{playing:false, time:0}, scroll:0.35 }
// v1의 doc 메시지(로컬 문서 방송)는 폐기 — 로컬 자료는 IndexedDB를 통해 두 창이
// 같은 기기 안에서 직접 읽는다. 문서 내용이 채널에 실리지 않아 2차 원격에서도 안전.
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
      if (m.scroll !== undefined && !(isNum(m.scroll) && m.scroll >= 0 && m.scroll <= 1)) return false;
      if (m.video == null) return true;
      return typeof m.video === "object" && (m.video.time === undefined || isNum(m.video.time));
    },
    scroll: function (m) { return isNum(m.y) && m.y >= 0 && m.y <= 1; },
    // 장 넘김 키 그대로 전달 — 자료가 장 목록을 자기 안에 감추고 있어(하이퍼프레임)
    // 몇 쪽인지 셀 수 없을 때 쓴다. 두 화면이 같은 장에서 시작해 같은 키를 받는다.
    "키": function (m) { return 넘김키.indexOf(m.key) >= 0; },
    // 자료가 알려 준 절대 위치. 어긋나도 다음 신호에 제자리로 온다.
    "자리": function (m) {
      var p = m.pos;
      return !!p && typeof p.sequenceId === "string"
        && isNum(p.slideIndex) && isNum(p.fragmentIndex)
        && p.slideIndex >= 0 && p.slideIndex <= 5000;
    }
  };

  // 넘길 때 쓰는 키만 받는다 — 아무 키나 청중 화면에 밀어 넣지 않는다.
  var 넘김키 = ["ArrowRight", "ArrowLeft", "PageDown", "PageUp", " ", "Home", "End"];

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
      sendState: function (page, video, scroll) {
        var msg = { v: 1, type: "state", page: page, video: video };
        if (typeof scroll === "number") msg.scroll = scroll;
        transport.send(msg);
      },
      sendScroll: function (y) {
        transport.send({ v: 1, type: "scroll", y: y });
      },
      send넘김: function (key) {
        transport.send({ v: 1, type: "키", key: key });
      },
      send자리: function (pos) {
        transport.send({ v: 1, type: "자리", pos: pos });
      }
    };
  }

  function channelName(docId) {
    return "mg-brief-" + docId;
  }

  // ---------- 슬라이드 문서에 덧붙이는 다리 ----------
  // iframe의 출처를 끊었으므로(allow-scripts만) 상위 창은 그 문서의 DOM에 닿을 수 없다.
  // 대신 이 조각을 문서 끝에 붙여 postMessage로만 대화한다. 문서의 원래 코드는 건드리지 않는다.
  // 장 맞추기는 여기서 한다 — 자기 DOM을 바로 볼 수 있어 도달 여부를 확인하고 멈출 수 있다.
  var BRIDGE = "\n<script>(function(){\n"
    + "if(window.__mgBridge)return; window.__mgBridge=1;\n"
    + "function all(){return document.querySelectorAll('.slide');}\n"
    + "function idx(){var s=all();for(var i=0;i<s.length;i++)if(s[i].classList.contains('active'))return i;return -1;}\n"
    + "function ratio(){var e=document.scrollingElement||document.documentElement;"
    + "var r=e.scrollHeight-e.clientHeight;return r>0?Math.min(1,Math.max(0,e.scrollTop/r)):0;}\n"
    + "function tell(){try{parent.postMessage({mgb:'state',slide:idx(),count:all().length,scroll:ratio()},'*');}catch(e){}}\n"
    + "function key(k){document.body.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true}));}\n"
    // 목표 장까지 한 걸음씩 간다. 움직이지 않으면 그 문서가 화살표를 안 받는 것이므로 멈추고 알린다.
    + "function goTo(n){var tries=0;(function step(){var cur=idx();"
    + "if(cur<0||cur===n||tries++>5000){tell();return;}"
    + "key(n>cur?'ArrowRight':'ArrowLeft');"
    + "if(idx()===cur){tell();return;}setTimeout(step,0);})();}\n"
    + "window.addEventListener('message',function(e){var d=e.data;if(!d||d.mgb!=='cmd')return;"
    + "if(d.key){key(d.key);tell();}"
    + "if(typeof d.goto==='number')goTo(d.goto);"
    + "if(typeof d.scroll==='number'){var el=document.scrollingElement||document.documentElement;"
    + "window.scrollTo(0,d.scroll*Math.max(0,el.scrollHeight-el.clientHeight));}"
    + "if(d.청중)청중();"
    + "if(d.크기)흔들기();"
    + "if(d.자리){if(컨)자리맞추기(d.자리);else 대기자리=d.자리;}"
    + "if(d.ask)tell();});\n"
    // 자기 조종기를 내주는 자료(하이퍼프레임)는 자리로 맞춘다 — 키를 훔쳐 듣는 것보다 확실하다.
    // 마우스로 넘기든 키로 넘기든 조종기가 알려 주고, 어긋나도 다음 신호에 제자리로 온다.
    // 조종기는 자료가 다 서야 생기므로 계속 살핀다.
    + "var 컨=null,대기자리=null;\n"
    + "function 자리보고(){try{var p=컨.position;"
    + "parent.postMessage({mgb:'자리',pos:{sequenceId:p.sequenceId,slideIndex:p.slideIndex,fragmentIndex:p.fragmentIndex}},'*');}catch(x){}}\n"
    + "function 자리맞추기(p){try{컨.syncTo(p.sequenceId,p.slideIndex,p.fragmentIndex);}catch(x){}}\n"
    + "function 붙잡기(){if(컨)return;"
    + "var e=document.querySelector('hyperframes-slideshow');var c=e&&e.controller;if(!c)return;컨=c;"
    + "try{parent.postMessage({mgb:'자리있음'},'*');}catch(x){}"
    + "try{c.onChange(function(){자리보고();});}catch(x){}"
    // 되풀이해서 알린다 — 청중 창이 늦게 열려도, 어쩌다 어긋나도 제자리로 온다.
    + "setInterval(자리보고,1500);"
    + "if(대기자리){자리맞추기(대기자리);대기자리=null;}else{자리보고();}}\n"
    + "붙잡기();setInterval(붙잡기,800);\n"
    // 자료가 자기 화면에 띄우는 조작 안내(「F 전체화면 · ← 뒤로」)는 발표자 몫이다.
    // 청중 창에서는 감춘다 — 빔프로젝터에 단축키 안내가 걸려 있을 이유가 없다.
    // 자료마다 #bar 또는 #hint를 쓴다. 앞으로 만드는 자료는 data-발표자용을 붙이면 된다.
    + "function 청중(){if(document.getElementById('mg-audience'))return;"
    + "var s=document.createElement('style');s.id='mg-audience';"
    + "s.textContent='#bar,#hint,[data-발표자용]{display:none !important}';"
    + "(document.head||document.documentElement).appendChild(s);}\n"
    // 전체화면(F)은 여기서 직접 처리한다. 위로 올려보내면 상위 창의 처리기는 사용자
    // 조작으로 인정받지 못해 requestFullscreen이 거부된다 — 진짜 키를 받은 이 문서만 할 수 있다.
    + "window.addEventListener('keydown',function(e){"
    + "if(e.key!=='f'&&e.key!=='F')return;e.preventDefault();"
    + "try{if(document.fullscreenElement)document.exitFullscreen();"
    + "else document.documentElement.requestFullscreen();}catch(x){}"
    + "try{parent.postMessage({mgb:'key',key:'f'},'*');}catch(x){}});\n"
    // 장 넘김 키는 청중 화면도 같이 받아야 한다. 자료가 장 목록을 자기 안에 감추면
    // 몇 쪽인지 셀 수 없어(장 -1/0) 쪽 번호로는 못 맞춘다 — 키를 그대로 흘려보낸다.
    // preventDefault를 하지 않는다: 이 문서도 제 할 일(넘기기)을 계속해야 한다.
    + "function 넘김보고(k){if(컨)return;"
    + "if(['ArrowRight','ArrowLeft','PageDown','PageUp',' ','Home','End'].indexOf(k)<0)return;"
    + "try{parent.postMessage({mgb:'넘김',key:k},'*');}catch(x){}}\n"
    // 잡는 단계(capture)에서 듣는다. 자료가 자기 처리기에서 전파를 끊으면 거품 단계까지
    // 오지 않는다 — 발표자가 슬라이드를 클릭한 뒤 누른 키를 놓치던 이유다(2026-09-09).
    + "window.addEventListener('keydown',function(e){넘김보고(e.key);},true);\n"
    // 자료가 자기 안에 또 틀을 세우면(하이퍼프레임의 플레이어) 그 안에서 누른 키는
    // 바깥 문서까지 올라오지 않는다. 같은 출처이므로 그 안쪽 창에도 귀를 붙인다.
    // 틀이 늦게 서므로 몇 번에 나눠 붙인다(같은 창에 두 번 붙지 않게 표시를 남긴다).
    + "function 안쪽귀(doc,깊이){if(!doc||깊이>3)return;"
    + "var fs=doc.querySelectorAll('iframe');"
    + "for(var i=0;i<fs.length;i++){try{var w=fs[i].contentWindow;if(!w)continue;"
    + "if(!w.__mg귀){w.__mg귀=1;"
    + "w.addEventListener('keydown',function(e){넘김보고(e.key);},true);}"
    + "안쪽귀(w.document,깊이+1);}catch(x){}}}\n"
    // 틀이 언제 서고 언제 다시 서는지 알 수 없다 — 계속 살핀다. 붙은 창은 표시로 거른다.
    + "안쪽귀(document,0);setInterval(function(){안쪽귀(document,0);},2000);\n"
    // 문서 안에서 누른 키 중 발표자 화면 몫(스크립트 스크롤·글자 크기)은 위로 올려보낸다
    + "window.addEventListener('keydown',function(e){"
    + "if(['ArrowUp','ArrowDown','+','=','-','_'].indexOf(e.key)<0)return;"
    + "e.preventDefault();try{parent.postMessage({mgb:'key',key:e.key},'*');}catch(x){}});\n"
    // 자료가 안 보이는 상태(숨긴 칸·크기 0)에서 실리면 스스로 크기를 0으로 재고 끝낸다.
    // 하이퍼프레임 자료가 그렇다 — 나중에 칸이 보여도 다시 재지 않아 화면 밖으로 튀거나
    // 검게 남는다(2026-09-09 재현). 그래서 몇 번 흔들어 다시 재게 한다.
    + "function 흔들기(){try{window.dispatchEvent(new Event('resize'));}catch(e){}}\n"
    + "[300,900,2000,4000,8000,15000].forEach(function(ms){setTimeout(흔들기,ms);});\n"
    + "window.addEventListener('scroll',tell,{passive:true});\n"
    + "setInterval(tell,400);tell();\n"
    + "})();<\/script>";

  // ---------- 자료를 다른 출처에 담기 ----------
  // 서버가 내주는 빈 틀(/brief/frame)을 띄우고, 자료 본문을 postMessage로 넣는다.
  // 틀은 api 출처라 앱의 토큰·저장소에 닿지 못하고, 자료는 제 출처를 가져 안쪽 iframe도 연다.
  // 자료가 서버로 올라가는 것이 아니다 — 틀은 빈 껍데기고 본문은 이 브라우저 안에서만 오간다.
  function 틀에담기(frame, 본문, stageEl) {
    // 발표·청중 화면(present.html·view.html)은 auth.js를 싣지 않는다 — 로그인 없이
    // IndexedDB의 자료만 열기 때문이다. 그래서 mgAuth가 없고, 여기서 서버 주소를
    // 못 찾아 옛 방식으로 떨어졌다(2026-09-09 콘솔로 확인). 규칙은 auth.js와 같다.
    var 서버 = window.mgAuth ? window.mgAuth.apiBase()
      : (location.hostname === "localhost" || location.hostname === "127.0.0.1")
        ? "http://localhost:8787" : "https://api.insurguard.life";
    return new Promise(function (resolve) {
      var 끝났다 = false;
      // 틀을 못 쓰는 경우(로그인 전·망 끊김·서버 정지) 종전 방식으로 연다. 이 길에서는
      // 출처가 없어 자기 안에 iframe을 세우는 자료가 검게 뜨지만, 보통 HTML 자료는 열린다.
      function 예전방식(왜) {
        if (끝났다) return;
        끝났다 = true;
        window.removeEventListener("message", 받기);
        console.warn("자료를 예전 방식으로 엽니다 — " + 왜);
        frame.setAttribute("sandbox", "allow-scripts");
        frame.onload = function () { resolve(frame); };
        frame.src = URL.createObjectURL(new Blob([본문], { type: "text/html" }));
      }
      function 받기(e) {
        if (끝났다 || e.source !== frame.contentWindow) return;
        if (!e.data || e.data["틀"] !== "준비") return;
        끝났다 = true;
        window.removeEventListener("message", 받기);
        e.source.postMessage({ "틀": "자료", html: 본문 }, e.origin);
        resolve(frame);
      }
      window.addEventListener("message", 받기);
      stageEl.appendChild(frame);
      if (!서버) return 예전방식("서버 주소를 모릅니다");
      frame.src = 서버 + "/brief/frame";
      setTimeout(function () { 예전방식("틀이 뜨지 않습니다"); }, 6000);
    });
  }

  // ---------- HTML 슬라이드 상태 ----------
  // 다리가 보내오는 상태를 프레임별로 보관한다. 상위 창은 그 문서의 DOM을 볼 수 없다.
  var frameState = new WeakMap();

  // 프레임 안 문서는 우리가 만든 것이 아니다 — 형식과 범위를 가려서 받는다.
  var KEYS_UP = ["ArrowUp", "ArrowDown", "+", "=", "-", "_"];
  function num(v) { return typeof v === "number" && isFinite(v); }

  function bridgeListen(win, onState) {
    function handler(e) {
      if (e.source !== win) return;                 // 다른 프레임의 말은 받지 않는다
      var d = e.data;
      if (!d || typeof d !== "object") return;
      if (d.mgb === "state") {
        if (!num(d.slide) || !num(d.count) || !num(d.scroll)) return;
        if (d.slide < -1 || d.count < 0 || d.count > 5000) return;
        if (d.scroll < 0 || d.scroll > 1) return;
        frameState.set(win, {
          slide: Math.round(d.slide), count: Math.round(d.count), scroll: d.scroll
        });
        if (onState) onState({ mgb: "state", slide: Math.round(d.slide), count: Math.round(d.count), scroll: d.scroll });
        return;
      }
      if (d.mgb === "key") {
        // 올려보낼 수 있는 키는 스크립트 조작용뿐이다. 장 넘김 키는 받지 않는다.
        if (KEYS_UP.indexOf(d.key) < 0) return;
        if (onState) onState({ mgb: "key", key: d.key });
        return;
      }
      // 장 넘김은 발표자 화면이 청중 화면에 방송해야 한다 — 자료가 쪽 수를 감추면
      // 이것 말고는 두 화면을 맞출 길이 없다(2026-09-09). 넘김용 키만 통과시킨다.
      if (d.mgb === "넘김") {
        if (넘김키.indexOf(d.key) < 0) return;
        if (onState) onState({ mgb: "넘김", key: d.key });
        return;
      }
      // 자기 조종기를 내주는 자료는 자리로 맞춘다 — 마우스로 넘겨도 잡힌다.
      if (d.mgb === "자리있음") {
        if (onState) onState({ mgb: "자리있음" });
        return;
      }
      if (d.mgb === "자리") {
        var p = d.pos;
        if (!p || typeof p.sequenceId !== "string" || !num(p.slideIndex) || !num(p.fragmentIndex)) return;
        if (p.slideIndex < 0 || p.slideIndex > 5000) return;
        if (onState) onState({ mgb: "자리", pos: { sequenceId: p.sequenceId, slideIndex: p.slideIndex, fragmentIndex: p.fragmentIndex } });
      }
    }
    window.addEventListener("message", handler);
    return function () { window.removeEventListener("message", handler); };
  }

  function htmlSlideIndex(win) {
    var st = win && frameState.get(win);
    return st && typeof st.slide === "number" ? st.slide : -1;
  }

  function htmlScrollRatio(win) {
    var st = win && frameState.get(win);
    return st && typeof st.scroll === "number" ? st.scroll : undefined;
  }

  function htmlSlideGoTo(win, target) {
    if (!win || typeof target !== "number") return;
    try { win.postMessage({ mgb: "cmd", goto: target }, "*"); } catch (e) { /* 닫힌 창 */ }
  }

  // 자료에 절대 위치를 넣는다 — 자기 조종기를 내주는 자료(하이퍼프레임)에만 먹는다.
  function html자리(win, pos) {
    if (!win) return;
    try { win.postMessage({ mgb: "cmd", "자리": pos }, "*"); } catch (e) { /* 닫힌 창 */ }
  }

  function htmlSendKey(win, key) {
    if (!win) return;
    try { win.postMessage({ mgb: "cmd", key: key }, "*"); } catch (e) { /* 닫힌 창 */ }
  }

  function htmlSetScroll(win, y) {
    if (!win) return;
    try { win.postMessage({ mgb: "cmd", scroll: y }, "*"); } catch (e) { /* 닫힌 창 */ }
  }

  // 청중 창에서만 부른다 — 자료가 자기 화면에 띄우는 단축키 안내를 감춘다.
  // 자료가 늦게 그리는 경우가 있어 몇 번 되풀이한다(다리 쪽은 한 번만 먹는다).
  function htmlAudience(win) {
    if (!win) return;
    // 자료가 큰 경우 다리가 서는 데 십수 초가 걸린다(50MB 자료 실측 15초).
    // 1.2초에서 끊으면 청중 화면에 단축키 안내가 그대로 남는다(2026-09-09).
    [0, 300, 1200, 3000, 6000, 10000, 15000, 22000].forEach(function (ms) {
      setTimeout(function () {
        try { win.postMessage({ mgb: "cmd", 청중: true }, "*"); } catch (e) { /* 닫힌 창 */ }
      }, ms);
    });
  }


  // ---------- 로컬 자료 저장 (IndexedDB) ----------
  // 업로드한 발표 자료(JSON·PDF·HTML·이미지)와 스크립트는 이 브라우저의 IndexedDB에만
  // 저장된다. 외부 전송 없음. 슬롯은 하나 — 새 자료를 열면 이전 자료를 대체한다.
  // 발표자·청중 두 창이 같은 기기에서 이 슬롯을 직접 읽는다 (채널로 내용을 보내지 않는다).

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = window.indexedDB.open("mg-brief", 2);
      req.onupgradeneeded = function () {
        var db = req.result;
        // materials: 발표 중인 자료 단일 슬롯("current"). library: 탑재한 자료 목차(record.id 키).
        if (!db.objectStoreNames.contains("materials")) db.createObjectStore("materials");
        if (!db.objectStoreNames.contains("library")) db.createObjectStore("library", { keyPath: "id" });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function saveMaterial(record) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction("materials", "readwrite");
        tx.objectStore("materials").put(record, "current");
        tx.oncomplete = function () { db.close(); resolve(); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      });
    });
  }

  function loadMaterial() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction("materials", "readonly");
        var req = tx.objectStore("materials").get("current");
        req.onsuccess = function () { db.close(); resolve(req.result || null); };
        req.onerror = function () { db.close(); reject(req.error); };
      });
    });
  }

  // ---------- 팀 공유 라이브러리 (서버) ----------
  // 강의 자료는 팀이 함께 쓴다 — 올린 사람만 보이면 플랫폼이 아니다(2026-08-05).
  // 파일을 서버에 올리고 주소만 목차에 싣는다. 서버가 죽어 있으면 아래 로컬 목록으로 버틴다.
  // 올린 크기가 원본과 다르면 파일이 아니라 다른 것이 올라간 것이다(옛 auth.js 캐시가
  // File을 JSON으로 감싸 2바이트짜리 "{}"를 올린 적이 있다). 조용히 넘기면 팀원이
  // 빈 자료를 받으므로 여기서 멈춘다.
  function serverUpload(file) {
    return window.mgAuth.api("/brief/file", {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file
    }).then(function (up) {
      if (!up || up["크기"] !== file.size) {
        throw new Error("파일이 온전히 올라가지 않았습니다(" + (up && up["크기"]) + "/" + file.size
          + "바이트). 새로고침(Ctrl+Shift+R) 후 다시 시도하세요.");
      }
      return up;
    });
  }

  // 실패를 빈 목록으로 바꾸면 "탑재한 자료 없음"으로 보여 장애를 알 수 없다.
  // 로그인 전이면 빈 목록이 맞고, 그 밖의 실패는 그대로 알린다.
  function serverLibraryList() {
    if (!window.mgAuth || !window.mgAuth.token()) return Promise.resolve([]);
    return window.mgAuth.api("/brief/library")
      .then(function (d) { return Array.isArray(d) ? d : []; });
  }

  // 자료 형식마다 올릴 것이 다르다. html·pdf는 파일 하나, doc은 JSON 본문,
  // images는 여러 장이다. 종전에는 record.file만 보고 올려 doc·images에서 바로 터졌다.
  function 올릴것(record) {
    if (record.kind === "doc") {
      var text = JSON.stringify(record.doc);
      return [new File([text], (record["이름"] || "brief") + ".json", { type: "application/json" })];
    }
    if (record.kind === "images") return (record.files || []).slice();
    return record.file ? [record.file] : [];
  }

  // 슬라이드·스크립트를 올린 뒤 주소만 담은 항목을 목차에 싣는다
  function serverLibraryPut(record) {
    var files = 올릴것(record);
    if (!files.length) {
      return Promise.reject(new Error("올릴 파일이 없는 자료입니다."));
    }
    var jobs = files.map(serverUpload);
    var script = record["스크립트문서"] || null;
    jobs.push(script ? serverUpload(script) : Promise.resolve(null));
    return Promise.all(jobs).then(function (up) {
      var 스크립트 = up[up.length - 1];
      var 본체 = up.slice(0, up.length - 1);
      var 항목 = {
        id: record.id,
        "제목": record["제목"] || record["이름"],
        "이름": record["이름"],
        "모드": record["모드"] || "강의",
        kind: record.kind,
        "쪽주소": 본체.map(function (u) { return u["주소"]; }),  // images는 여러 장이다
        "슬라이드주소": 본체[0]["주소"],
        "슬라이드이름": record["이름"],
        "크기": 본체.reduce(function (n, u) { return n + (u["크기"] || 0); }, 0)
      };
      // 마지막 칸이 스크립트다. up[1]로 잡으면 이미지가 여러 장일 때 둘째 장이 스크립트가 된다.
      if (스크립트) {
        항목["스크립트주소"] = 스크립트["주소"];
        항목["스크립트이름"] = script.name;
      } else if (record["스크립트"]) {
        항목["스크립트"] = record["스크립트"]; // 텍스트 구간은 그대로 싣는다(파일이 아니다)
      }
      return window.mgAuth.api("/brief/library", { method: "POST", body: 항목 })
        .then(function () { return 항목; });
    });
  }

  function serverLibraryDelete(id) {
    return window.mgAuth.api("/brief/library/" + encodeURIComponent(id), { method: "DELETE" });
  }

  // 서버 목차 항목을 발표 가능한 레코드로 되돌린다 — 파일을 내려받아 File로 만든다
  function serverRecordToMaterial(item) {
    // 다른 기기에서 실패할 때 어느 단계인지 바로 알 수 있게 단계를 문구에 남긴다
    function grab(url, name, type) {
      var addr = fileUrl(url);
      return fetch(addr, { headers: authHeader() })
        .catch(function (e) {
          throw new Error("[내려받기 연결 실패] " + addr + " — " + (e && e.message ? e.message : e)
            + " (로그인이 풀렸거나 회사망이 막고 있을 수 있습니다)");
        })
        .then(function (r) {
          if (!r.ok) {
            throw new Error("[내려받기 거부 " + r.status + "] "
              + (r.status === 401 ? "로그인이 필요합니다."
                : r.status === 403 ? "계정이 아직 승인되지 않았습니다."
                : r.status === 404 ? "서버에 파일이 없습니다." : addr));
          }
          return r.blob();
        })
        .then(function (b) { return new File([b], name, { type: type || b.type }); });
    }
    // 형식마다 되돌리는 모양이 다르다 — 올릴 때와 짝을 맞춘다
    var kind = item.kind || "html";
    var 주소들 = Array.isArray(item["쪽주소"]) && item["쪽주소"].length
      ? item["쪽주소"] : [item["슬라이드주소"]];

    var 본체 = kind === "images"
      ? Promise.all(주소들.map(function (u, n) { return grab(u, "page-" + (n + 1) + ".png"); }))
      : grab(주소들[0], item["슬라이드이름"] || item["이름"] || "slide").then(function (f) { return [f]; });

    return 본체.then(function (files) {
      var rec = { kind: kind, id: item.id, "이름": item["이름"] || files[0].name,
                  "제목": item["제목"], "모드": item["모드"] || "강의" };
      if (kind === "images") rec.files = files;
      else if (kind === "doc") {
        // 브리핑 문서는 JSON으로 올렸다 — 다시 객체로 푼다
        return files[0].text().then(function (t) {
          rec.doc = JSON.parse(t);
          return rec;
        });
      } else rec.file = files[0];
      return rec;
    }).then(function (rec) {
      if (item["스크립트"]) rec["스크립트"] = item["스크립트"];
      if (!item["스크립트주소"]) return rec;
      return grab(item["스크립트주소"], item["스크립트이름"] || "script.pdf")
        .then(function (s) { rec["스크립트문서"] = s; return rec; });
    });
  }

  // 자료 파일은 /brief/file/<파일명>으로 받는다. /media/를 그대로 fetch하면 웹서버가
  // 서빙하는 다른 출처라 CORS에 막힌다(이미지는 <img>라서 걸리지 않았다).
  // 이 경로는 서버가 CORS를 붙이고 승인 계정만 받아 간다.
  function fileUrl(url) {
    var name = String(url || "").split("/").pop().split(/[?#]/)[0];
    var base = window.mgAuth ? window.mgAuth.apiBase() : "";
    return base + "/brief/file/" + encodeURIComponent(name);
  }

  function authHeader() {
    var t = window.mgAuth && window.mgAuth.token();
    return t ? { Authorization: "Bearer " + t } : {};
  }

  // ---------- 라이브러리 (IndexedDB "library" 스토어) ----------
  // 탑재한 발표 자료를 record.id 키로 여러 개 보관한다. 목차로 훑고 골라서 발표한다.
  // 저장소(git)에는 올라가지 않고 이 브라우저에만 남는다 — 개인정보·상담 자료 보호.

  function libraryPut(record) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction("library", "readwrite");
        tx.objectStore("library").put(record);
        tx.oncomplete = function () { db.close(); resolve(); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      });
    });
  }

  function libraryList() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction("library", "readonly");
        var req = tx.objectStore("library").getAll();
        req.onsuccess = function () { db.close(); resolve(req.result || []); };
        req.onerror = function () { db.close(); reject(req.error); };
      });
    });
  }

  function libraryDelete(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction("library", "readwrite");
        tx.objectStore("library").delete(id);
        tx.oncomplete = function () { db.close(); resolve(); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      });
    });
  }

  // 스크립트 파일(.txt/.md): 줄 단독 "---"로 페이지 구간을 나눈다. 순서대로 1,2,3…페이지
  function parseScriptText(text) {
    return String(text)
      .split(/\r?\n\s*-{3,}\s*(?:\r?\n|$)/)
      .map(function (s) { return s.trim(); });
  }

  // 스크립트 파일(HTML): <hr> 요소 또는 줄 단독 "---"가 구간 구분. 블록 요소는 줄바꿈으로
  function parseScriptHtml(html) {
    var parsed = new DOMParser().parseFromString(String(html), "text/html");
    var out = [];
    var BLOCK = /^(P|DIV|LI|UL|OL|SECTION|ARTICLE|H[1-6]|BR|TR|TABLE|BLOCKQUOTE)$/;
    (function walk(node) {
      node.childNodes.forEach(function (child) {
        if (child.nodeType === 3) {
          out.push(child.nodeValue);
          return;
        }
        if (child.nodeType !== 1) return;
        if (child.tagName === "HR") {
          out.push("\n---\n");
          return;
        }
        if (child.tagName === "SCRIPT" || child.tagName === "STYLE") return;
        walk(child);
        if (BLOCK.test(child.tagName)) out.push("\n");
      });
    })(parsed.body);
    return parseScriptText(out.join(""));
  }

  // 로컬 자료 채널 ID (파일명·크기 기반 — 문서 ID 형식 규칙을 따른다)
  // 라이브러리 키. 발표 자료 이름은 대부분 한글인데 [^a-z0-9]로 걸러 내면 한글이 통째로
  // 지워져 숫자·확장자만 남는다. 그러면 "평일1회차_슬라이드.html"과 "상속세전쟁사_평일1회.html"이
  // 똑같이 local-1-html-96201이 되고, put()이 앞의 자료를 조용히 덮어써 사라진다.
  // 한글을 슬러그에 남긴다.
  function localId(name, size) {
    var slug = String(name).toLowerCase()
      .replace(/[^a-z0-9가-힣ㄱ-ㅎㅏ-ㅣ]+/g, "-")
      .replace(/^-+|-+$/g, "").slice(0, 40);
    return "local-" + (slug || "file") + "-" + String((size || 0) % 100000);
  }

  // ---------- 자료 드라이버 ----------
  // 형식(doc·pdf·images·html)마다 페이지 수·렌더·스크립트 조회를 같은 인터페이스로 제공.
  // mount(stageEl, n)은 Promise를 돌려주며, html은 로드된 iframe을 resolve한다.

  function createDriver(record, opts) {
    opts = opts || {};
    var sidecar = record["스크립트"] || null;
    function scriptAt(n, fallback) {
      if (sidecar && sidecar[n - 1]) return sidecar[n - 1];
      return fallback || null;
    }

    if (record.kind === "doc") {
      var doc = record.doc;
      try { assertDoc(doc); } catch (err) { return Promise.reject(err); }
      return Promise.resolve({
        kind: "doc",
        title: doc["제목"],
        mode: doc["모드"] || record["모드"] || null,
        count: doc["페이지"].length,
        mount: function (stageEl, n) {
          stageEl.textContent = "";
          stageEl.appendChild(renderPage(doc["페이지"][n - 1], { audience: !!opts.audience }));
          fitPage(stageEl);
          return Promise.resolve(null);
        },
        scriptFor: function (n) {
          return scriptAt(n, (doc["페이지"][n - 1] || {})["스크립트"]);
        }
      });
    }

    if (record.kind === "pdf") {
      if (!window.pdfjsLib) return Promise.reject(new Error("PDF 렌더러를 불러오지 못했습니다."));
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "../assets/vendor/pdfjs/pdf.worker.min.js";
      return record.file.arrayBuffer().then(function (buf) {
        return window.pdfjsLib.getDocument({ data: buf }).promise;
      }).then(function (pdf) {
        return {
          kind: "pdf",
          title: record["이름"],
          mode: record["모드"] || null,
          count: pdf.numPages,
          mount: function (stageEl, n) {
            return pdf.getPage(n).then(function (page) {
              var raw = page.getViewport({ scale: 1 });
              var scale = Math.min(CANVAS_W / raw.width, CANVAS_H / raw.height);
              var viewport = page.getViewport({ scale: scale * 2 }); // 2배 렌더 — 확대 선명도
              var canvas = document.createElement("canvas");
              canvas.width = viewport.width;
              canvas.height = viewport.height;
              canvas.style.width = Math.floor(viewport.width / 2) + "px";
              canvas.style.height = Math.floor(viewport.height / 2) + "px";
              var task = page.render({ canvasContext: canvas.getContext("2d"), viewport: viewport });
              return task.promise.then(function () {
                stageEl.textContent = "";
                var box = el("div", "pg-media-center");
                box.appendChild(canvas);
                stageEl.appendChild(box);
                return null;
              });
            });
          },
          scriptFor: function (n) { return scriptAt(n); }
        };
      });
    }

    if (record.kind === "images") {
      var urls = (record.files || []).map(function (f) { return URL.createObjectURL(f); });
      if (!urls.length) return Promise.reject(new Error("이미지가 없습니다."));
      return Promise.resolve({
        kind: "images",
        title: record["이름"],
        mode: record["모드"] || null,
        count: urls.length,
        mount: function (stageEl, n) {
          stageEl.textContent = "";
          var box = el("div", "pg-media-center");
          var img = el("img", "pg-full-img");
          img.src = urls[n - 1];
          img.alt = "";
          box.appendChild(img);
          stageEl.appendChild(box);
          return Promise.resolve(null);
        },
        scriptFor: function (n) { return scriptAt(n); }
      });
    }

    if (record.kind === "html") {
      // 슬라이드 문서를 앱과 같은 출처로 실행하면 그 문서의 스크립트가 parent.mgAuth.token()과
      // localStorage에 닿는다. 라이브러리는 팀이 함께 쓰므로 남이 올린 HTML을 내가 여는
      // 구조고, 그러면 세션 탈취가 성립한다(2026-08-11 교정).
      // 그렇다고 출처를 통째로 끊으면(allow-scripts만) 자기 안에 다시 iframe을 세우는 자료가
      // 검은 화면으로 뜬다(2026-09-09 10회차 하이퍼프레임). 둘 다 피하는 길은 하나뿐이다 —
      // 앱이 아닌 다른 출처에서 띄운다. 자료는 서버의 빈 틀(/brief/frame)에 담아 돌리고,
      // 그 틀은 api 출처라 앱의 저장소에 닿지 못한다. 대화는 아래 다리로만 오간다.
      return record.file.text().then(function (html) {
        var 본문 = html + BRIDGE;
        return {
          kind: "html",
          title: record["이름"],
          mode: record["모드"] || null,
          count: 1,
          scrollable: true,
          mount: function (stageEl) {
            stageEl.textContent = "";
            var frame = document.createElement("iframe");
            frame.className = "pg-html-frame";
            // allow-same-origin은 "제 출처를 지킨다"는 뜻이지 앱과 같아진다는 뜻이 아니다.
            // 이 틀의 출처는 api라 앱의 토큰·저장소에는 닿지 않는다.
            frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
            // 전체화면 권한은 기본이 self라 다른 출처의 iframe에는 안 내려간다.
            // 이 줄이 없으면 슬라이드 문서 안에서 F를 눌러도 전체화면이 막힌다(2026-08-17).
            frame.setAttribute("allow", "fullscreen");
            return 틀에담기(frame, 본문, stageEl);
          },
          scriptFor: function () { return scriptAt(1); }
        };
      });
    }

    return Promise.reject(new Error("지원하지 않는 자료 형식입니다."));
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
    channelName: channelName,
    htmlSlideIndex: htmlSlideIndex,
    htmlSlideGoTo: htmlSlideGoTo,
    htmlScrollRatio: htmlScrollRatio,
    htmlSendKey: htmlSendKey,
    html자리: html자리,
    htmlSetScroll: htmlSetScroll,
    htmlAudience: htmlAudience,
    bridgeListen: bridgeListen,
    saveMaterial: saveMaterial,
    serverLibraryList: serverLibraryList,
    serverLibraryPut: serverLibraryPut,
    serverLibraryDelete: serverLibraryDelete,
    serverRecordToMaterial: serverRecordToMaterial,
    loadMaterial: loadMaterial,
    libraryPut: libraryPut,
    libraryList: libraryList,
    libraryDelete: libraryDelete,
    parseScriptText: parseScriptText,
    parseScriptHtml: parseScriptHtml,
    localId: localId,
    createDriver: createDriver
  };
})();
