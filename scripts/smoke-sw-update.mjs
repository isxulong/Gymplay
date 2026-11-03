#!/usr/bin/env node
/**
 * SW 批次本地冒烟（M3 收口，ADR-008；本地手动脚本，非 CI 门禁）。
 *
 * 覆盖终审报告步骤 3 验收 a / b / c：
 * - a) 两次构建模拟「新版部署后旧 tab 出现刷新即更新」：
 *      构建 A（v0.2.0）→ 起静态服务 → 打开页面装 SW → 换盘为构建 B（临时版本号 0.2.1-smoke）
 *      → reg.update() → 断言提示条出现 → 点「刷新」→ 断言新版本生效；
 * - b) 断网冷启动：context.setOffline(true) 后新开页面，断言由 SW 缓存完整打开（非白屏）；
 * - c) 两次构建的 dist/sw.js BUILD_ID 自动不同（版本号取自 package.json，全程未改 sw.js）。
 *
 * 用法：node scripts/smoke-sw-update.mjs
 * 可选环境变量：FVP_CHROMIUM_PATH 指向系统 Chromium（与 playwright.config.ts 同名约定）。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, extname } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = new URL('..', import.meta.url).pathname;
const TMP = join(ROOT, 'smoke-tmp');
const SERVE = join(TMP, 'serve');
const PORT = 5201;
const BASE = `http://127.0.0.1:${PORT}`;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
};

const pkgPath = join(ROOT, 'package.json');
const htmlPath = join(ROOT, 'index.html');
const origPkg = readFileSync(pkgPath, 'utf8');
const origHtml = readFileSync(htmlPath, 'utf8');
const origVersion = JSON.parse(origPkg).version;
const SMOKE_VERSION_B = '0.2.1-smoke';

function run(cmd, ...args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`命令失败：${cmd} ${args.join(' ')}`);
}

function buildOnce(label, version, titleMarker) {
  writeFileSync(pkgPath, JSON.stringify({ ...JSON.parse(origPkg), version }, null, 2) + '\n');
  writeFileSync(
    htmlPath,
    origHtml.replace('<title>Gymplay · 健身分段变速播放器</title>', `<title>Gymplay · 健身分段变速播放器 ${titleMarker}</title>`),
  );
  run('npm', 'run', 'build');
  const out = join(TMP, label);
  rmSync(out, { recursive: true, force: true });
  cpSync(join(ROOT, 'dist'), out, { recursive: true });
  const buildId = /const BUILD_ID = '([^']+)';/.exec(readFileSync(join(out, 'sw.js'), 'utf8'))?.[1];
  if (!buildId) throw new Error(`${label} 构建产物 sw.js 中未找到 BUILD_ID`);
  return { out, buildId };
}

function startServer() {
  const server = createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, BASE).pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = join(SERVE, path);
    if (!existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

function swapServe(dir) {
  rmSync(SERVE, { recursive: true, force: true });
  cpSync(dir, SERVE, { recursive: true });
}

async function main() {
  mkdirSync(TMP, { recursive: true });
  let browser;
  let server;
  const evidence = [];
  const say = (msg) => {
    console.log(msg);
    evidence.push(msg);
  };
  try {
    // ── 构建两版（验收 c：BUILD_ID 自动变化，全程未人工改 sw.js）──
    say(`[build] 构建版 A（package.json version=${origVersion}）…`);
    const A = buildOnce('A', origVersion, '【构建A】');
    say(`[build] A 构建产物 BUILD_ID = ${A.buildId}`);
    if (/-v(.+)$/.exec(A.buildId)?.[1] !== origVersion) throw new Error('A 版 BUILD_ID 未取到 package.json 版本号');
    // BUILD_ID 时间戳为秒级：确保两版不同
    await new Promise((r) => setTimeout(r, 1500));
    say(`[build] 构建版 B（package.json version 临时改为 ${SMOKE_VERSION_B}，sw.js 未动）…`);
    const B = buildOnce('B', SMOKE_VERSION_B, '【构建B】');
    say(`[build] B 构建产物 BUILD_ID = ${B.buildId}`);
    if (/-v(.+)$/.exec(B.buildId)?.[1] !== SMOKE_VERSION_B) throw new Error('B 版 BUILD_ID 未取到 package.json 版本号');
    if (A.buildId === B.buildId) throw new Error('两次构建 BUILD_ID 相同（秒级时间戳碰撞），重跑即可');
    say(`[PASS c] 两次构建 BUILD_ID 自动不同且版本号随 package.json 变化：${A.buildId} → ${B.buildId}`);

    // ── 起服务，装载版 A，装 SW ──
    swapServe(A.out);
    server = await startServer();
    const launchOptions = { headless: true };
    const envChromium = process.env.FVP_CHROMIUM_PATH;
    if (envChromium) launchOptions.executablePath = envChromium;
    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    const titleA = await page.title();
    say(`[load] 版 A 页面标题：${titleA}`);
    if (!titleA.includes('构建A')) throw new Error('版 A 页面未正确打开');

    // serviceWorker.ready 在 install 失败时永不 resolve，加超时把失败显式暴露
    const ready = await page.evaluate(async () => {
      const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('serviceWorker.ready 超时（install 可能失败）')), ms))]);
      const reg = await withTimeout(navigator.serviceWorker.ready, 20_000);
      return { scriptURL: reg.active?.scriptURL ?? '', caches: await caches.keys() };
    });
    say(`[sw] SW 就绪：${ready.scriptURL}`);
    say(`[sw] 当前缓存：${JSON.stringify(ready.caches)}`);
    if (!ready.caches.includes(`gymplay-shell-${A.buildId}`)) throw new Error('版 A 缓存未建立');

    // ── 模拟发版：换盘为版 B，旧 tab 触发更新检查（等价于页面轮询 reg.update()）──
    say('[deploy] 模拟发版：服务目录换为版 B …');
    swapServe(B.out);
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg?.update();
    });
    say('[deploy] 旧 tab 已触发 reg.update()，等待「刷新即更新」提示…');
    const toast = page.locator('[data-testid=sw-update-toast]');
    await toast.waitFor({ state: 'visible', timeout: 30_000 });
    const toastText = await toast.innerText();
    say(`[toast] 提示条出现：${toastText.replace(/\s+/g, ' ')}`);
    if (!toastText.includes('刷新即更新')) throw new Error('提示条文案缺失「刷新即更新」');
    if (!toastText.includes(SMOKE_VERSION_B)) throw new Error(`提示条未包含新版本号 ${SMOKE_VERSION_B}`);
    const cachesAfterUpdate = await page.evaluate(() => caches.keys());
    say(`[sw] 升级后缓存（两代共存）：${JSON.stringify(cachesAfterUpdate)}`);
    if (!cachesAfterUpdate.includes(`gymplay-shell-${A.buildId}`) || !cachesAfterUpdate.includes(`gymplay-shell-${B.buildId}`)) {
      throw new Error('新旧两代缓存未共存');
    }
    await page.screenshot({ path: join(TMP, 'update-toast.png') });
    say(`[shot] 提示条截图：smoke-tmp/update-toast.png`);
    say(`[PASS a] 旧 tab 出现「刷新即更新」提示，含新版本号 v${SMOKE_VERSION_B}，新旧两代缓存共存`);

    // ── 点「刷新」→ 新版本生效 ──
    await toast.getByRole('button', { name: '刷新' }).click();
    await page.waitForLoadState('load');
    const titleB = await page.title();
    say(`[reload] 刷新后页面标题：${titleB}`);
    if (!titleB.includes('构建B')) throw new Error('刷新后未进入版 B');
    say('[PASS a+] 点击「刷新」后页面进入新版 B');

    // ── 断网冷启动（验收 b）：新开页面 + offline，应由 SW 缓存完整打开 ──
    await context.setOffline(true);
    const cold = await context.newPage();
    await cold.goto(`${BASE}/`, { waitUntil: 'load' });
    const coldTitle = await cold.title();
    const appMounted = await cold.evaluate(() => {
      const app = document.getElementById('app');
      return { children: app?.childElementCount ?? 0, text: app?.textContent?.slice(0, 40) ?? '' };
    });
    say(`[offline] 断网冷启动标题：${coldTitle}；#app 子元素数：${appMounted.children}`);
    if (!coldTitle.includes('构建B')) throw new Error('断网冷启动未打开到已部署版本');
    if (appMounted.children === 0) throw new Error(`断网冷启动白屏（#app 无子元素，残留文案：${appMounted.text}）`);
    await cold.screenshot({ path: join(TMP, 'offline-cold-start.png') });
    say('[shot] 断网冷启动截图：smoke-tmp/offline-cold-start.png');
    say('[PASS b] 断网冷启动已装 PWA 可完整打开（缓存命中，非白屏）');

    say('[RESULT] SW 批次本地冒烟全部通过（a / b / c 三项验收）');
    writeFileSync(join(TMP, 'smoke-evidence.txt'), evidence.join('\n') + '\n');
  } finally {
    await browser?.close().catch(() => {});
    await new Promise((r) => server?.close(r));
    writeFileSync(pkgPath, origPkg);
    writeFileSync(htmlPath, origHtml);
    rmSync(join(ROOT, 'dist'), { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[FAIL] ${err.message}`);
  process.exit(1);
});
