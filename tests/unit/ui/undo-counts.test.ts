/**
 * v0.3.3 · 项3（3-f）：回收站双口径计数单测。
 *
 * 3-f 修的是一处**判定口径**错误：入口可见性原先只用「可恢复条数」，导致
 * 「栈里还有条目、但全部已失效」时入口整体消失。改为「总条数判可见、
 * 可恢复条数判文案」后，两个量必须各自独立可测。
 */

import { describe, expect, it } from 'vitest';
import type { AppState } from '../../../src/app/state';
import type { UndoEntry } from '../../../src/app/undo-store';
import { readUndoCounts, recycleBinText, recycleHeadText } from '../../../src/ui/editor/undo-counts';

function entry(id: number, kind: UndoEntry['kind'], stale?: boolean): UndoEntry {
  return {
    id,
    createdAt: 1_700_000_000_000 + id,
    kind,
    segLabel: `段${id}`,
    pre: '{"v":1}',
    post: '{"v":1}',
    ...(stale === undefined ? {} : { stale }),
  };
}

/** 只关心 undoStack 的最小 state 造法（其它字段不参与本模块逻辑）。 */
function stateWith(undoStack: UndoEntry[], extra?: Record<string, unknown>): AppState {
  return { undoStack, ...(extra ?? {}) } as unknown as AppState;
}

describe('readUndoCounts · 无研发侧字段时从 undoStack 派生', () => {
  it('空栈：total = 0 / recoverable = 0（入口应隐藏）', () => {
    const c = readUndoCounts(stateWith([]));
    expect(c).toEqual({ total: 0, recoverable: 0 });
  });

  it('3 条全部可恢复：total = 3 / recoverable = 3（与 v0.3.2 口径一致）', () => {
    const c = readUndoCounts(stateWith([entry(1, 'delete-segment'), entry(2, 'delete-segment'), entry(3, 'delete-segment')]));
    expect(c).toEqual({ total: 3, recoverable: 3 });
  });

  it('3 条全部失效：total = 3 / recoverable = 0 —— 3-f 的核心场景（入口仍应可见）', () => {
    const c = readUndoCounts(
      stateWith([entry(1, 'delete-segment', true), entry(2, 'delete-segment', true), entry(3, 'delete-segment', true)]),
    );
    expect(c).toEqual({ total: 3, recoverable: 0 });
  });

  it('混合：失效 + 可恢复 + 恢复记录 —— total 含全部，recoverable 排除 stale 与 restore', () => {
    const c = readUndoCounts(
      stateWith([
        entry(1, 'delete-segment'), // 可恢复
        entry(2, 'restore'), // 恢复记录，不计入可恢复
        entry(3, 'delete-segment', true), // 已失效
      ]),
    );
    // total 是列表总条数（3）；recoverable 只算 1（入口那一条真正能点的）
    expect(c).toEqual({ total: 3, recoverable: 1 });
  });
});

describe('readUndoCounts · 研发侧字段落地后优先读字段', () => {
  it('正式字段名 undoTotalCount / undoRecoverableCount 优先于派生值', () => {
    // 故意让 undoStack 与字段不一致：字段应胜出（研发侧可能是跨会话合并后的准数）
    const c = readUndoCounts(stateWith([], { undoTotalCount: 5, undoRecoverableCount: 2 }));
    expect(c).toEqual({ total: 5, recoverable: 2 });
  });

  it('别名 undoTotal / undoRecoverable 同样生效（两侧命名不一致时不静默退回派生）', () => {
    const c = readUndoCounts(stateWith([], { undoTotal: 4, undoRecoverable: 0 }));
    expect(c).toEqual({ total: 4, recoverable: 0 });
  });

  it('字段之间倒挂（可恢复 > 总数）时按 total 收敛，不产出自相矛盾文案', () => {
    const c = readUndoCounts(stateWith([], { undoTotalCount: 2, undoRecoverableCount: 9 }));
    expect(c).toEqual({ total: 2, recoverable: 2 });
  });

  it('字段缺失 / 非法（负数、NaN）时退回派生，不采用坏值', () => {
    const stack = [entry(1, 'delete-segment'), entry(2, 'delete-segment', true)];
    const c = readUndoCounts(stateWith(stack, { undoTotalCount: -1, undoRecoverableCount: Number.NaN }));
    expect(c).toEqual({ total: 2, recoverable: 1 });
  });
});

describe('文案 · 入口与面板头部', () => {
  it('入口：可恢复 > 0 时保持 v0.3.2 原格式（既有断言零改动）', () => {
    expect(recycleBinText({ total: 3, recoverable: 3 })).toBe('🗑 回收站 (3)');
    // 混合场景也只报可恢复数（与 v0.3.2 一致）
    expect(recycleBinText({ total: 3, recoverable: 1 })).toBe('🗑 回收站 (1)');
  });

  it('入口：全部失效时标出总条数与「已失效」，不再显示为 0', () => {
    expect(recycleBinText({ total: 3, recoverable: 0 })).toBe('🗑 回收站 (3 · 已失效)');
  });

  it('面板头部：可恢复 > 0 保持原格式', () => {
    expect(recycleHeadText({ total: 3, recoverable: 1 })).toBe('回收站（1 步可恢复）');
  });

  it('面板头部：全部失效时说明「N 条，均已失效」', () => {
    expect(recycleHeadText({ total: 3, recoverable: 0 })).toBe('回收站（3 条，均已失效）');
  });
});
