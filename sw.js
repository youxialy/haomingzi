/* ============================================================
 * sw.js — Service Worker
 *
 * 策略（按请求类型分流，而不是一刀切）：
 *   · 页面/HTML      → 网络优先，失败回退缓存。HTML 很小，这样每次
 *                      打开都能立刻拿到最新版；断网时照样能开。
 *   · 带 ?v= 的资源   → 缓存优先。版本号变了就是新 URL，天然失效，
 *                      所以可以放心长期缓存，二次打开接近瞬时。
 *   · 其他同源资源    → 缓存优先 + 后台更新。
 *   · 跨域请求        → 不拦截。
 *
 * 发布新版本时：把 VERSION 和页面里的 ?v= 一起改掉，
 * activate 会自动清掉旧版本缓存。
 * ============================================================ */
var VERSION = '2026091804';
var CACHE = 'intern-report-' + VERSION;

// 首次安装就预缓存「外壳」，让断网 / 弱网也能直接打开
var SHELL = [
  './',
  './index.html',
  './guide.html',
  './manifest.webmanifest',
  './css/style.css?v=' + VERSION,
  './js/store.js?v=' + VERSION,
  './js/phrases.js?v=' + VERSION,
  './js/generator.js?v=' + VERSION,
  './js/composer.js?v=' + VERSION,
  './js/editor.js?v=' + VERSION,
  './js/calendar.js?v=' + VERSION,
  './js/app.js?v=' + VERSION
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // 单个资源失败不该让整个安装失败（比如某张图还没传上去）
      return Promise.all(SHELL.map(function (url) {
        return c.add(new Request(url, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);   // 清掉旧版本缓存
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isNavigation(req) {
  return req.mode === 'navigate' ||
    (req.headers.get('accept') || '').indexOf('text/html') >= 0;
}

// 网络优先：失败或超时才回退缓存
function networkFirst(req) {
  return fetch(req, { cache: 'no-cache' }).then(function (res) {
    if (res && res.ok) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(req).then(function (hit) {
      if (hit) return hit;
      return caches.match('./index.html');   // 页面级兜底
    });
  });
}

// 缓存优先：命中即返回，同时在后台刷新一份
function cacheFirst(req) {
  return caches.match(req).then(function (hit) {
    var net = fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () { return hit; });
    return hit || net;
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== location.origin) return;   // 只管本站资源

  if (isNavigation(req)) {
    e.respondWith(networkFirst(req));
    return;
  }
  e.respondWith(cacheFirst(req));
});
