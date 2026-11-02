/**
 * L3 配置编辑操作单测（M1 编辑器内核）。
 * 覆盖：初始配置、打点切分、起止编辑、重命名、设速、删除、勾选、
 * 队列排序/重复/移除、循环设置、时长钳制（F8 AC5）。
 */

import { describe, expect, it } from 'vitest';
import {
  MIN_SEGMENT_DURATION,
  clampConfigToDuration,
  createInitialConfig,
  deleteSegment,
  duplicateSequenceEntry,
  moveSequenceEntry,
  newSegmentId,
  removeSequenceEntry,
  renameSegment,
  setInQueue,
  setLoop,
  setSegmentRate,
  splitSegmentAt,
  updateSegmentBounds,
} from '../../../../src/core/config/edit';
import { SEGMENT_ID_PATTERN, validate, type PlayerConfig } from '../../../../src/core/config/schema';

/** 固定 id 序列发生器，让测试确定。 */
function fixedRand(seq: number[]): () => number {
  let i = 0;
  return () => seq[i++ % seq.length];
}

function baseConfig(): PlayerConfig {
  // 三段：[0,2]@1、[2,5]@2、[5,10]@0.5；sequence 含重复引用 bbbb02
  return {
    v: 1,
    video: { type: 'local', filename: 'a.mp4', duration: 10 },
    segments: [
      { id: 'aaaa01', start: 0, end: 2, rate: 1, label: '热身', inQueue: true },
      { id: 'bbbb02', start: 2, end: 5, rate: 2, label: '', inQueue: true },
      { id: 'cccc03', start: 5, end: 10, rate: 0.5, label: '', inQueue: false },
    ],
    sequence: ['aaaa01', 'bbbb02', 'bbbb02', 'cccc03'], // 中间两项同段 = 重复段
    loop: { mode: 'off' },
  };
}

function makeCfg(): PlayerConfig {
  return baseConfig();
}

describe('newSegmentId', () => {
  it('产出 6 位 base36 且避开已占用 id', () => {
    const taken = new Set(['000000']);
    // rand 全 0 → 第一次生成 000000 被占用，第二次仍 000000？验证重试：
    // 用递增值避免死循环：第一次 000000（占用），第二次 111111
    const id = newSegmentId(taken, fixedRand([0, 0, 0, 0, 0, 0, 1 / 36 + 0.001, 0, 0, 0, 0, 0]));
    expect(id).toMatch(SEGMENT_ID_PATTERN);
    expect(taken.has(id)).toBe(false);
  });
});

describe('createInitialConfig', () => {
  it('生成单个全片段且通过 schema 校验', () => {
    const cfg = createInitialConfig({ filename: 'v.mp4', duration: 12.5 }, { createdAt: '2026-11-02T00:00:00Z' });
    expect(cfg.segments).toHaveLength(1);
    expect(cfg.segments[0].start).toBe(0);
    expect(cfg.segments[0].end).toBe(12.5);
    expect(cfg.segments[0].rate).toBe(1);
    expect(cfg.sequence).toEqual([cfg.segments[0].id]);
    expect(cfg.loop.mode).toBe('off');
    expect(cfg.meta?.createdAt).toBe('2026-11-02T00:00:00Z');
    expect(validate(cfg).ok).toBe(true);
  });

  it('无 meta 时不带 meta 字段', () => {
    const cfg = createInitialConfig({ filename: 'v.mp4', duration: 3 });
    expect(cfg.meta).toBeUndefined();
  });
});

