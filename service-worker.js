/**
 * nokori-mono Service Worker
 * ------------------------------------------------------------
 * アプリシェル（HTML/マニフェスト/アイコン）をキャッシュしてオフラインでも起動可能にする。
 * ローカルの定番レシピ辞書は index.html にインライン埋め込みなので、
 * これらをキャッシュすればオフラインでも「食材選択→ローカル提案」までは動作する。
 * AI提案(Gemini経由)はオンライン時のみ。
 */
const CACHE_NAME = "nokori-mono-v3";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./js/auth.js",
  "./js/app.js",
  "./js/community.js",
  "./js/costs.js",
  "./legal/terms.html",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // GAS呼び出し(POST)はキャッシュしない

  // 同一オリジンのアプリシェルはキャッシュ優先、それ以外はネットワーク優先
  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;

  if (isSameOrigin) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        return res;
      }).catch(() => cached))
    );
  } else {
    event.respondWith(
      fetch(req).catch(() => caches.match(req))
    );
  }
});
