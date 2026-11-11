#!/usr/bin/env node
/**
 * 路径写法门禁（v0.3.4 新增，评审手册附录 A 准入：可构造型判据）。
 *
 * 禁止用 `new URL(..., import.meta.url).pathname` 拼**本地文件路径**。
 *
 * 失效场景（已发生型）：
 *   在 Windows 上 `new URL('..', 'file:///E:/repo/scripts/a.mjs').pathname`
 *   返回 `/E:/repo/`，首字符斜杠与盘符并列，经 node:path 拼成 `E:\E:\repo\`（重复盘符）。
 *   后果：build-sw / check-size / check-pwa / gate-layers 全部 exit 1，
 *   14 个 E2E spec 因 fixture 绝对路径非法而 ENOENT —— 实测 60/73 用例失败（82.2%）。
 *   而 CI 只跑 ubuntu-latest，缺陷在 CI 恒不暴露。
 *
 * 正确写法（仓库内已有先例：scripts/gate-decode.mjs、scripts/key-compat.mjs）：
 *   import { fileURLToPath } from 'node:url';
 *   const ROOT = fileURLToPath(new URL('..', import.meta.url));
 *
 * 允许的例外：`new URL(req.url, BASE).pathname` 这类 **HTTP 请求路径**解析（不是文件路径）。
 * 违规判据是「以 import.meta.url 为 base 的 file: URL 取了 pathname」。
 *
 * 实现要点（三条都是踩过的坑，改动前必读）：
 *   ① **必须先用共享词法器抹掉注释与字符串字面量**——否则本脚本自身注释里写的示例即命中，
 *      全仓恒红（gate-layers 踩过同一个坑）。
 *   ② **抹除必须保留换行**——否则报出的「文件:行」整体前移（第一版把 build-sw:13 报成 :6）。
 *   ③ **不能自己写简化剔除器**——简化版不认正则字面量，遇到字符类内含 raw `//` 的正则
 *      （如 `/a[//]b/`）会把整行当行注释吞掉，同行违规由 HIT 变 MISS（B 席 R-1，可构造）。
 *      故复用 gate-undo 的完整扫描器（scripts/lib/lex-skeleton.mjs），不再维护第二份。
 *
 * 判据可复算（两端都有读数）：
 *   修复前原始树：命中 20 处 → exit 1
 *   修复后工作树：命中 0 处 → exit 0
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsAndLiterals } from './lib/lex-skeleton.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCAN_DIRS = ['scripts', 'tests', 'src'];
const SCAN_EXT = /\.(mjs|js|ts|tsx)$/;

/**
 * 违规写法：`new URL(..., import.meta.url)` 之后取 pathname。
 *
 * 必须覆盖的等价形态（B 席 R-1b 实测，前三种在旧正则下全部 MISS）：
 *   - `new URL(...).pathname`
 *   - `(new URL(...)).pathname`          ← Prettier 对成员访问加括号就是这个形态
 *   - `new URL(...)["pathname"]`         ← 计算成员访问
 *   - `new URL(...)?.pathname`           ← 可选链
 *   - `new URL(...)\n  .pathname`        ← 跨行
 * **正则做不到的**：先把 URL 存进变量再取（`const u = new URL(..., import.meta.url); u.pathname`）。
 * 这类写法无法用文本匹配判定，靠 code review；已在此声明覆盖边界，不假装覆盖。
 */
const URL_WITH_META =
  /new\s+URL\s*\([^;{}]{0,300}?import\.meta\.url[^;{}]{0,300}?\)/;

/**
 * 在「URL 表达式之后」的位置检查是否取了 pathname。
 *
 * 注意：判定必须读**原始文本**，不能读骨架——词法器会把字符串内容抹成空格，于是
 * `["pathname"]` 在骨架里变成 `[          ]`，属性名消失、下标写法必然漏判。
 * 骨架只用于「确认这段 `new URL(…, import.meta.url)` 是真代码而非注释/字符串」，
 * 位置信息两者等长同构，可直接搬用。
 */
function takesPathname(original, matchEnd) {
  let i = matchEnd;
  const n = original.length;
  const skip = () => {
    while (i < n && (original[i] === ' ' || original[i] === '\t' || original[i] === '\r' || original[i] === '\n')) i++;
  };
  // 吃掉紧跟的 `)`（可能多层，对应 (new URL(...)).pathname 形态）
  for (;;) {
    skip();
    if (original[i] === ')') {
      i++;
      continue;
    }
    break;
  }
  skip();
  // 可选链 `?.` / 点号 `.` / 下标 `[`
  if (original[i] === '?' && original[i + 1] === '.') {
    i += 2;
    skip();
  } else if (original[i] === '.') {
    i += 1;
    skip();
  } else if (original[i] === '[') {
    i += 1;
    skip();
  }
  // 属性名：`pathname` / `"pathname"` / `'pathname'`
  const quote = original[i] === '"' || original[i] === "'" || original[i] === '`' ? original[i] : '';
  if (quote) {
    i += 1;
    skip();
  }
  return original.startsWith('pathname', i);
}

function* walk(dir) {
  let names;
  try {
    names = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (name === 'node_modules' || name === 'dist' || name === 'coverage') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (SCAN_EXT.test(name)) yield p;
  }
}

const hits = [];
for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const code = stripCommentsAndLiterals(text);
    // 骨架与原文等长同构 → 同一偏移即可在原文上求行号
    const lineAt = (offset) => code.slice(0, offset).split('\n').length;
    for (const m of code.matchAll(new RegExp(URL_WITH_META.source, 'g'))) {
      const end = m.index + m[0].length;
      // 骨架确认「这是真代码」，原文判「是否取了 pathname」（见 takesPathname 注释）
      if (takesPathname(text, end)) hits.push(`${relative(ROOT, file)}:${lineAt(m.index)}`);
    }
  }
}

if (hits.length > 0) {
  console.error('路径写法门禁失败：以下位置用 file: URL 的 pathname 拼本地文件路径。');
  console.error('Windows 上会产出 "/E:/…" 并被拼成 "E:\\E:\\…"，请改用 fileURLToPath：');
  console.error("  import { fileURLToPath } from 'node:url';");
  console.error("  const ROOT = fileURLToPath(new URL('..', import.meta.url));");
  for (const h of hits) console.error(`  - ${h}`);
  process.exit(1);
}
console.log('路径写法门禁通过：scripts/ tests/ src/ 内无 file: URL .pathname 拼路径写法');