describe('splitSegmentAt（F3 AC1）', () => {
  it('以播放头为界切出两段，sequence 原位替换（重复引用每处展开）', () => {
    const cfg = makeCfg();
    const res = splitSegmentAt(cfg, 3, fixedRand([0.5]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ids = res.value.segments.map((s) => s.id);
    expect(res.value.segments).toHaveLength(4);
    // 原 bbbb02 [2,5] 切成 [2,3] + [3,5]
    const left = res.value.segments.find((s) => s.id === 'bbbb02')!;
    const right = res.value.segments[ids.indexOf('bbbb02') + 1];
    expect([left.start, left.end]).toEqual([2, 3]);
    expect([right.start, right.end]).toEqual([3, 5]);
    expect(right.rate).toBe(2); // 继承 rate
    expect(right.label).toBe('');
    // sequence：两处 bbbb02 都展开
    expect(res.value.sequence).toEqual(['aaaa01', 'bbbb02', right.id, 'bbbb02', right.id, 'cccc03']);
    expect(validate(res.value).ok).toBe(true);
  });

  it('位置恰在段边界 → AT_BOUNDARY', () => {
    const res = splitSegmentAt(makeCfg(), 2);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('AT_BOUNDARY');
  });

  it('位置不在任何段内 → OUT_OF_RANGE', () => {
    // 构造有空洞的配置：段 [0,2] 与 [5,10]，在 3 处打点
    const cfg = makeCfg();
    cfg.segments[1].start = 5;
    cfg.segments[1].end = 8;
    cfg.segments[2].start = 8;
    const res = splitSegmentAt(cfg, 3);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('OUT_OF_RANGE');
  });

  it('距边界过近 → TOO_SHORT', () => {
    const cfg = makeCfg();
    const res = splitSegmentAt(cfg, 2 + MIN_SEGMENT_DURATION / 2);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('TOO_SHORT');
  });

  it('不可变更新：原配置不被改写', () => {
    const cfg = makeCfg();
    splitSegmentAt(cfg, 3);
    expect(cfg.segments).toHaveLength(3);
    expect(cfg.segments[1].end).toBe(5);
  });
});

describe('updateSegmentBounds（F3 AC2/AC3）', () => {
  it('合法调整生效且段顺序不变', () => {
    const res = updateSegmentBounds(makeCfg(), 'bbbb02', 2.5, 4.5);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const seg = res.value.segments.find((s) => s.id === 'bbbb02')!;
    expect([seg.start, seg.end]).toEqual([2.5, 4.5]);
    expect(res.value.segments.map((s) => s.id)).toEqual(['aaaa01', 'bbbb02', 'cccc03']);
  });

  it('与其他段重叠 → OVERLAP；端点相接合法', () => {
    expect(updateSegmentBounds(makeCfg(), 'bbbb02', 1, 4).ok).toBe(false); // 与 aaaa01 重叠
    const res = updateSegmentBounds(makeCfg(), 'bbbb02', 2, 5);
    expect(res.ok).toBe(true); // 原样也合法（相接）
    const touch = updateSegmentBounds(makeCfg(), 'aaaa01', 0, 2);
    expect(touch.ok).toBe(true);
  });

  it('越界 / 倒挂 / 过短 / 段不存在分别报错', () => {
    expect(updateSegmentBounds(makeCfg(), 'bbbb02', -1, 4).ok).toBe(false);
    expect(updateSegmentBounds(makeCfg(), 'bbbb02', 4, 2).ok).toBe(false);
    expect(updateSegmentBounds(makeCfg(), 'bbbb02', 2, 11).ok).toBe(false);
    const tooShort = updateSegmentBounds(makeCfg(), 'bbbb02', 2, 2 + MIN_SEGMENT_DURATION / 2);
    expect(tooShort.ok).toBe(false);
    if (!tooShort.ok) expect(tooShort.error.code).toBe('TOO_SHORT');
    const missing = updateSegmentBounds(makeCfg(), 'zzzz99', 0, 1);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('NOT_FOUND');
    // NaN
    expect(updateSegmentBounds(makeCfg(), 'bbbb02', Number.NaN, 4).ok).toBe(false);
  });
});

describe('renameSegment / setSegmentRate', () => {
  it('重命名与 30 字截断', () => {
    const res = renameSegment(makeCfg(), 'aaaa01', 'x'.repeat(40));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.segments[0].label).toHaveLength(30);
    expect(renameSegment(makeCfg(), 'zzzz99', 'a').ok).toBe(false);
  });

  it('设速并钳制进 [0.5, 4]', () => {
    const r1 = setSegmentRate(makeCfg(), 'aaaa01', 8);
    expect(r1.ok && r1.value.segments[0].rate).toBe(4);
    const r2 = setSegmentRate(makeCfg(), 'aaaa01', 0.1);
    expect(r2.ok && r2.value.segments[0].rate).toBe(0.5);
    expect(setSegmentRate(makeCfg(), 'zzzz99', 1).ok).toBe(false);
  });
});

describe('deleteSegment（F3 AC2 v2：边界不变、队列移除）', () => {
  it('删除后其余段起止不变、sequence 引用全部移除', () => {
    const res = deleteSegment(makeCfg(), 'bbbb02');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.segments.map((s) => s.id)).toEqual(['aaaa01', 'cccc03']);
    expect(res.value.segments[0].end).toBe(2);
    expect(res.value.segments[1].start).toBe(5); // 不留空洞也不自动相接
    expect(res.value.sequence).toEqual(['aaaa01', 'cccc03']);
    expect(validate(res.value).ok).toBe(true);
  });

  it('最后一段不可删', () => {
    const cfg = createInitialConfig({ filename: 'v.mp4', duration: 5 });
    const res = deleteSegment(cfg, cfg.segments[0].id);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('LAST_SEGMENT');
    expect(deleteSegment(makeCfg(), 'zzzz99').ok).toBe(false);
  });
});

