#!/usr/bin/env node
/**
 * PWA 门禁（CI，定稿 §2.7）：manifest 字段校验（name / icons / display）
 * + sw.js 存在性 + 构建产物含注册代码，缺一即 fail。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
let failed = false;
const fail = (msg) => {
  console.error(`PWA 门禁失败：${msg}`);
  failed = true;
};

// 1. manifest 字段
const manifestPath = join(DIST, 'manifest.webmanifest');
if (!existsSync(manifestPath)) {
  fail('dist/manifest.webmanifest 不存在');
} else {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    fail('manifest.webmanifest 不是合法 JSON');
    manifest = null;
  }
  if (manifest) {
    if (!manifest.name) fail('manifest 缺 name');
    if (!Array.isArray(manifest.icons) || manifest.icons.length === 0) fail('manifest 缺 icons');
    if (!manifest.display) fail('manifest 缺 display');
  }
}

// 2. sw.js 存在性
if (!existsSync(join(DIST, 'sw.js'))) fail('dist/sw.js 不存在');
else {
  // 2-b. sw.js 必须**已完成构建注入**（v0.3.4 新增，A 席 D07 可构造判据）。
  // 旧口径只查「dist/sw.js 存在」：把未注入的 public/sw.js 原样拷进 dist 也能全过四条断言
  // → 而该文件里 `const SHELL_ASSETS = __PRECACHE_MANIFEST__;` 是裸标识符，
  // SW 求值时必抛 ReferenceError，install 直接失败、离线能力整体不成立。
  // 实测：用 public/sw.js 覆盖 dist/sw.js 后旧门禁 exit 0（假绿），新增本断言后 exit 1。
  const swText = readFileSync(join(DIST, 'sw.js'), 'utf8');
  const leftover = ['__BUILD_ID__', '__PRECACHE_MANIFEST__'].filter((p) => swText.includes(p));
  if (leftover.length > 0) {
    fail(
      `dist/sw.js 残留未替换的构建占位符（${leftover.join(' / ')}）——` +
        'build-sw.mjs 未执行或执行失败；该 SW 求值时会抛 ReferenceError，install 必失败',
    );
  }
  // 注入完成的正向锚点：BUILD_ID 必须是真实值（`<14位时间戳>-v<版本>`）
  if (!/const BUILD_ID = '\d{14}-v[^']+';/.test(swText)) {
    fail('dist/sw.js 的 BUILD_ID 不是注入后的真实值（期望 <14位UTC时间戳>-v<版本>）');
  }
}

// 3. 构建产物含注册代码（serviceWorker.register）
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}
let hasRegistration = false;
try {
  for (const file of walk(DIST)) {
    if (!/\.(html|js)$/.test(file)) continue;
    // 判据必须是「用脚本地址真的注册了 service worker」，不是「出现过 serviceWorker 这个词」。
    // 旧写法只测词面：删掉 src/ui/sw-update.ts 的 .register('sw.js') 之后，
    // `'serviceWorker' in navigator` 的探测分支仍让产物含该词 → 门禁仍绿（EXP-005 静默假绿）。
    // 也不能放宽成「出现 .register(」——把脚本地址换成任何非字符串实参（如 register(undefined)）
    // 依然匹配，同样是假绿。故锚定「.register( 后紧跟字符串/模板字面量」。
    // v0.3.4 双向实测（只做「修完仍绿」不构成证明，EXP-002）：
    //   正确产物 `serviceWorker.register("sw.js")`      → 命中 → exit 0
    //   注入 `register(undefined as unknown as string)` → 不命中 → exit 1
    if (/serviceWorker\s*\.\s*register\s*\(\s*["'`]/.test(readFileSync(file, 'utf8'))) {
      hasRegistration = true;
      break;
    }
  }
} catch {
  fail('dist/ 不存在，先跑 npm run build');
}
if (!hasRegistration) fail('构建产物中未找到 serviceWorker 注册代码');

if (failed) process.exit(1);
console.log('PWA 门禁通过：manifest 字段齐、sw.js 存在、注册代码在产物中');
