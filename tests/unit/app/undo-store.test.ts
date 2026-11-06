/**
 * v0.3.2 · 项2+10 单测：撤销世界线栈（undo-store 纯逻辑层）。
 *
 * 覆盖方案 v1.1 · 项2+10「测试影响」要求的口径：
 * 连续性 / 截断 / 栈顶门禁 / 降级 / 容量 / 持久化 round-trip；
 * 草稿态不落盘属 controller 接线行为，在 undo-controller.test.ts 覆盖。
 */

import { describe, it, expect } from 'vitest';
import {
  UNDO_STORAGE_KEY,
  UNDO_CAP,
  parseUndoEntries,
  serializeUndoEntries,
  loadUndoStack,
  saveUndoStack,
  topEntry,
  undoGate,
  pushUndoEntry,
  markStaleFrom,
  markAllStale,
  activeUndoEntries,
  topActiveDeletion,
  restoreUndoStack,
  undoEntryBytes,
  UNDO_ENTRY_MAX_BYTES,
  type UndoEntry,
  type UndoStorage,
} from '../../../src/app/undo-store';
import { canonicalize } from '../../../src/core/config/codec';
import { makeConfig, makeSegment } from '../helpers';

function entry(partial: Partial<UndoEntry> = {}): UndoEntry {
  return {
    id: partial.id ?? 1,
    createdAt: partial.createdAt ?? Date.now(),
    kind: partial.kind ?? 'delete-segment',
    segLabel: partial.segLabel ?? '热身',
    pre: partial.pre ?? canonicalize(makeConfig()),
    post: partial.post ?? canonicalize(makeConfig()),
  };
}

function memoryStorage(initial: Record<string, string> = {}): UndoStorage & { dump(): Record<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
    dump: () => Object.fromEntries(map),
  };
}

/** 拒绝写入的存储（模拟隐私模式 / 配额写满且丢最旧仍失败） */
function throwingStorage(): UndoStorage {
  return {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {},
  };
}

describe('v0.3.2 · 项2+10：undo-store 序列化与解析', () => {
  it('round-trip：serialize → parse 逐字段一致', () => {
    const entries = [entry({ id: 1 }), entry({ id: 2, kind: 'remove-entry', stale: true })];
    const back = parseUndoEntries(serializeUndoEntries(entries));
    expect(back).toEqual(entries);
  });

  it('损坏 JSON / 非 JSON → 空栈', () => {
    expect(parseUndoEntries('not json')).toEqual([]);
    expect(parseUndoEntries(null)).toEqual([]);
  });

  it('版本不符（v≠1）→ 空栈（结构漂移防护）', () => {
    expect(parseUndoEntries(JSON.stringify({ v: 2, entries: [entry()] }))).toEqual([]);
  });

  it('结构不合法的条目被过滤，合法条目保留', () => {
    const raw = JSON.stringify({
      v: 1,
      entries: [
        { id: 'x', createdAt: 'no', kind: 'weird', segLabel: 1, pre: 2, post: 3 },
        entry({ id: 7 }),
      ],
    });
    const back = parseUndoEntries(raw);
    expect(back.length).toBe(1);
    expect(back[0].id).toBe(7);
  });

  it('loadUndoStack 经注入存储读取；saveUndoStack 写入后可读回', () => {
    const storage = memoryStorage();
    const entries = [entry({ id: 3 })];
    // v0.3.3 · 项3：返回值扩展为 { ok: true, dropped }——dropped=0 表示整栈原样落盘，无丢弃
    expect(saveUndoStack(entries, storage)).toEqual({ ok: true, dropped: 0 });
    expect(loadUndoStack(storage)).toEqual(entries);
    expect(storage.dump()[UNDO_STORAGE_KEY]).toBe(serializeUndoEntries(entries));
  });
});

