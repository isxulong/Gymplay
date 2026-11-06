/**
 * v0.3.3 · 项3（3-f）：回收站计数的**唯一口径**。
 *
 * 背景（3-f 要解决的问题）：v0.3.2 的入口可见性与文案都只用「可恢复条数」一个量：
 *   `recoverable === 0` → 按钮整体隐藏。
 * 于是「栈里还有 3 条、但都已随更早的恢复一并回退（stale）」时，按钮直接消失，
 * 用户既看不到历史还在、也无法进回收站查看，误以为历史被清空了。
 *
 * 3-f 的口径改为两个量分开判：
 *   - **总条数 total**：决定入口是否可见（total > 0 就显示，不因「全部失效」而隐藏）；
 *   - **可恢复条数 recoverable**：决定文案是「N」还是「有 N 条但都已失效」。
 *
 * 字段来源：controller / state 侧负责**同时暴露这两个字段**（研发工程师那条线）。
 * 为让本侧改动可以先合、且研发侧字段落地后**无需再改 UI**，这里按「有字段就用字段、
 * 没有就等价派生」读取：
 *   - 优先读 state 上的 `undoTotalCount` / `undoRecoverableCount`（正式契约名）；
 *   - 兼容读 `undoTotal` / `undoRecoverable`（更短的别名，避免两侧命名不一致时静默退回派生）；
 *   - 两者都没有时按 v0.3.2 的既有语义从 `undoStack` 派生（与 controller 的过滤条件逐字一致）。
 * 派生口径与 controller 保持一致：可恢复 = `!stale && kind !== 'restore'`。
 */

import type { AppState } from '../../app/state';

export interface UndoCounts {
  /** 回收站列表里的总条数（含已失效 / 恢复记录）——决定入口可见性 */
  total: number;
  /** 仍可点「恢复到删除前」的条数——决定文案 */
  recoverable: number;
}

/** state 上可能承载两个计数的字段名（正式名 + 别名；研发侧落地前为 undefined）。 */
type WithUndoCountFields = AppState & {
  undoTotalCount?: number;
  undoRecoverableCount?: number;
  undoTotal?: number;
  undoRecoverable?: number;
};

function pickNumber(...candidates: Array<number | undefined>): number | undefined {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c >= 0) return c;
  }
  return undefined;
}

/** 读取回收站的两个计数（字段优先，缺字段则等价派生）。 */
export function readUndoCounts(state: AppState): UndoCounts {
  const s = state as WithUndoCountFields;
  // v0.3.3 · 项3 补丁：派生口径同步排除反向记录（与 undo-store.ts 的 undoCounts 同源）。
  // 反向记录是 confirmUndo 的簿记、不是用户能点的一步；算进去会让「入口报 N」
  // 与「面板里真正可操作的步数」对不上。
  const total =
    pickNumber(s.undoTotalCount, s.undoTotal) ?? state.undoStack.filter((e) => e.reverse !== true).length;
  const recoverable =
    pickNumber(s.undoRecoverableCount, s.undoRecoverable) ??
    state.undoStack.filter((e) => !e.stale && e.kind !== 'restore').length;
  // 派生来的 recoverable 不可能超过 total；若研发侧字段之间出现倒挂（可恢复 > 总数），
  // 以 total 为上限收敛，避免文案出现「0 条里有 3 条可恢复」这类自相矛盾。
  return { total, recoverable: Math.min(recoverable, total) };
}

/**
 * 入口文案（3-f）：可恢复 > 0 时保持 v0.3.2 原格式 `🗑 回收站 (N)`（既有断言零改动）；
 * 总数 > 0 但可恢复 = 0 时标明「都已失效」，让用户知道历史还在、只是不能再恢复。
 */
export function recycleBinText(counts: UndoCounts): string {
  if (counts.recoverable > 0) return `🗑 回收站 (${counts.recoverable})`;
  // total > 0 && recoverable === 0（调用方保证不在此分支传 total=0）
  return `🗑 回收站 (${counts.total} · 已失效)`;
}

/** 面板头部文案：可恢复 > 0 保持原格式；全部失效时给出总条数 + 失效说明。 */
export function recycleHeadText(counts: UndoCounts): string {
  if (counts.recoverable > 0) return `回收站（${counts.recoverable} 步可恢复）`;
  return `回收站（${counts.total} 条，均已失效）`;
}
