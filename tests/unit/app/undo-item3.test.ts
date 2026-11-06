/**
 * v0.3.3 · 项3 追加单测：撤销栈的逐条门禁 / 适用性判定 / 计数拆分 / 向后兼容 / 清栈痕迹。
 *
 * 与 undo-store.test.ts（v0.3.2 基线，含 3 条被反转的旧断言）同目录、互不覆盖。
 *
 * 判据映射：
 * - 3-a 逐条适用性 → 「逐条门禁」+「isEntryApplicable」两组
 * - 3-d 真断裂留痕 → 「清栈痕迹」组
 * - 3-f 计数拆分   → 「计数拆分」组
 * - 3-i 回滚兼容   → 「向后兼容」组（用 v0.3.2 旧版解析器的逐字副本做实测）
 */

import { describe, it, expect } from 'vitest';
import {
  UNDO_ENTRY_MAX_BYTES,
  isEntryApplicable,
  isUndoEntryOversized,
  makeBreakRecord,
  parseUndoEntries,
  parseUndoRecord,
  pushUndoEntry,
  restoreUndoStack,
  serializeUndoEntries,
  undoCounts,
  undoGate,
  undoGateFor,
  type UndoEntry,
} from '../../../src/app/undo-store';
import { canonicalize } from '../../../src/core/config/codec';
import { makeConfig, makeSegment } from '../helpers';

function entry(partial: Partial<UndoEntry> = {}): UndoEntry {
  return {
    id: partial.id ?? 1,
    createdAt: partial.createdAt ?? 1700000000000,
    kind: partial.kind ?? 'delete-segment',
    segLabel: partial.segLabel ?? '热身',
    pre: partial.pre ?? canonicalize(makeConfig()),
    post: partial.post ?? canonicalize(makeConfig()),
    ...(partial.stale === undefined ? {} : { stale: partial.stale }),
    ...(partial.chainBroken === undefined ? {} : { chainBroken: partial.chainBroken }),
    ...(partial.reverse === undefined ? {} : { reverse: partial.reverse }),
    ...(partial.invalidReason === undefined ? {} : { invalidReason: partial.invalidReason }),
  };
}

/**
 * v0.3.2 旧版 parseUndoEntries 的逐字等价副本（来自 commit a5abbdf 的 src/app/undo-store.ts）。
 * 用途：判据 3-i「旧代码读新栈不抛错」——必须用**旧代码的真实逻辑**去读新格式载荷，
 * 而不是自己写一个宽松的读取器。
 */
function legacyParseUndoEntries(raw: string | null): unknown[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const rec = parsed as Record<string, unknown>;
  if (rec.v !== 1) return [];
  if (!Array.isArray(rec.entries)) return [];
  const out: unknown[] = [];
  for (const e of rec.entries) {
    if (typeof e !== 'object' || e === null) continue;
    const x = e as Record<string, unknown>;
    if (
      Number.isInteger(x.id) &&
      typeof x.createdAt === 'number' &&
      Number.isFinite(x.createdAt) &&
      (x.kind === 'delete-segment' || x.kind === 'remove-entry' || x.kind === 'restore') &&
      typeof x.segLabel === 'string' &&
      typeof x.pre === 'string' &&
      typeof x.post === 'string' &&
      (x.stale === undefined || typeof x.stale === 'boolean')
    ) {
      out.push(e);
    }
  }
  return out;
}

describe('v0.3.3 · 项3：逐条门禁（判定对象 = 被点击的条目，不再是栈顶）', () => {
  const c0 = canonicalize(makeConfig());
  const c1 = canonicalize(makeConfig({ segments: [makeSegment({ id: 'aaa000' })] }));
  const c2 = canonicalize(makeConfig({ segments: [] }));

  it('undoGateFor：栈顶失效不挡更早的有效条目（旧口径会把整栈挡掉）', () => {
    const stack = [entry({ id: 1, pre: c0, post: c1 }), entry({ id: 2, pre: c1, post: c2 })];
    // 旧口径（比栈顶）：当前是 c1，栈顶 post 是 c2 → 整栈被挡住
    expect(undoGate(stack, c1)).toBe(false);
    // 新口径（比被点击条目）：第 1 条 post(c1) === 当前(c1) → 仍可恢复
    expect(undoGateFor(stack[0], c1)).toBe(true);
    expect(undoGateFor(stack[1], c1)).toBe(false);
  });

  it('undoGateFor：空条目 / 无当前配置 → 不放行（不抛异常）', () => {
    expect(undoGateFor(null, c1)).toBe(false);
    expect(undoGateFor(entry({ id: 1, post: c1 }), null)).toBe(false);
  });
});

