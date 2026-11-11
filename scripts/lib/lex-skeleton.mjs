/**
 * 源码词法骨架提取（共享设施，v0.3.4）。
 *
 * 为什么要有这个模块：`gate-undo` 与 `gate-paths` 都需要「把注释与字符串字面量抹掉、
 * 只留代码骨架，且不打乱偏移与行号」再匹配标识符。两份实现必然漂移，且第一版
 * `gate-paths` 的简化剔除器有一个真实假阴性：
 *   `stripCommentsAndStrings` 不认识**正则字面量**。当源码出现
 *   `const re = /a[//]b/;` 这类字符类内含 raw `//` 的正则时，`/` 被误判为行注释起点，
 *   整行被吞 → 同行上的 `new URL(x, import.meta.url).pathname` 由 HIT 变 MISS。
 *   （B 席 R-1，可构造）
 *
 * 故把 `gate-undo` 里已有、且已带「正则 vs 除号」判定与模板串插值栈的完整扫描器提出来
 * 共享，而不是在 `gate-paths` 里再写第二份。
 *
 * 契约：输入源码文本，输出**等长同构**骨架（换行保留、其余非代码字符变空格），
 * 因此可用同一偏移在原文上求行号。
 */

/** 标识符字符 */
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
export function stripCommentsAndLiterals(text) {
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
