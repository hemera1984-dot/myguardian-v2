// 마이가디언 서비스 워커 — 앱 셸 캐시 (디자인 개정 10차, 스레드 인텔리전스 방식 계승)
// 전략: 화면 이동(navigate) = 네트워크 우선 + 캐시 폴백 (오프라인에서도 열림)
//       정적 자산(css/js/img) = 캐시 응답 + 백그라운드 갱신 (다음 로드에 최신 반영)
//       데이터(JSON) = 네트워크 우선 + 캐시 폴백 (항상 최신, 끊기면 마지막 사본)
// v2 → v3(Codex 3차 중요2): 오류 응답이 정상 캐시를 덮던 문제 + 백그라운드 갱신을
//   waitUntil로 보장. cacheable() 게이트로 2xx·basic 응답만 저장한다.
var CACHE_NAME = "myguardian-shell-v3";
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

  // 화면 이동·데이터: 네트워크 우선, 실패·오류(4xx/5xx) 시 캐시 폴백
  var isData = url.pathname.indexOf("/data/") !== -1 || url.pathname.slice(-5) === ".json";
  if (req.mode === "navigate" || isData) {
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
          return hit || caches.match("index.html");
        });
      })
    );
    return;
  }

  // 정적 자산: 캐시 응답 + 백그라운드 갱신 (stale-while-revalidate)
  // 캐시가 있으면 즉시 쓰되, 갱신 완료를 waitUntil로 보장해 다음 로드에 최신 반영
  e.respondWith(
    caches.match(req).then(function (hit) {
      var refresh = fetch(req).then(function (resp) {
        if (cacheable(resp)) {
          var copy = resp.clone();
          return caches.open(CACHE_NAME).then(function (cache) {
            return cache.put(req, copy);
          }).then(function () { return resp; });
        }
        return resp;
      }).catch(function () { return hit; });
      if (hit) e.waitUntil(refresh); // 캐시 반환 시에도 갱신은 끝까지 진행
      return hit || refresh;
    })
  );
});