describe('v0.3.3 · 项3：isEntryApplicable（纯函数，返回原因码，不抛异常）', () => {
  it('无当前配置 → NO_CONFIG', () => {
    const r = isEntryApplicable(entry(), null);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('NO_CONFIG');
  });

  it('pre 非合法 JSON → BAD_PRE_JSON', () => {
    const r = isEntryApplicable(entry({ pre: 'not-json' }), makeConfig());
    expect(r.ok === false && r.reason).toBe('BAD_PRE_JSON');
  });

  it('pre 校验不过 → SCHEMA_INVALID', () => {
    const r = isEntryApplicable(entry({ pre: JSON.stringify({ v: 99 }) }), makeConfig());
    expect(r.ok === false && r.reason).toBe('SCHEMA_INVALID');
  });

  it('段区间超出当前视频时长 → OUT_OF_DURATION', () => {
    const current = makeConfig({ video: { type: 'local', filename: 'a.mp4', duration: 30 } });
    const over = makeConfig({
      segments: [makeSegment({ id: 'aaa000', start: 0, end: 60 })],
      sequence: ['aaa000'],
    });
    const r = isEntryApplicable(entry({ pre: canonicalize(over) }), current);
    expect(r.ok === false && r.reason).toBe('OUT_OF_DURATION');
  });

  it('pre 内段 id 重复 → DUPLICATE_ID', () => {
    const dup = makeConfig({
      segments: [
        makeSegment({ id: 'aaa000', start: 0, end: 10 }),
        makeSegment({ id: 'aaa000', start: 10, end: 20 }),
      ],
      sequence: ['aaa000'],
    });
    const r = isEntryApplicable(entry({ pre: canonicalize(dup) }), makeConfig());
    expect(r.ok === false && r.reason).toBe('DUPLICATE_ID');
  });

  it('id 被复用给另一段（区间/速率不一致）→ ID_CONFLICT', () => {
    const live = makeConfig({
      segments: [makeSegment({ id: 'aaa000', start: 0, end: 10, rate: 1 })],
      sequence: ['aaa000'],
    });
    const conflict = makeConfig({
      segments: [makeSegment({ id: 'aaa000', start: 0, end: 12, rate: 1 })],
      sequence: ['aaa000'],
    });
    const r = isEntryApplicable(entry({ pre: canonicalize(conflict) }), live);
    expect(r.ok === false && r.reason).toBe('ID_CONFLICT');
  });

  it('删除类记录：被删段已不在当前配置 → 仍判定适用（方案字面谓词不可执行的等价口径）', () => {
    const before = makeConfig({
      segments: [
        makeSegment({ id: 'aaa000', start: 0, end: 10 }),
        makeSegment({ id: 'bbb111', start: 10, end: 20 }),
      ],
      sequence: ['aaa000', 'bbb111'],
    });
    const now = makeConfig({
      segments: [makeSegment({ id: 'aaa000', start: 0, end: 10 })],
      sequence: ['aaa000'],
    });
    const r = isEntryApplicable(entry({ kind: 'delete-segment', pre: canonicalize(before) }), now);
    expect(r.ok).toBe(true);
  });
});

