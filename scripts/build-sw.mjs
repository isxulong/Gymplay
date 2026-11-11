#!/usr/bin/env node
/**
 * SW 构建注入（M3 收口，ADR-008）：vite build 后运行（npm run build 链内）。
 * 1) BUILD_ID = <UTC时间戳14位>-v<package.json 版本>——缓存名换代的唯一事实源，
 *    release 链路只需正常构建，无需人工改 public/sw.js 换 CACHE_VERSION；
 * 2) 扫描 dist/ 生成 app shell 全量预缓存清单（assets/icons/hash 产物全量）；
 * 3) 将二者写入 dist/sw.js 的 __BUILD_ID__ / __PRECACHE_MANIFEST__ 占位符。
 * 占位符缺失或替换后残留即 exit 1（防 sw.js 源与本脚本漂移）。
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const SW_DIST = join(DIST, 'sw.js');

if (!existsSync(SW_DIST)) {
  console.error('dist/sw.js 不存在：public/sw.js 由 vite 拷入 dist，请先跑 vite build');
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
// UTC 定宽 14 位时间戳：保证缓存名字典序 == 时间序（sw.js 懒删按此排序）
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const BUILD_ID = `${stamp}-v${version}`;

// app shell 清单：导航根、入口 HTML、manifest，加 assets/ 与 icons/ 全量（sw.js 自身除外）
function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}
const PRECACHE = ['./', './index.html'];
for (const file of walk(DIST)) {
  const rel = relative(DIST, file).replaceAll('\\', '/');
  if (rel === 'sw.js' || rel === 'index.html') continue;
  if (/^(assets|icons)\//.test(rel) || rel === 'manifest.webmanifest') PRECACHE.push(`./${rel}`);
}

const sw = readFileSync(SW_DIST, 'utf8');
if (!/const BUILD_ID = '__BUILD_ID__';/.test(sw) || !/const SHELL_ASSETS = __PRECACHE_MANIFEST__;/.test(sw)) {
  console.error('dist/sw.js 缺少占位符声明（public/sw.js 与本脚本需同步维护）');
  process.exit(1);
}
// 锚定声明行替换（勿用全局替换：占位符名若出现在注释等处会抢先吃掉替换，残留引用在 SW 求值时抛错）
const injected = sw
  .replace("const BUILD_ID = '__BUILD_ID__';", `const BUILD_ID = '${BUILD_ID}';`)
  .replace('const SHELL_ASSETS = __PRECACHE_MANIFEST__;', `const SHELL_ASSETS = ${JSON.stringify(PRECACHE)};`);
if (/__BUILD_ID__|__PRECACHE_MANIFEST__/.test(injected)) {
  console.error('dist/sw.js 注入后仍残留占位符（public/sw.js 中占位符名只能出现在声明行）');
  process.exit(1);
}
writeFileSync(SW_DIST, injected);

console.log(`SW 构建注入完成：BUILD_ID=${BUILD_ID}（版本号取自 package.json，无需人工改 sw.js）`);
console.log(`app shell 预缓存清单（${PRECACHE.length} 项）：`);
for (const item of PRECACHE) console.log(`  - ${item}`);