describe('setInQueue（F5 AC1）', () => {
  it('翻转 inQueue，sequence 不动', () => {
    const res = setInQueue(makeCfg(), 'bbbb02', false);
    expect(res.ok && res.value.segments[1].inQueue).toBe(false);
    expect(res.ok && res.value.sequence).toEqual(['aaaa01', 'bbbb02', 'bbbb02', 'cccc03']);
    expect(setInQueue(makeCfg(), 'zzzz99', true).ok).toBe(false);
  });
});

describe('sequence 队列操作', () => {
  it('moveSequenceEntry 移动位置', () => {
    const res = moveSequenceEntry(makeCfg(), 0, 2);
    expect(res.ok && res.value.sequence).toEqual(['bbbb02', 'bbbb02', 'aaaa01', 'cccc03']);
  });

  it('moveSequenceEntry 下标越界报错', () => {
    expect(moveSequenceEntry(makeCfg(), -1, 0).ok).toBe(false);
    expect(moveSequenceEntry(makeCfg(), 0, 4).ok).toBe(false);
    expect(moveSequenceEntry(makeCfg(), 0.5, 1).ok).toBe(false);
  });

  it('duplicateSequenceEntry 在原地后插入同段引用', () => {
    const res = duplicateSequenceEntry(makeCfg(), 0);
    expect(res.ok && res.value.sequence).toEqual(['aaaa01', 'aaaa01', 'bbbb02', 'bbbb02', 'cccc03']);
    expect(duplicateSequenceEntry(makeCfg(), 9).ok).toBe(false);
  });

  it('removeSequenceEntry 移除单个引用且段保留', () => {
    const res = removeSequenceEntry(makeCfg(), 1);
    expect(res.ok && res.value.sequence).toEqual(['aaaa01', 'bbbb02', 'cccc03']);
    expect(res.ok && res.value.segments).toHaveLength(3);
    expect(removeSequenceEntry(makeCfg(), -1).ok).toBe(false);
  });
});

describe('setLoop', () => {
  it('queue 模式带正整数 count', () => {
    const res = setLoop(makeCfg(), 'queue', 3.9);
    expect(res.ok && res.value.loop).toEqual({ mode: 'queue', count: 3 });
  });

  it('queue 模式 0/缺省 = 无限（不写字段）；off/segment 忽略 count', () => {
    const r0 = setLoop(makeCfg(), 'queue', 0);
    expect(r0.ok && r0.value.loop).toEqual({ mode: 'queue' });
    const rUndef = setLoop(makeCfg(), 'queue');
    expect(rUndef.ok && rUndef.value.loop).toEqual({ mode: 'queue' });
    const rOff = setLoop(makeCfg(), 'off', 5);
    expect(rOff.ok && rOff.value.loop).toEqual({ mode: 'off' });
    const rSeg = setLoop(makeCfg(), 'segment');
    expect(rSeg.ok && rSeg.value.loop).toEqual({ mode: 'segment' });
  });
});

describe('clampConfigToDuration（F8 AC5：钳制不缩放）', () => {
  it('端点越界钳到实际时长、整段越界移除、sequence 同步清理', () => {
    const cfg = makeCfg(); // duration 10
    const { config, adjusted, dropped } = clampConfigToDuration(cfg, 6);
    expect(adjusted).toBe(1); // cccc03 [5,10] → [5,6]
    expect(dropped).toBe(0);
    expect(config.segments.find((s) => s.id === 'cccc03')!.end).toBe(6);
    expect(config.video.duration).toBe(6);
    expect(validate(config).ok).toBe(true);
  });

  it('整段越界被移除且引用清理', () => {
    const cfg = makeCfg();
    const { config, dropped } = clampConfigToDuration(cfg, 4); // cccc03 [5,10] 整段越界
    expect(dropped).toBe(1);
    expect(config.segments.map((s) => s.id)).toEqual(['aaaa01', 'bbbb02']);
    expect(config.sequence).toEqual(['aaaa01', 'bbbb02', 'bbbb02']);
  });

  it('时长一致时零调整', () => {
    const { adjusted, dropped } = clampConfigToDuration(makeCfg(), 10);
    expect(adjusted).toBe(0);
    expect(dropped).toBe(0);
  });

  it('边界：段起点恰等于实际时长视为整段越界', () => {
    const { dropped } = clampConfigToDuration(makeCfg(), 5); // cccc03 start=5
    expect(dropped).toBe(1);
  });
});
