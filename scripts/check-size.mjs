#!/usr/bin/env node
/**
 * 体积门禁（CI）。
 * - M0 空壳门禁：主 bundle（入口 chunk）gzip < 200KB；
 * - 蓝图硬约束（上游）：gzip 总量 < 1MB；
 * 任一超限 exit 1。
 */
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const DIST = new URL('../dist', import.meta.url).pathname;
const MAIN_BUNDLE_GZIP_LIMIT = 200 * 1024; // M0 空壳构建门禁 <200KB
const TOTAL_GZIP_LIMIT = 1024 * 1024; // 上游硬约束 <1MB

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

let files;
try {
  files = [...walk(DIST)];
} catch {
  console.error('dist/ 不存在，先跑 npm run build');
  process.exit(1);
}

let totalRaw = 0;
let totalGzip = 0;
let mainGzip = 0;
let mainFile = null;

// 入口 chunk = dist/index.html 里 script 引用的那个 js
const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const entryMatch = html.match(/src="([^"]*assets\/[^"]+\.js)"/);

console.log('file\traw\tgzip');
for (const file of files) {
  const buf = readFileSync(file);
  const gz = gzipSync(buf, { level: 9 });
  totalRaw += buf.length;
  totalGzip += gz.length;
  const rel = relative(DIST, file);
  if (entryMatch && rel.replaceAll('\\', '/') === entryMatch[1].replace(/^\.\//, '')) {
    mainGzip = gz.length;
    mainFile = rel;
  }
  console.log(`${rel}\t${buf.length}\t${gz.length}`);
}
console.log(`TOTAL\traw=${totalRaw}B (${(totalRaw / 1024).toFixed(1)}KB)\tgzip=${totalGzip}B (${(totalGzip / 1024).toFixed(1)}KB)`);
console.log(`MAIN\t${mainFile}\tgzip=${mainGzip}B (${(mainGzip / 1024).toFixed(1)}KB)`);

let failed = false;
if (!mainFile) {
  console.error('未找到入口 chunk（dist/index.html 无 assets/*.js 引用）');
  failed = true;
}
if (mainGzip >= MAIN_BUNDLE_GZIP_LIMIT) {
  console.error(`主 bundle gzip ${(mainGzip / 1024).toFixed(1)}KB ≥ 200KB 门禁`);
  failed = true;
}
if (totalGzip >= TOTAL_GZIP_LIMIT) {
  console.error(`gzip 总量 ${(totalGzip / 1024).toFixed(1)}KB ≥ 1MB 硬约束`);
  failed = true;
}
if (failed) process.exit(1);
console.log('体积门禁通过：主 bundle gzip < 200KB，总量 gzip < 1MB');
