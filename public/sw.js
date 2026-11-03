/**
 * Gymplay Service Worker（定稿 §2.7，M3 收口版，设计见 ADR-008）
 * - app shell 全量预缓存（清单由 scripts/build-sw.mjs 构建时生成注入，含 hash 产物）：
 *   任一资源预缓存失败 → install 整体失败 → 新 SW 不激活、不删任何旧缓存；
 * - 版本化缓存共存 + 懒删：缓存名含定宽 UTC 时间戳，activate 只保留最新两代
 *   （当前 + 上一版），更老的才删——发版后旧 tab 断网仍可由上一代缓存完整服务；
 * - 升级检测（activate 时存在非当前代的旧缓存）→ postMessage 通知页面弹
 *   「刷新即更新」提示（UI 在 src/ui/sw-update.ts）；首次安装无旧缓存，不打扰；
 * - 仅 cache-first 缓存 app shell 静态资产（HTML / JS / CSS / 图标）；
 * - 不拦截、不缓存任何页面导航的 hash 部分（hash 本不上行，天然安全，此处为显式纪律）。
 *
 * 构建占位符（BUILD_ID 与预缓存清单声明）由 scripts/build-sw.mjs
 * 在 vite build 后写入 dist/sw.js（release 链路无需人工改本文件换版本号）。
 */
const BUILD_ID = '__BUILD_ID__'; // <UTC时间戳14位>-v<package.json版本>，如 20261103093000-v0.2.0
const CACHE_NAME = `gymplay-shell-${BUILD_ID}`;
const CACHE_PREFIX = 'gymplay-shell-';
const KEEP_CACHES = 2; // 当前 + 上一代共存，更老的懒删
const SHELL_ASSETS = __PRECACHE_MANIFEST__; // 全量 app shell 预缓存清单（构建时生成）

self.addEventListener('install', (event) => {
  // 全量预缓存成功才 skipWaiting；失败则 install 整体 reject，新 SW 不激活
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const ours = (await caches.keys()).filter((k) => k.startsWith(CACHE_PREFIX));
      const isUpgrade = ours.some((k) => k !== CACHE_NAME);
      // 懒删：BUILD_ID 首段为定宽 UTC 时间戳，字典序即时间序；仅清第 KEEP_CACHES 代之前的
      const stale = ours.sort().reverse().slice(KEEP_CACHES);
      await Promise.all(stale.map((k) => caches.delete(k)));
      await self.clients.claim();
      if (isUpgrade) {
        // 通知所有窗口（含仍由旧 SW 控制的旧 tab）「刷新即更新」
        const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
        for (const client of clients) {
          client.postMessage({ type: 'GYMPLAY_SW_UPDATED', buildId: BUILD_ID });
        }
      }
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // cache-first，但只认当前代缓存为主命中（全局 caches.match 会命中先建的上一代，
  // 导致升级后刷新仍拿旧 shell——版本共存策略下必须显式按代查找）；
  // 上一代缓存仅作兜底（发版后未刷新的旧 tab 懒取旧 hash 资产时命中），
  // 未命中走网络并回写当前代（仅静态资产）
  event.respondWith(
    (async () => {
      const current = await caches.open(CACHE_NAME);
      const hit = await current.match(request);
      if (hit) return hit;
      const keys = await caches.keys();
      for (const key of keys) {
        if (key === CACHE_NAME || !key.startsWith(CACHE_PREFIX)) continue;
        const legacy = await caches.open(key).then((cache) => cache.match(request));
        if (legacy) return legacy;
      }
      const response = await fetch(request);
      if (response.ok && /\.(html|js|css|png|webmanifest)$/.test(url.pathname)) {
        const copy = response.clone();
        current.put(request, copy);
      }
      return response;
    })(),
  );
});
