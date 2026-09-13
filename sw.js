/* ============================================================
 * sw.js — Service Worker
 * 策略：在线时走网络并顺手写入缓存（永远拿到最新版）；
 *       断网时回退缓存（离线可打开）。缓存按完整 URL 存取，
 *       资源带 ?v= 版本号，更新后自然换新地址，无需维护清单。
 * ============================================================ */
var CACHE = 'intern-report-v1';

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // 只管本站资源
  e.respondWith(
    fetch(e.request).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(e.request).then(function (hit) {
        return hit || Response.error();
      });
    })
  );
});
