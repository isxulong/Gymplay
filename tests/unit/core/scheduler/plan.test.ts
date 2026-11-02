import { describe, expect, it } from 'vitest';
import { compilePlan } from '../../../../src/core/scheduler/plan';
import { makeConfig, makeSegment } from '../../helpers';

describe('plan 编译（sequence 语义 · 定稿 §2.4）', () => {
  it('按 sequence 顺序编译，过滤 inQueue=false（勾选过滤）', () => {
    const cfg = makeConfig({
      segments: [
        makeSegment({ id: 'aaa000', start: 0, end: 10, rate: 1 }),
        makeSegment({ id: 'bbb111', start: 10, end: 20, rate: 2, inQueue: false }),
        makeSegment({ id: 'ccc222', start: 20, end: 30, rate: 0.5 }),
      ],
      sequence: ['ccc222', 'bbb111', 'aaa000'],
    });
    const plan = compilePlan(cfg);
    expect(plan.items.map((i) => i.segmentId)).toEqual(['ccc222', 'aaa000']);
    expect(plan.items[0].sequenceIndex).toBe(0);
    expect(plan.items[1].sequenceIndex).toBe(2);
  });

  it('重复段引用编译为独立队列项（同段练两遍）', () => {
    const cfg = makeConfig({
      segments: [makeSegment({ id: 'aaa000' })],
      sequence: ['aaa000', 'aaa000'],
    });
    const plan = compilePlan(cfg);
    expect(plan.items).toHaveLength(2);
    expect(plan.items[0].sequenceIndex).toBe(0);
    expect(plan.items[1].sequenceIndex).toBe(1);
  });

  it('防御分支：sequence 引用不存在的段 id → 跳过不崩溃（Schema 保证外的兜底）', () => {
    const cfg = makeConfig({
      segments: [makeSegment({ id: 'aaa000' })],
      sequence: ['aaa000', 'zzz999'],
    });
    const plan = compilePlan(cfg);
    expect(plan.items.map((i) => i.segmentId)).toEqual(['aaa000']);
  });

  it('空 sequence → 队列空（播放禁用）', () => {
    expect(compilePlan(makeConfig({ sequence: [] })).items).toHaveLength(0);
  });

  it('全部 inQueue=false → 队列空（播放禁用）', () => {
    const cfg = makeConfig({
      segments: [makeSegment({ id: 'aaa000', inQueue: false })],
      sequence: ['aaa000'],
    });
    expect(compilePlan(cfg).items).toHaveLength(0);
  });

  it('loop.count 仅 queue 模式进入 plan；其余归零', () => {
    const q = compilePlan(makeConfig({ loop: { mode: 'queue', count: 3 } }));
    expect(q.loop).toEqual({ mode: 'queue', count: 3 });
    const s = compilePlan(makeConfig({ loop: { mode: 'segment', count: 3 } }));
    expect(s.loop).toEqual({ mode: 'segment', count: 0 });
    const o = compilePlan(makeConfig({ loop: { mode: 'off' } }));
    expect(o.loop).toEqual({ mode: 'off', count: 0 });
  });

  it('loop.count 缺省 = 0（无限循环）', () => {
    const q = compilePlan(makeConfig({ loop: { mode: 'queue' } }));
    expect(q.loop.count).toBe(0);
  });
});
