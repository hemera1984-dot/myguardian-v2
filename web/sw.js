// 마이가디언 서비스 워커 — 바로가기 설치 요건용 최소 구성 (캐시 전략은 후속)
self.addEventListener("install", function () {
  self.skipWaiting();
});
self.addEventListener("activate", function (e) {
  e.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", function () {
  // 네트워크 통과 — 오프라인 캐시는 2차 공사에서
});
