/**
 * v0.3.2 · 项2+10 守护（AB-P1-4 验证方式）：controller.ts 中裸 commitEdit( 调用数 == 0。
 *
 * 规则（方案 v1.1 · 项2+10 栈规则 2）：
 * - commitEdit 本体保留（不改 L313 原实现），但 controller 内全部编辑提交必须经
 *   包装层 commitEditTracked；
 * - commitEditTracked 自身对 commitEdit 的唯一内部调用点以行注释 `gate-undo:` 标记；
 * - 除函数定义处与该标记行外，任何**真实代码**中出现 `commitEdit` 后跟可选空白与 `(`
 *   都视为裸调用 → 门禁失败。
 *
 * v0.3.3 · N-6 修正（匹配手段错配）：
 * 旧实现逐行 `line.includes('commitEdit(')` 做**字面子串**匹配，既漏又误：
 * 漏 `commitEdit (x)`（中间一个空格）、漏 `commitEdit\n(x)`（跨行拆分）；
 * 误 `// 别裸调 commitEdit(`、误 `console.log('commitEdit(')`。
 * 现实现先做一遍**词法扫描**（剔除 `//`、`/* *\/`、单/双引号串、模板串字面段、正则字面量），
 * 保留代码骨架与行号映射，再在剩余代码上按**标识符边界**匹配 `commitEdit` + 可选空白 + `(`。
 *
 * `commitEditTracked(` 不会被匹配：`commitEdit` 之后紧跟 `Tracked`（标识符字符），
 * `\b` 与「后随可选空白与 (」两个条件都不成立。
 *
 * 豁免机制（等价保留）：行注释 `gate-undo:` 标记的**源码行**整体豁免。
 * 注意标记本身在注释里、扫描后已被剔除，因此豁免按**原始源码行号**判定，不依赖剔除后的文本。
 */

import { readFileSync } from 'node:fs';

const TARGET = new URL('../src/app/controller.ts', import.meta.url);
const src = readFileSync(TARGET, 'utf8');

const WORD = /[A-Za-z0-9_$]/;
/** 允许其后面出现正则字面量的前置 token（含关键字） */
const REGEX_PREFIX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw',
]);

/**
 * 把源码中的注释与字符串内容替换为等长空白（换行保留），从而**不打乱偏移与行号**。
 * 返回的文本里只剩代码骨架：标识符、运算符、括号、数字。
 */
function stripCommentsAndLiterals(text) {
  const n = text.length;
  const out = [];
  let i = 0;
  /** 最近一个非空白**代码**字符，用于区分除号与正则字面量起始 */
  let lastSig = '';
  /** 最近一个完整单词，用于识别 `return /re/` 这类关键字前缀 */
  let lastWord = '';
  /** 模板串嵌套栈：元素为 'tpl' 或 'code'（代码段内的花括号深度） */
  const stack = [];

  const emit = (ch) => {
    out.push(ch);
    if (ch === '\n' || ch === ' ' || ch === '\t' || ch === '\r') return;
    if (WORD.test(ch)) {
      lastSig = ch;
      // 累积单词（仅用于正则前缀判断，粗糙但足够）
      lastWord = WORD.test(lastSig) ? lastWord + ch : ch;
    } else {
      lastSig = ch;
      lastWord = '';
    }
  };
  /** 原样占位：非换行字符写成空格 */
  const blank = (ch) => {
    out.push(ch === '\n' ? '\n' : ' ');
  };

  /** 在模板串字面段内推进到 ` 或 ${ 或结尾 */
  const scanTemplateChunk = () => {
    while (i < n) {
      const ch = text[i];
      if (ch === '\\') {
        blank(ch);
        i += 1;
        if (i < n) { blank(text[i]); i += 1; }
        continue;
      }
      if (ch === '`') { blank(ch); i += 1; stack.pop(); return; }
      if (ch === '$' && text[i + 1] === '{') {
        emit('$'); i += 1;
        emit('{'); i += 1;
        stack.push('code'); // 进入插值代码段
        lastSig = '{';
        lastWord = '';
        return;
      }
      blank(ch); i += 1;
    }
  };

  const inTemplate = () => stack.length > 0 && stack[stack.length - 1] === 'tpl';

  while (i < n) {
    if (inTemplate()) { scanTemplateChunk(); continue; }

    const ch = text[i];
    const next = text[i + 1];

    // ---- 行注释 ----
    if (ch === '/' && next === '/') {
      while (i < n && text[i] !== '\n') { blank(text[i]); i += 1; }
      continue;
    }
    // ---- 块注释 ----
    if (ch === '/' && next === '*') {
      blank(ch); blank(next); i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { blank(text[i]); i += 1; }
      if (i < n) { blank(text[i]); blank(text[i + 1]); i += 2; }
      continue;
    }
    // ---- 单/双引号串 ----
    if (ch === '\'' || ch === '"') {
      const quote = ch;
      blank(ch); i += 1;
      while (i < n) {
        const c = text[i];
        if (c === '\\') { blank(c); i += 1; if (i < n) { blank(text[i]); i += 1; } continue; }
        if (c === quote) { blank(c); i += 1; break; }
        if (c === '\n') { blank(c); i += 1; break; } // 不闭合的串：到行末止损
        blank(c); i += 1;
      }
      continue;
    }
    // ---- 模板串开始 ----
    if (ch === '`') {
      blank(ch); i += 1;
      stack.push('tpl');
      continue;
    }
    // ---- 代码段内的 `}`：可能关闭插值 ----
    if (ch === '}' && stack.length > 0 && stack[stack.length - 1] === 'code') {
      emit('}'); i += 1;
      stack.pop(); // 回到模板串字面段
      continue;
    }
    // ---- 正则字面量 or 除号 ----
    if (ch === '/') {
      const prevIsWord = /[A-Za-z0-9_$]/.test(lastSig);
      const regexAllowed =
        !prevIsWord
          ? lastSig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSig)
          : REGEX_PREFIX_KEYWORDS.has(lastWord);
      if (regexAllowed) {
        blank(ch); i += 1;
        let inClass = false;
        while (i < n) {
          const c = text[i];
          if (c === '\\') { blank(c); i += 1; if (i < n) { blank(text[i]); i += 1; } continue; }
          if (c === '\n') break; // 未闭合：止损
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) { blank(c); i += 1; break; }
          blank(c); i += 1;
        }
        // 标志位
        while (i < n && /[gimsuy]/.test(text[i])) { blank(text[i]); i += 1; }
        lastSig = '/re/';
        lastWord = '';
        continue;
      }
    }

    emit(ch); i += 1;
  }

  return out.join('');
}

