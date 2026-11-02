/**
 * Gymplay Service Worker（定稿 §2.7）
 * - 仅 cache-first 缓存 app shell 静态资产（HTML / JS / CSS / 图标）；
 * - 缓存名带版本号，发版换名清旧缓存；
 * - 不拦截、不缓存任何页面导航的 hash 部分（hash 本不上行，天然安全，此处为显式纪律）；
 * - 检测到新版本时由页面提示「刷新即更新」（M3 接线 UI）。
 */
const CACHE_VERSION = 'v0.0.0-m0';
const CACHE_NAME = `gymplay-shell-${CACHE_VERSION}`;
const SHELL_ASSETS = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // cache-first：命中缓存直接返回，未命中走网络并回写缓存（仅静态资产）
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((response) => {
          if (response.ok && /\.(html|js|css|png|webmanifest)$/.test(url.pathname)) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