describe('v0.3.3 · 项3：计数拆分（3-f）与容量护栏', () => {
  it('undoCounts：总条数按全部条目；可恢复条数排除置灰条目与恢复记录', () => {
    const stack = [
      entry({ id: 1 }),
      entry({ id: 2, kind: 'restore' }),
      entry({ id: 3, stale: true }),
    ];
    expect(undoCounts(stack)).toEqual({ total: 3, recoverable: 1 });
    expect(undoCounts([])).toEqual({ total: 0, recoverable: 0 });
  });

  it('容量护栏：超限条目不会把既有栈塌成 1 条（塌栈会吃掉用户已有历史）', () => {
    const big = entry({ id: 9, kind: 'restore', pre: 'x'.repeat(UNDO_ENTRY_MAX_BYTES) });
    expect(isUndoEntryOversized(big)).toBe(true);
    const kept = [entry({ id: 1 }), entry({ id: 2 })];
    const next = pushUndoEntry(kept, big);
    expect(next.length).toBe(3);
    expect(next.slice(0, 2).map((e) => e.id)).toEqual([1, 2]);
  });

  it('pushUndoEntry：链不连续 → 追加并标 chainBroken（第 2 个清栈点已消除）', () => {
    // 修正（v0.3.3 本轮）：原用例的 c0 / c1 由同一份 makeConfig() 生成，两个 canonical
    // 字符串完全相同，于是 newEntry.pre === top.post 成立、走的是「链连续」分支，
    // 永远测不到 chainBroken。这里把 c1 真正换成另一份配置（段区间 0–20，与 0–10 不同）。
    const c0 = canonicalize(makeConfig());
    const c1 = canonicalize(makeConfig({ segments: [makeSegment({ id: 'aaa000', start: 0, end: 20 })] }));
    const next = pushUndoEntry([entry({ id: 1, pre: c0, post: c1 })], entry({ id: 2, pre: c0, post: c1 }));
    expect(next.length).toBe(2); // 不塌栈：原栈保留 + 新条追加
    expect(next[0].id).toBe(1);
    expect(next[1].chainBroken).toBe(true); // pre(c0) ≠ top.post(c1) → 链不连续被标记
  });
});

describe('v0.3.3 · 项3：向后兼容（3-i）与清栈痕迹（3-d）', () => {
  it('旧代码（v0.3.2 解析器）读新栈不抛错、不丢条目（v 仍是 1）', () => {
    const payload = serializeUndoEntries(
      [
        entry({ id: 1 }),
        entry({ id: 2, kind: 'restore', reverse: true }),
        entry({ id: 3, chainBroken: true, invalidReason: '损坏标记' }),
      ],
      makeBreakRecord('broken', '测试痕迹', 2, 1700000000000),
    );
    let legacy: unknown[] = [];
    expect(() => {
      legacy = legacyParseUndoEntries(payload);
    }).not.toThrow();
    expect(legacy).toHaveLength(3);
    expect(parseUndoEntries(payload)).toHaveLength(3);
  });

  it('版本号不可升级：v=2 的载荷会被旧代码整栈丢弃（本批次只在 v1 内追加可选字段）', () => {
    const v2 = JSON.stringify({ v: 2, entries: [entry()] });
    expect(legacyParseUndoEntries(v2)).toHaveLength(0);
    expect(parseUndoEntries(v2)).toHaveLength(0);
  });

  it('parseUndoRecord：顶层 lastBreak 是可选字段，旧代码忽略之', () => {
    const raw = serializeUndoEntries([entry({ id: 1 })], makeBreakRecord('capacity', '超限', 1, 1700000000000));
    const rec = parseUndoRecord(raw);
    expect(rec.entries).toHaveLength(1);
    expect(rec.lastBreak).toEqual({ kind: 'capacity', reason: '超限', at: 1700000000000, dropped: 1 });
  });

  it('restoreUndoStack：单条损坏只置灰该条，其余保留（不再整栈丢弃）', () => {
    const c0 = canonicalize(makeConfig());
    const c1 = canonicalize(makeConfig({ segments: [makeSegment({ id: 'aaa000' })] }));
    const raw = serializeUndoEntries([
      entry({ id: 1, pre: c0, post: c1 }),
      entry({ id: 2, pre: 'not-json', post: c1 }),
    ]);
    const res = restoreUndoStack(raw, makeConfig({ segments: [makeSegment({ id: 'aaa000' })], sequence: ['aaa000'] }));
    expect(res.discarded).toBe(false);
    expect(res.damaged).toBe(1);
    expect(res.entries).toHaveLength(2);
    expect(res.entries[1].stale).toBe(true);
    expect(res.entries[1].invalidReason).toBeTruthy();
  });

  it('restoreUndoStack：带回上次会话的清栈痕迹（3-d 可追溯）', () => {
    const raw = serializeUndoEntries([], makeBreakRecord('broken', '换视频', 3, 1700000000000));
    const res = restoreUndoStack(raw, makeConfig());
    expect(res.lastBreak?.kind).toBe('broken');
    expect(res.lastBreak?.dropped).toBe(3);
  });
});
