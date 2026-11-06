/**
 * v0.3.3 · 项3：撤销栈字节护栏口径 + 配额渐进降容（实测鉴别用）。
 *
 * 为什么单开文件：`undo-store.test.ts` 里既有的两条用例锁定的正是**缺陷行为**
 * （「丢最旧重试 → 落盘只剩 1 条，返回 ok:true」），那是要改的对象。本文件用另一组
 * 构造（中文段名 / 字节刻度 / 10 条入参）重新定义正确口径，与旧文件分开存放，
 * 便于复核「新代码让旧行为变红」。
 *
 * 全部断言走仓库**真实**模块（`undoEntryBytes` / `isUndoEntryOversized` / `saveUndoStack`），
 * 不重写一份计算器；真实字节数一律用 `Buffer.byteLength(serializeUndoEntries([e]), 'utf8')` 独立求值。
 */

import { describe, it, expect } from 'vitest';
import {
  UNDO_ENTRY_MAX_BYTES,
  isUndoEntryOversized,
  saveUndoStack,
  serializeUndoEntries,
  undoEntryBytes,
  type UndoEntry,
  type UndoStorage,
} from '../../../src/app/undo-store';
import { canonicalize } from '../../../src/core/config/codec';
import type { PlayerConfig } from '../../../src/core/config/schema';

// 仓库未安装 @types/node（tsconfig 的 types 仅含 vite/client）：本文件用 Node **真实** 的
// Buffer.byteLength 独立求值 UTF-8 字节数（不经过被测函数，所以才叫「独立基准」）。
// 这里只补一条最小类型声明，不改 tsconfig、不新增运行依赖；运行期用的仍是 Node 原生 Buffer。
declare const Buffer: { byteLength(input: string, encoding?: string): number };

/**
 * 构造「段数 / 段名中文字符数」可控的配置。
 *
 * 中文是关键：UTF-8 一个汉字 3 字节，而 `String.length` 只算 1 个码元，
 * 两者差异随中文占比放大——这正是缺陷 A 的暴露面。
 */
function cjkConfig(count: number, labelChars: number): PlayerConfig {
  const segments = Array.from({ length: count }, (_, i) => ({
    id: `s${i.toString(36).padStart(5, '0')}`,
    start: i * 8,
    end: i * 8 + 8,
    rate: 1,
    label: '训'.repeat(labelChars),
    inQueue: true,
  }));
  return {
    v: 1,
    video: { type: 'local', filename: 'workout-cjk.mp4', duration: count * 8 + 80 },
    segments,
    sequence: segments.map((s) => s.id),
    loop: { mode: 'off' },
  };
}

/** 删除类条目：pre 有 count 段、post 少一段（与真实删除记录同形） */
function deleteEntry(count: number, labelChars: number, id = 1): UndoEntry {
  return {
    id,
    createdAt: 1700000000000,
    kind: 'delete-segment',
    segLabel: '训'.repeat(labelChars),
    pre: canonicalize(cjkConfig(count, labelChars)),
    post: canonicalize(cjkConfig(count - 1, labelChars)),
  };
}

/** 独立求值的真实 UTF-8 字节数（不经过被测函数） */
function realBytes(entry: UndoEntry): number {
  return Buffer.byteLength(serializeUndoEntries([entry]), 'utf8');
}

/** 体积很小的条目（用于配额场景：单条 ~800 B，10 条总量可控） */
function smallEntries(n: number): UndoEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    createdAt: 1700000000000 + i,
    kind: 'delete-segment' as const,
    segLabel: `段${i + 1}`,
    pre: canonicalize(cjkConfig(2, 2)),
    post: canonicalize(cjkConfig(1, 2)),
  }));
}

/** 首次 setItem 抛配额错误、之后放行的存储 */
function quotaFirstThenOk(): UndoStorage & { calls: number; last: string } {
  const self = {
    calls: 0,
    last: '',
    getItem: () => null,
    setItem: (_k: string, v: string) => {
      self.calls += 1;
      if (self.calls === 1) throw new Error('QuotaExceededError');
      self.last = v;
    },
    removeItem: () => {},
  };
  return self as UndoStorage & { calls: number; last: string };
}

