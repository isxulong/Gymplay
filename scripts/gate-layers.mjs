#!/usr/bin/env node
/**
 * v0.3.3 · 项2 判据 2-a：层级字面量收拢门禁（X-10）。
 *
 * 断言：`z-index` 后跟**数值字面量**只允许出现在 `src/styles/layers.css`；
 * 其它样式文件只允许 `var(--fvp-z-*)`。
 *
 * ⚠ 正则必须带冒号：`editor.css` 里有一句注释「层级随播放头（z-index 3）」不带冒号，
 * 按 `z-index` 裸词匹配会把它误算成第 11 处，导致门禁恒红（方案 §2.2 明确点名）。
 *
 * v0.3.3 · N-6 修正（匹配手段错配）：
 * - 旧正则 `/z-index\s*:\s*(...)/g` **没有 i 标志**：CSS 属性名大小写不敏感，
 *   `Z-INDEX: 999` / `Z-Index: 999` 是真实生效的层级字面量却被漏过 → 补 `i` 标志。
 * - 旧实现逐行匹配**未剔除注释**：`/* 说明 z-index: 3 *\/` 这种带冒号的注释被误判为违规
 *   （方案 §2.2 只豁免「不带冒号」的写法）。→ 匹配前先剔除 `/* *\/` 与 `//` 注释。
 *   剔除时保留换行与等长占位，行号映射不变，因此报错行号仍指向原始源码。
 * - 剔除必须在**整文件**上做（而非逐行）：多行块注释里的 `z-index: N` 同样会被误报。
 *
 * 两条判据语义不变：2-a（layers.css 之外零数值字面量）与 2-g（编辑态通知层 52 ∈ (45,60)）。
 *
 * 用法：node scripts/gate-layers.mjs [--verbose]
 * 退出码：0 = 通过（字面量全在登记表内）；1 = 红（有越界字面量或登记表缺失）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STYLES_DIR = join(ROOT, 'src/styles');
const REGISTRY = join(STYLES_DIR, 'layers.css');

/**
 * 带冒号 + 数值（或数值型表达式）的裸字面量：只匹配非 var() 形式。
 * `i` 标志：CSS 属性名大小写不敏感，`Z-INDEX` / `Z-Index` 同样生效。
 */
const LITERAL_RE = /z-index\s*:\s*(-?\d+|calc|max|min|clamp)/gi;

/** 把 CSS 注释（`/* *\/` 与 `//`）内容替换为等长空白，保留换行以维持行号。 */
function stripCssComments(text) {
  const n = text.length;
  const out = [];
  let i = 0;
  const blank = (ch) => out.push(ch === '\n' ? '\n' : ' ');
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '*') {
      blank(ch); blank(next); i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { blank(text[i]); i += 1; }
      if (i < n) { blank(text[i]); blank(text[i + 1]); i += 2; }
      continue;
    }
    // 行注释：CSS 里不合法，但注释式说明（如 `// z-index: 7`）不该被算作字面量
    if (ch === '/' && next === '/') {
      while (i < n && text[i] !== '\n') { blank(text[i]); i += 1; }
      continue;
    }
    // 字符串（如 content: "..."）：串内文本不构成层级声明，一并占位（保留引号）
    if (ch === '\'' || ch === '"') {
      const q = ch;
      out.push(ch); i += 1;
      while (i < n) {
        const c = text[i];
        if (c === '\\') { blank(c); i += 1; if (i < n) { blank(text[i]); i += 1; } continue; }
        if (c === '\n') { blank(c); i += 1; break; } // 不闭合的串：到行末止损
        if (c === q) { out.push(c); i += 1; break; }
        blank(c); i += 1;
      }
      continue;
    }
    out.push(ch); i += 1;
  }
  return out.join('');
}

function walkCss(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkCss(p));
    else if (name.endsWith('.css')) out.push(p);
  }
  return out;
}

const files = walkCss(STYLES_DIR);
const violations = [];
let registryLiterals = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const code = stripCssComments(text);
  const rel = relative(ROOT, file);
  const isRegistry = file === REGISTRY;

  // 整文件扫描（不逐行），保证跨行的块注释 / 多行规则都能正确处理
  const lineStarts = [0];
  for (let k = 0; k < code.length; k += 1) {
    if (code[k] === '\n') lineStarts.push(k + 1);
  }
  const lineOf = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const rawLines = text.split('\n');
  LITERAL_RE.lastIndex = 0;
  let m;
  while ((m = LITERAL_RE.exec(code)) !== null) {
    if (isRegistry) {
      registryLiterals += 1;
    } else {
      const line = lineOf(m.index);
      violations.push(`${rel}:${line}  ${(rawLines[line - 1] ?? '').trim()}  [命中 ${m[0]}]`);
    }
  }
}

// 登记表必须存在且至少有内容
let registryText = '';
try {
  registryText = readFileSync(REGISTRY, 'utf8');
} catch {
  console.log('✗ 缺少层级登记表 src/styles/layers.css');
  process.exit(1);
}

const declaredVars = [...registryText.matchAll(/--fvp-z-[a-z-]+\s*:\s*\d+/g)].map((m) => m[0]);
if (declaredVars.length === 0) {
  console.log('✗ 层级登记表内没有任何 --fvp-z-* 数值声明');
  process.exit(1);
}

console.log(`层级登记表: ${relative(ROOT, REGISTRY)} — ${declaredVars.length} 个层级变量，${registryLiterals} 处数值字面量`);
if (violations.length > 0) {
  console.log(`✗ 登记表之外发现 ${violations.length} 处 z-index 数值字面量：`);
  for (const v of violations) console.log(`  ${v}`);
  process.exit(1);
}
console.log(`✓ 2-a 通过：登记表之外零 z-index 数值字面量（扫描 ${files.length} 个样式文件）`);

// 2-g：编辑态通知层级必须严格 >45 且 <60
const m = /--fvp-z-notice-editor\s*:\s*(\d+)/.exec(registryText);
if (!m) {
  console.log('✗ 登记表缺少 --fvp-z-notice-editor（编辑态通知层）');
  process.exit(1);
}
const v52 = Number(m[1]);
const sheetZ = Number((/--fvp-z-detail-sheet\s*:\s*(\d+)/.exec(registryText) ?? [])[1]);
const recycleZ = Number((/--fvp-z-recycle\s*:\s*(\d+)/.exec(registryText) ?? [])[1]);
if (!(v52 > sheetZ && v52 < recycleZ)) {
  console.log(`✗ 2-g 红：编辑态通知层 ${v52} 不满足「严格大于段详情面板 ${sheetZ} 且严格小于回收站 ${recycleZ}」`);
  process.exit(1);
}
console.log(`✓ 2-g 通过：编辑态通知层 ${v52} ∈ (${sheetZ}, ${recycleZ})`);

// 登记表数值必须单调有序（同一层可并列），并禁止重复以外的新增未登记值
const allValues = [...registryText.matchAll(/--fvp-z-[a-z-]+\s*:\s*(\d+)/g)].map((x) => Number(x[1]));
const sorted = [...allValues].sort((a, b) => a - b);
console.log(`  登记层级取值: ${sorted.join(' / ')}`);
process.exit(0);
