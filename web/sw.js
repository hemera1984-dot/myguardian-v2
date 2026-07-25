// 마이가디언 서비스 워커 — 앱 셸 캐시 (디자인 개정 10차, 스레드 인텔리전스 방식 계승)
// 전략(v4): 동일 출처 GET 전부 = 네트워크 우선 + 캐시 폴백.
//   온라인이면 항상 최신을 받고(배포 즉시 반영), 끊기면 마지막 정상 사본을 쓴다.
// v3까지 정적 자산(css/js)을 "캐시 우선"으로 두어, 배포해도 낡은 CSS·JS가 남아
//   화면이 안 바뀌던 문제(다음 로드까지 지연)를 없앤다. 오프라인 지원은 캐시 폴백으로 유지.
// cacheable() 게이트로 2xx·basic 응답만 저장한다(오류 응답이 정상 캐시를 덮지 않게).
var CACHE_NAME = "myguardian-shell-v4";
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

// 정상 응답(2xx·기본형)만 캐시한다 — 오류 응답이 정상 사본을 덮지 않게
function cacheable(resp) {
  return resp && resp.ok && resp.type === "basic";
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return; // CDN 등 외부는 브라우저 기본 동작

  // 동일 출처 GET 전부: 네트워크 우선, 오류(4xx/5xx)·오프라인 시 캐시 폴백.
  // 배포 즉시 최신을 받도록 캐시 우선을 쓰지 않는다. 정상 응답은 다음 오프라인을 위해 캐시.
  e.respondWith(
    fetch(req).then(function (resp) {
      if (cacheable(resp)) {
        var copy = resp.clone();
        e.waitUntil(caches.open(CACHE_NAME).then(function (cache) { return cache.put(req, copy); }));
        return resp;
      }
      // 비정상 HTTP 응답은 캐시하지 않고, 기존 정상 캐시가 있으면 그걸 반환
      return caches.match(req).then(function (hit) { return hit || resp; });
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error());
      });
    })
  );
});
