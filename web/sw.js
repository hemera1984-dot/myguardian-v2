// 마이가디언 서비스 워커 — 앱 셸 캐시 (디자인 개정 10차, 스레드 인텔리전스 방식 계승)
// 전략: 화면 이동(navigate) = 네트워크 우선 + 캐시 폴백 (오프라인에서도 열림)
//       정적 자산(css/js/img/font) = 캐시 우선 + 백그라운드 갱신 없음(버전으로 교체)
//       데이터(JSON) = 네트워크 우선 + 캐시 폴백 (항상 최신, 끊기면 마지막 사본)
var CACHE_NAME = "myguardian-shell-v1";
var APP_SHELL = [
  "./",
  "index.html",
  "install.html",
  "manifest.webmanifest",
  "assets/platform.css",
  "assets/platform.js"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE_NAME) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return; // CDN 등 외부는 브라우저 기본 동작

  // 화면 이동·데이터: 네트워크 우선, 실패 시 캐시
  var isData = url.pathname.indexOf("/data/") !== -1 || url.pathname.slice(-5) === ".json";
  if (req.mode === "navigate" || isData) {
    e.respondWith(
      fetch(req).then(function (resp) {
        var copy = resp.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
        return resp;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match("index.html");
        });
      })
    );
    return;
  }

  // 정적 자산: 캐시 우선
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (resp) {
        var copy = resp.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
        return resp;
      });
    })
  );
});