/** 按 UTF-8 体积拒绝写入的存储（比「第一次就抛」更接近真实配额行为） */
function byteCapStorage(capacity: number): UndoStorage & { calls: number; last: string } {
  const self = {
    calls: 0,
    last: '',
    getItem: () => null,
    setItem: (_k: string, v: string) => {
      self.calls += 1;
      if (Buffer.byteLength(v, 'utf8') > capacity) throw new Error('QuotaExceededError');
      self.last = v;
    },
    removeItem: () => {},
  };
  return self as UndoStorage & { calls: number; last: string };
}

function persistedCount(storage: { last: string }): number {
  return storage.last ? (JSON.parse(storage.last) as { entries: unknown[] }).entries.length : 0;
}

describe('v0.3.3 · 项3：字节护栏口径必须是 UTF-8 字节（缺陷 A）', () => {
  it('中文段名条目：undoEntryBytes 等于真实 UTF-8 字节数，且 med 组被判超限', () => {
    // 340 段 / 段名 20 个汉字：报告值与真实值差 2 万字节以上，口径错误一眼可见
    const big = deleteEntry(340, 20);
    const reportedBig = undoEntryBytes(big);
    const realBig = realBytes(big);
    expect(
      reportedBig,
      `340 段条目：undoEntryBytes=${reportedBig} 与真实 UTF-8=${realBig} 不一致（差值 ${realBig - reportedBig} B）`,
    ).toBe(realBig);

    // med 组（230 段 / 14 汉字）：旧口径报 53,102 B（判「未超」），真实 65,960 B（已超）
    const med = deleteEntry(230, 14);
    const reportedMed = undoEntryBytes(med);
    const realMed = realBytes(med);
    expect(
      reportedMed,
      `230 段条目：undoEntryBytes=${reportedMed} 与真实 UTF-8=${realMed} 不一致（差值 ${realMed - reportedMed} B）`,
    ).toBe(realMed);
    // 若口径正确，这条必然超限：真实字节越过了 65,536
    expect(
      realMed,
      `前提自证：230 段条目真实体积 ${realMed} B 必须超过上限 ${UNDO_ENTRY_MAX_BYTES} B`,
    ).toBeGreaterThan(UNDO_ENTRY_MAX_BYTES);
    expect(
      isUndoEntryOversized(med),
      `230 段条目真实 ${realMed} B 已超上限 ${UNDO_ENTRY_MAX_BYTES} B，必须判为超限（旧口径报 ${reportedMed} B 放行）`,
    ).toBe(true);
  });
});

describe('v0.3.3 · 项3：判定分界落在字节边界（缺陷 A 的边界）', () => {
  it('刚好不到 / 刚好超过的相邻刻度：分界严格落在 65,536 B 上', () => {
    // 刻度按**真实字节数**选取：228 段与 229 段各自实测，不按字符数推算
    const under = deleteEntry(228, 14);
    const over = deleteEntry(229, 14);
    const bUnder = realBytes(under);
    const bOver = realBytes(over);

    // 前提自证：这两个刻度必须真的夹住上限，且步长远小于上限（否则「分界在字节边界」无从谈起）
    expect(bUnder, `下刻度真实 ${bUnder} B 应 ≤ 上限 ${UNDO_ENTRY_MAX_BYTES} B`).toBeLessThanOrEqual(
      UNDO_ENTRY_MAX_BYTES,
    );
    expect(bOver, `上刻度真实 ${bOver} B 应 > 上限 ${UNDO_ENTRY_MAX_BYTES} B`).toBeGreaterThan(
      UNDO_ENTRY_MAX_BYTES,
    );
    expect(
      bOver - bUnder,
      `两刻度间距 ${bOver - bUnder} B，应小于上限的一半（真实删除记录的段间增量约 232–288 B）`,
    ).toBeLessThan(UNDO_ENTRY_MAX_BYTES / 2);

    // 被测函数的报告值必须等于真实字节数
    expect(undoEntryBytes(under), `下刻度 228 段：报告值应为真实 ${bUnder} B`).toBe(bUnder);
    expect(undoEntryBytes(over), `上刻度 229 段：报告值应为真实 ${bOver} B`).toBe(bOver);

    // 分界：不到上限的放行、越过上限的拦下，判据是字节
    expect(
      isUndoEntryOversized(under),
      `228 段实测 ${bUnder} B ≤ ${UNDO_ENTRY_MAX_BYTES} B，应放行`,
    ).toBe(false);
    expect(
      isUndoEntryOversized(over),
      `229 段实测 ${bOver} B > ${UNDO_ENTRY_MAX_BYTES} B，应拦下（差 ${bOver - UNDO_ENTRY_MAX_BYTES} B）`,
    ).toBe(true);
  });
});