describe('v0.3.2 · 项2+10：push 链式规则（规则 1）', () => {
  it('栈空 → 追加', () => {
    const next = pushUndoEntry([], entry({ id: 1 }));
    expect(next.length).toBe(1);
    expect(next[0].id).toBe(1);
  });

  it('newEntry.pre === top.post → 链式追加', () => {
    const c0 = canonicalize(makeConfig());
    const c1 = canonicalize(makeConfig({ segments: [makeSegment({ id: 'aaa000' })] }));
    const next = pushUndoEntry([entry({ id: 1, pre: c0, post: c1 })], entry({ id: 2, pre: c1, post: c0 }));
    expect(next.length).toBe(2);
  });

  it('pre !== top.post（世界线断裂）→ 清栈重启', () => {
    // v0.3.3 · 项3 · 断言反转（旧期望：整栈塌成 1 条）。
    // 反转理由：塌栈是方案漏掉的**第 2 个清栈点**（pushUndoEntry 内部 chainOk 不成立时
    // 用 [entry] 整栈替换），它把「一次不入栈的编辑」放大成「全部历史消失」，与项3 目的冲突。
    // 新语义：追加并标记 chainBroken（链不连续可追溯），原栈原样保留。
    const c0 = canonicalize(makeConfig());
    const c1 = canonicalize(makeConfig({ segments: [makeSegment({ id: 'aaa000' }), makeSegment({ id: 'bbb111' })] }));
    const next = pushUndoEntry([entry({ id: 1, pre: c0, post: c1 })], entry({ id: 2, pre: c0, post: c1 }));
    expect(next.length).toBe(2);
    expect(next[0].id).toBe(1); // 原栈保留
    expect(next[1].id).toBe(2); // 新条追加
    expect(next[1].chainBroken).toBe(true); // 链不连续被标记（旧代码忽略该可选字段）
  });

  it('restore 类豁免链式条件（连按 undo 连续回退可行）', () => {
    const c0 = canonicalize(makeConfig());
    const c1 = canonicalize(makeConfig({ segments: [makeSegment({ id: 'aaa000' })] }));
    const c2 = canonicalize(makeConfig({ segments: [] , sequence: [] }));
    const stack = [
      entry({ id: 1, pre: c0, post: c1 }),
      entry({ id: 2, pre: c1, post: c2 }),
    ];
    // 恢复记录：pre=恢复前(c2)，post=恢复目标(c0)——与 top.post(c2) 不构成链，但豁免
    const next = pushUndoEntry(stack, entry({ id: 3, kind: 'restore', pre: c2, post: c0 }));
    expect(next.length).toBe(3);
    expect(topEntry(next)?.post).toBe(c0);
  });

  it('容量上限 UNDO_CAP=10：超出丢最旧', () => {
    let stack: UndoEntry[] = [];
    for (let i = 1; i <= 12; i += 1) {
      stack = pushUndoEntry(stack, entry({ id: i, kind: 'restore', pre: `p${i}`, post: `q${i}` }));
    }
    expect(stack.length).toBe(UNDO_CAP);
    expect(stack[0].id).toBe(3);
    expect(stack[stack.length - 1].id).toBe(12);
  });

  it('单条序列化 > 64KB → 降容为 1 条（字节护栏）', () => {
    // v0.3.3 · 项3 · 断言反转（旧期望：整栈塌成 1 条）。
    // 反转理由：架构师实测「超限时 pushUndoEntry 把整个栈塌成 1 条（实测 2→1）」——
    // 这与项3 的目的（保住用户已有的撤销历史）直接冲突。
    // 新语义：pushUndoEntry 不再做容量塌栈；超限条目由 controller 层拒收（不入栈），
    // 原栈原样保留（拒收路径见 undo-integration.test.ts 的容量用例）。
    const big = entry({ id: 1, kind: 'restore', pre: 'x'.repeat(UNDO_ENTRY_MAX_BYTES) });
    expect(undoEntryBytes(big)).toBeGreaterThan(UNDO_ENTRY_MAX_BYTES);
    const next = pushUndoEntry([entry({ id: 0 })], big);
    expect(next.length).toBe(2);
    expect(next[0].id).toBe(0); // 原栈保留
    expect(next[1].id).toBe(1); // 超限条目本身不被静默替换掉
  });
});

describe('v0.3.2 · 项2+10：截断与门禁（规则 3 / 4）', () => {
  it('markStaleFrom：从下标起置灰，之前的保持可恢复', () => {
    const stack = [entry({ id: 1 }), entry({ id: 2 }), entry({ id: 3 })];
    const next = markStaleFrom(stack, 1);
    expect(next[0].stale).toBeUndefined();
    expect(next[1].stale).toBe(true);
    expect(next[2].stale).toBe(true);
    // 幂等：已置灰不再重复包装
    const again = markStaleFrom(next, 1);
    expect(again).toEqual(next);
  });

  it('markAllStale / activeUndoEntries / topActiveDeletion', () => {
    const stack = [
      entry({ id: 1 }),
      entry({ id: 2, kind: 'restore' }),
      entry({ id: 3, kind: 'remove-entry' }),
    ];
    expect(topActiveDeletion(stack)?.id).toBe(3);
    expect(activeUndoEntries(stack).length).toBe(3);
    const grey = markAllStale(stack);
    expect(grey.every((e) => e.stale === true)).toBe(true);
    expect(topActiveDeletion(grey)).toBeNull();
    expect(activeUndoEntries(grey).length).toBe(0);
  });

  it('undoGate：top.post === 当前 canonical 才放行', () => {
    const c0 = canonicalize(makeConfig());
    const c1 = canonicalize(makeConfig({ loop: { mode: 'queue', count: 3 } }));
    const stack = [entry({ id: 1, pre: c0, post: c1 })];
    expect(undoGate(stack, c1)).toBe(true);
    expect(undoGate(stack, c0)).toBe(false);
    expect(undoGate([], c1)).toBe(false);
    expect(undoGate(stack, null)).toBe(false);
  });
});