const stripped = stripCommentsAndLiterals(src);

// 原始源码中带 `gate-undo:` 标记的行（1-based）→ 豁免
const exemptLines = new Set();
src.split('\n').forEach((line, idx) => {
  if (line.includes('gate-undo:')) exemptLines.add(idx + 1);
});

// 行号映射：stripped 与 src 等长同构，可直接用同一偏移求行号
const lineStarts = [0];
for (let k = 0; k < src.length; k += 1) {
  if (src[k] === '\n') lineStarts.push(k + 1);
}
function lineOf(offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * 在代码骨架上找出对 `commitEdit` 标识符的**任何取值/调用**，而不是只匹配 `commitEdit(`。
 *
 * v0.3.4 收紧（可构造型判据，A 席 D08）：
 * 旧正则 `/\bcommitEdit\b\s*\(/g` 只认「标识符后紧跟 (」这一种形态，下列等价调用全部漏判——
 * 它们都绕过了 commitEditTracked 包装层（不进撤销栈），而门禁仍 exit 0：
 *   - `commitEdit?.(r)`            可选调用
 *   - `(0, commitEdit)(r)`         逗号表达式间接调用（打包器常见产物形态）
 *   - `(commitEdit as any)(r)`     TS 类型断言后调用
 *   - `const f = commitEdit; f(r)` 先赋给别名
 * 判据改为「凡是把 commitEdit 当值用（不是定义、不是 gate-undo: 标记行、不是
 * commitEditTracked）」即命中。宁可误报（多看一眼）也不漏放——漏放的后果是裸提交静默进
 * 生产、撤销栈丢记录，而误报只是让作者改成显式经包装层。
 *
 * 唯一豁免：`function commitEdit` 定义处的形参表与函数名本身；`commitEditTracked` 因
 * `commitEdit` 之后紧跟标识符字符 `T`，天然不被 `\bcommitEdit\b` 命中。
 */
const CALL_RE = /\bcommitEdit\b/g;
const rawLines = src.split('\n');
const bare = [];
let m;
while ((m = CALL_RE.exec(stripped)) !== null) {
  const start = m.index;
  const line = lineOf(start);

  // ① 函数定义（`function commitEdit(...)`）不算裸调用
  const before = stripped.slice(Math.max(0, start - 40), start);
  const isDecl = /(?:^|[^A-Za-z0-9_$])function\s*(?:\*\s*)?$/.test(before.replace(/[^\n]*\n/g, '\n'));

  // ② `gate-undo:` 标记行豁免（原始源码行号）
  const isMarked = exemptLines.has(line);

  if (isDecl || isMarked) continue;

  // 同一次调用若跨行，取起点的行；报告把匹配到的片段一并给出
  const snippet = stripped.slice(start, m.index + m[0].length).replace(/\s+/g, ' ');
  bare.push({ line, source: rawLines[line - 1].trim(), snippet });
}

if (bare.length !== 0) {
  console.error(`gate-undo: FAIL — controller.ts 存在 ${bare.length} 处裸 commitEdit( 调用（必须经 commitEditTracked 包装层）：`);
  for (const b of bare) console.error(`  L${b.line}: ${b.source}`);
  process.exit(1);
}

console.log('gate-undo: PASS — controller.ts 裸 commitEdit( 调用数 = 0');
