/**
 * v0.3.2 · 项2+10 守护（AB-P1-4 验证方式）：controller.ts 中裸 commitEdit( 调用数 == 0。
 *
 * 规则（方案 v1.1 · 项2+10 栈规则 2）：
 * - commitEdit 本体保留（不改 L313 原实现），但 controller 内全部编辑提交必须经
 *   包装层 commitEditTracked；
 * - commitEditTracked 自身对 commitEdit 的唯一内部调用点以行注释 `gate-undo:` 标记；
 * - 除函数定义行与该标记行外，任何出现 `commitEdit(` 的行都视为裸调用 → 门禁失败。
 *
 * 说明：`commitEditTracked(` 不含字面 `commitEdit(`（后随字母 T），无需额外排除。
 */

import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/app/controller.ts', import.meta.url), 'utf8');
const lines = src.split('\n');

const bare = lines.filter(
  (line) =>
    line.includes('commitEdit(') &&
    !line.includes('function commitEdit(') &&
    !line.includes('gate-undo:'),
);

if (bare.length !== 0) {
  console.error(`gate-undo: FAIL — controller.ts 存在 ${bare.length} 处裸 commitEdit( 调用（必须经 commitEditTracked 包装层）：`);
  for (const line of bare) console.error(`  ${line.trim()}`);
  process.exit(1);
}

console.log('gate-undo: PASS — controller.ts 裸 commitEdit( 调用数 = 0');