describe('v0.3.2 · 项2+10：存储降级（规则 6）', () => {
  it('写入抛异常且丢最旧仍失败 → { ok:false, degraded:true }', () => {
    const res = saveUndoStack([entry({ id: 1 }), entry({ id: 2 })], throwingStorage());
    expect(res).toEqual({ ok: false, degraded: true });
  });

  it('无存储（undefined）→ degraded', () => {
    expect(saveUndoStack([entry()])).toEqual({ ok: false, degraded: true });
  });

  it('QuotaExceeded → 渐进降容，仅丢最旧的必要条数并回报 dropped', () => {
    // v0.3.3 · 项3 · 断言反转（旧期望：res == { ok:true }、栈只剩最新一条落盘）。
    // 反转理由：旧实现 `entries.slice(entries.length - 1)` 一次配额失败就从 10 条砍到 1 条，
    // 且返回 ok:true 不含任何丢弃信息——正是项3 要消除的「静默丢历史」。
    // 新语义：按需从最旧一侧逐步丢弃（二分求最大可行保留数），并把丢弃条数回报给调用方。
    let calls = 0;
    const storage: UndoStorage = {
      getItem: () => null,
      setItem: (_k, v) => {
        calls += 1;
        if (calls === 1) throw new Error('QuotaExceededError');
        written = v;
      },
      removeItem: () => {},
    };
    let written = '';
    // 入参 10 条（栈容量上限）：首次写入撞配额后，不能一步砍成 1 条
    const many = Array.from({ length: UNDO_CAP }, (_, i) => entry({ id: i + 1 }));
    const res = saveUndoStack(many, storage);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const persisted = parseUndoEntries(written);
      expect(persisted.length).toBeGreaterThan(1);
      expect(persisted.length).toBeLessThanOrEqual(UNDO_CAP);
      // 丢弃条数必须等于实际减少量，调用方据此提示用户
      expect(res.dropped).toBe(many.length - persisted.length);
      // 丢最旧语义不变：保留的是末尾若干条
      expect(persisted.map((e) => e.id)).toEqual(
        many.slice(many.length - persisted.length).map((e) => e.id),
      );
    }
  });
});

describe('v0.3.2 · 项2+10：启动恢复（规则 5）', () => {
  it('逐条合法 + 栈顶世界线匹配 → 保留整栈', () => {
    const c0 = canonicalize(makeConfig());
    const cfgMid = makeConfig({ segments: [makeSegment({ id: 'aaa000' })] });
    const c1 = canonicalize(cfgMid);
    const raw = serializeUndoEntries([entry({ id: 1, pre: c0, post: c1 })]);
    const res = restoreUndoStack(raw, cfgMid);
    expect(res.discarded).toBe(false);
    expect(res.entries.length).toBe(1);
  });

  it('条目 pre 非法（校验失败）→ 整栈丢弃', () => {
    const raw = serializeUndoEntries([entry({ id: 1, pre: '{"v":99}' })]);
    const res = restoreUndoStack(raw, makeConfig());
    expect(res.discarded).toBe(true);
    expect(res.entries).toEqual([]);
  });

  it('条目 pre 非法 JSON → 整栈丢弃', () => {
    const raw = serializeUndoEntries([entry({ id: 1, pre: 'not-json' })]);
    expect(restoreUndoStack(raw, makeConfig()).discarded).toBe(true);
  });

  it('栈顶世界线失配 → 整栈丢弃（数据层兜底）', () => {
    const c0 = canonicalize(makeConfig());
    const c1 = canonicalize(makeConfig({ loop: { mode: 'queue', count: 2 } }));
    const raw = serializeUndoEntries([entry({ id: 1, pre: c0, post: c1 })]);
    // 当前是 c0 而非栈顶 post c1 → 失配
    expect(restoreUndoStack(raw, makeConfig()).discarded).toBe(true);
  });

  it('当前无配置（null）→ 整栈丢弃', () => {
    const raw = serializeUndoEntries([entry()]);
    expect(restoreUndoStack(raw, null).discarded).toBe(true);
  });

  it('空栈 / 空载体 → 不丢弃、空栈', () => {
    // v0.3.3 · 项3 · 断言反转（旧期望只有两个字段）。
    // 反转理由：返回值新增两个**追加字段**——lastBreak（清栈痕迹，判据 3-d）与
    // damaged（按条置灰的条数）；旧字段 entries / discarded 语义不变。
    expect(restoreUndoStack(null, makeConfig())).toEqual({ entries: [], discarded: false, lastBreak: null, damaged: 0 });
    expect(restoreUndoStack(serializeUndoEntries([]), makeConfig())).toEqual({ entries: [], discarded: false, lastBreak: null, damaged: 0 });
  });
});
