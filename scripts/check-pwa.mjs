#!/usr/bin/env node
/**
 * PWA 门禁（CI，定稿 §2.7）：manifest 字段校验（name / icons / display）
 * + sw.js 存在性 + 构建产物含注册代码，缺一即 fail。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = new URL('../dist', import.meta.url).pathname;
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
    if (/serviceWorker/.test(readFileSync(file, 'utf8'))) {
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