describe('v0.3.3 · 项3：配额失败后是渐进降容，不是一步砍到 1 条（缺陷 B）', () => {
  it('入参 10 条、首次写入抛配额错误：落盘条数 > 1，且 dropped 等于实际减少条数', () => {
    const entries = smallEntries(10);
    const storage = quotaFirstThenOk();
    const res = saveUndoStack(entries, storage);

    expect(
      res.ok,
      `还有容量可用（降容后能写进），结果应为 ok；实际 ${JSON.stringify(res)}`,
    ).toBe(true);
    if (res.ok) {
      const persisted = persistedCount(storage);
      // 核心断言：不能一步砍成 1 条
      expect(
        persisted,
        `入参 ${entries.length} 条撞配额后落盘 ${persisted} 条——必须 > 1，否则仍是一次配额失败就抹掉整段历史`,
      ).toBeGreaterThan(1);
      // dropped 必须等于「入参条数 - 实际落盘条数」，不得只报 ok 而隐瞒丢弃
      expect(
        res.dropped,
        `返回值 dropped=${res.dropped} 应等于实际减少条数 ${entries.length - persisted}（入参 ${entries.length}、落盘 ${persisted}）`,
      ).toBe(entries.length - persisted);
    }
  });

  it('按字节容量拒绝（容量约等于一半体积）：按需丢弃最旧，保留能容纳的最大条数', () => {
    const entries = smallEntries(10);
    const fullBytes = Buffer.byteLength(serializeUndoEntries(entries), 'utf8');
    // 容量设为整栈体积的一半：应当能写下约一半条目，而不是 1 条
    const capacity = Math.floor(fullBytes * 0.5);
    const storage = byteCapStorage(capacity);
    const res = saveUndoStack(entries, storage);

    expect(res.ok, `容量 ${capacity} B 下应能写进部分条目；实际 ${JSON.stringify(res)}`).toBe(true);
    if (res.ok) {
      const persisted = persistedCount(storage);
      expect(
        persisted,
        `容量 ${capacity} B / 整栈 ${fullBytes} B：落盘 ${persisted} 条（应为 ${entries.length} 条的一半量级，而非 1 条）`,
      ).toBeGreaterThan(1);
      expect(
        res.dropped,
        `dropped=${res.dropped} 应等于实际减少条数 ${entries.length - persisted}`,
      ).toBe(entries.length - persisted);
      // 保留的是**最新**的若干条（丢最旧语义不变）
      const kept = (JSON.parse(storage.last) as { entries: { id: number }[] }).entries;
      expect(kept.map((e) => e.id)).toEqual(
        entries.slice(entries.length - persisted).map((e) => e.id),
      );
      // 落盘体积确实没超容量（说明二分求出的是最大可行解，不是随手砍一半）
      expect(
        Buffer.byteLength(storage.last, 'utf8'),
        `落盘体积 ${Buffer.byteLength(storage.last, 'utf8')} B 应 ≤ 容量 ${capacity} B`,
      ).toBeLessThanOrEqual(capacity);
    }
  });
});
