import { describe, expect, it, vi } from 'vitest';
import type { PlayerConfig } from '../../../../src/core/config/schema';
import { compilePlan } from '../../../../src/core/scheduler/plan';
import { SegmentScheduler } from '../../../../src/core/scheduler/scheduler';
import { FakeClock } from '../../fakes/fake-clock';
import { FakeEngine } from '../../fakes/fake-engine';
import { makeConfig, makeSegment } from '../../helpers';

/** 两段基准配置：aaa 0~10s @1x，bbb 10~20s @2x */
function twoSegmentConfig(overrides: Partial<PlayerConfig> = {}): PlayerConfig {
  return makeConfig({
    segments: [
      makeSegment({ id: 'aaa000', start: 0, end: 10, rate: 1, label: '热身' }),
      makeSegment({ id: 'bbb111', start: 10, end: 20, rate: 2, label: '冲刺' }),
    ],
    sequence: ['aaa000', 'bbb111'],
    loop: { mode: 'off' },
    ...overrides,
  });
}

function setup(cfg: PlayerConfig, opts: { driver?: 'auto' | 'rvfc' | 'polling'; rVFC?: boolean } = {}) {
  const engine = new FakeEngine();
  const clock = new FakeClock();
  const plan = compilePlan(cfg);
  const onFinish = vi.fn();
  const onDegrade = vi.fn();
  const scheduler = new SegmentScheduler(engine, clock, plan, {
    driver: opts.driver ?? 'rvfc',
    capabilities: { rVFC: opts.rVFC ?? true },
    onFinish,
    onDegrade,
  });
  return { engine, clock, scheduler, onFinish, onDegrade };
}

describe('scheduler · 基本推进与结束（off）', () => {
  it('start：定位首段并开播（setRate → seek → play 指令序）', () => {
    const { engine, scheduler } = setup(twoSegmentConfig());
    expect(scheduler.start()).toBe(true);
    expect(engine.opSummary()).toEqual(['setRate(1)', 'seek(0)', 'play']);
    const s = scheduler.current();
    expect(s.state).toBe('playing');
    expect(s.segmentId).toBe('aaa000');
    expect(s.remainingMs).toBe(10000);
  });

  it('tick 越过段尾 → 切到下一段并重设速率', () => {
    const { engine, scheduler } = setup(twoSegmentConfig());
    scheduler.start();
    engine.fireTick(4);
    expect(scheduler.current().remainingMs).toBe(6000);
    engine.fireTick(9.999);
    expect(scheduler.current().segmentId).toBe('aaa000');
    engine.fireTick(10);
    expect(engine.opSummary().slice(3)).toEqual(['setRate(2)', 'seek(10)']);
    expect(scheduler.current().segmentId).toBe('bbb111');
    // 2x 速率下剩余时间按倍速折算
    expect(scheduler.current().remainingMs).toBe(5000);
  });

  it('末段播完 → 暂停并 finished（loop.mode=off）', () => {
    const { engine, scheduler, onFinish } = setup(twoSegmentConfig());
    scheduler.start();
    engine.fireTick(10);
    engine.fireTick(20);
    expect(engine.opSummary().at(-1)).toBe('pause');
    expect(scheduler.current().state).toBe('finished');
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it('finished 后 tick 不再产生指令', () => {
    const { engine, scheduler } = setup(twoSegmentConfig());
    scheduler.start();
    engine.fireTick(10); // → bbb
    engine.fireTick(20); // 末段完 → finished
    expect(scheduler.current().state).toBe('finished');
    const opsAtFinish = engine.ops.length;
    engine.fireTick(25);
    expect(engine.ops.length).toBe(opsAtFinish);
  });
});

describe('scheduler · 循环（M0 门禁 2：循环场景）', () => {
  it('queue 无限循环：末段结束绕回首段，loopsDone 累加', () => {
    const { engine, scheduler } = setup(twoSegmentConfig({ loop: { mode: 'queue' } }));
    scheduler.start();
    engine.fireTick(10); // → bbb
    engine.fireTick(20); // 末段完 → 绕回
    expect(engine.opSummary().slice(-2)).toEqual(['setRate(1)', 'seek(0)']);
    const s = scheduler.current();
    expect(s.state).toBe('playing');
    expect(s.loopsDone).toBe(1);
    expect(s.segmentId).toBe('aaa000');
  });

  it('queue count=2：完整播两遍后 finished', () => {
    const { engine, scheduler, onFinish } = setup(twoSegmentConfig({ loop: { mode: 'queue', count: 2 } }));
    scheduler.start();
    engine.fireTick(10);
    engine.fireTick(20); // 第 1 遍完
    expect(scheduler.current().loopsDone).toBe(1);
    expect(scheduler.current().state).toBe('playing');
    engine.fireTick(10);
    engine.fireTick(20); // 第 2 遍完
    expect(scheduler.current().loopsDone).toBe(2);
    expect(scheduler.current().state).toBe('finished');
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it('segment 单段循环：当前段播完自动重播（F5 AC3），不切段', () => {
    const { engine, scheduler } = setup(twoSegmentConfig({ loop: { mode: 'segment' } }));
    scheduler.start();
    engine.fireTick(10);
    expect(engine.opSummary().slice(-2)).toEqual(['setRate(1)', 'seek(0)']);
    expect(scheduler.current().segmentId).toBe('aaa000');
    expect(scheduler.current().state).toBe('playing');
    engine.fireTick(10);
    expect(scheduler.current().segmentId).toBe('aaa000'); // 仍在原段
  });
});

describe('scheduler · 重复段与勾选过滤（M0 门禁 2）', () => {
  it('重复段：sequence 两次引用同段，各播一遍后切走', () => {
    const cfg = makeConfig({
      segments: [
        makeSegment({ id: 'aaa000', start: 0, end: 10, rate: 1 }),
        makeSegment({ id: 'bbb111', start: 30, end: 40, rate: 3 }),
      ],
      sequence: ['aaa000', 'aaa000', 'bbb111'],
      loop: { mode: 'off' },
    });
    const { engine, scheduler } = setup(cfg);
    scheduler.start();
    engine.fireTick(10); // 第一遍 aaa 完 → 第二遍 aaa
    expect(engine.opSummary().slice(-2)).toEqual(['setRate(1)', 'seek(0)']);
    expect(scheduler.current().queueIndex).toBe(1);
    engine.fireTick(10); // 第二遍 aaa 完 → bbb
    expect(engine.opSummary().slice(-2)).toEqual(['setRate(3)', 'seek(30)']);
    expect(scheduler.current().segmentId).toBe('bbb111');
  });

  it('勾选过滤：inQueue=false 的段不进播放流', () => {
    const cfg = makeConfig({
      segments: [
        makeSegment({ id: 'aaa000', start: 0, end: 10, rate: 1 }),
        makeSegment({ id: 'bbb111', start: 10, end: 20, rate: 2, inQueue: false }),
        makeSegment({ id: 'ccc222', start: 20, end: 30, rate: 0.5 }),
      ],
      sequence: ['aaa000', 'bbb111', 'ccc222'],
      loop: { mode: 'off' },
    });
    const { engine, scheduler } = setup(cfg);
    scheduler.start();
    engine.fireTick(10);
    // bbb 被过滤：aaa 完直接进 ccc
    expect(engine.opSummary().slice(-2)).toEqual(['setRate(0.5)', 'seek(20)']);
    expect(scheduler.current().segmentId).toBe('ccc222');
  });

  it('全部取消勾选 → 队列空 → start 返回 false（播放禁用）', () => {
    const cfg = makeConfig({
      segments: [makeSegment({ id: 'aaa000', inQueue: false })],
      sequence: ['aaa000'],
    });
    const { engine, scheduler } = setup(cfg);
    expect(scheduler.start()).toBe(false);
    expect(engine.ops).toHaveLength(0);
  });
});

describe('scheduler · 边界 seek（M0 门禁 2）', () => {
  it('seek 进另一段中部 → 切项、重设速率', () => {
    const { engine, scheduler } = setup(twoSegmentConfig());
    scheduler.start();
    scheduler.seek(15);
    expect(engine.opSummary().slice(-2)).toEqual(['setRate(2)', 'seek(15)']);
    expect(scheduler.current().segmentId).toBe('bbb111');
  });

  it('seek 恰在段边界 → 落进下一段', () => {
    const { scheduler } = setup(twoSegmentConfig());
    scheduler.start();
    scheduler.seek(10);
    expect(scheduler.current().segmentId).toBe('bbb111');
  });

  it('seek 回首段 → 重新定位首段', () => {
    const { engine, scheduler } = setup(twoSegmentConfig());
    scheduler.start();
    engine.fireTick(10); // 进 bbb
    scheduler.seek(5);
    expect(scheduler.current().segmentId).toBe('aaa000');
    expect(engine.opSummary().slice(-2)).toEqual(['setRate(1)', 'seek(5)']);
  });

  it('seek 越过末段（off）→ finished 并暂停', () => {
    const { engine, scheduler } = setup(twoSegmentConfig());
    scheduler.start();
    scheduler.seek(25);
    expect(scheduler.current().state).toBe('finished');
    expect(engine.opSummary().at(-1)).toBe('pause');
  });

  it('seek 落进段间缝隙 → 归位到下一个未开始的段', () => {
    const cfg = makeConfig({
      segments: [
        makeSegment({ id: 'aaa000', start: 0, end: 10, rate: 1 }),
        makeSegment({ id: 'bbb111', start: 20, end: 30, rate: 2 }),
      ],
      sequence: ['aaa000', 'bbb111'],
      loop: { mode: 'off' },
    });
    const { engine, scheduler } = setup(cfg);
    scheduler.start();
    scheduler.seek(15); // aaa 与 bbb 之间的 10~20s 缝隙
    expect(scheduler.current().segmentId).toBe('bbb111');
    expect(engine.opSummary().slice(-2)).toEqual(['setRate(2)', 'seek(20)']);
  });
});

describe('scheduler · 调度主线与降级（P3）', () => {
  it('auto + rVFC 可用 → rvfc 主线；不可用 → polling 兜底', () => {
    const a = setup(twoSegmentConfig(), { driver: 'auto', rVFC: true });
    expect(a.scheduler.currentDriver()).toBe('rvfc');
    const b = setup(twoSegmentConfig(), { driver: 'auto', rVFC: false });
    expect(b.scheduler.currentDriver()).toBe('polling');
  });

  it('polling 模式：50ms 注入时钟轮询驱动切端', () => {
    const { engine, clock, scheduler } = setup(twoSegmentConfig(), { driver: 'polling' });
    scheduler.start();
    engine.time = 10; // 无 onTick，仅靠轮询读 getTime()
    clock.advance(50);
    expect(scheduler.current().segmentId).toBe('bbb111');
    expect(engine.opSummary().slice(-2)).toEqual(['setRate(2)', 'seek(10)']);
  });

  it('rVFC 静默超过 500ms → 自动降级轮询（onDegrade 回调 + 轮询接管）', () => {
    const { engine, clock, scheduler, onDegrade } = setup(twoSegmentConfig(), { driver: 'rvfc' });
    scheduler.start();
    engine.fireTick(5); // 有过一次正常 tick
    clock.advance(600); // 之后 600ms 无 tick（超过 RVFC_STALL_MS）
    expect(onDegrade).toHaveBeenCalledWith('polling');
    expect(scheduler.currentDriver()).toBe('polling');
    // 轮询接管：直接改媒体时间，下个 50ms 轮询即切端
    engine.time = 10;
    clock.advance(50);
    expect(scheduler.current().segmentId).toBe('bbb111');
  });

  it('stop 摘除定时器（无残留轮询）', () => {
    const { clock, scheduler } = setup(twoSegmentConfig(), { driver: 'polling' });
    scheduler.start();
    expect(clock.activeTimers).toBe(1);
    scheduler.stop();
    expect(clock.activeTimers).toBe(0);
    expect(scheduler.current().state).toBe('idle');
  });
});

describe('scheduler · resync（P7-B 回前台校准续播）', () => {
  it('时间在当前段内 → 重申速率并续播，不乱 seek', () => {
    const { engine, scheduler } = setup(twoSegmentConfig());
    scheduler.start();
    engine.fireTick(4);
    engine.playing = false; // 模拟切后台被系统暂停
    engine.ops.length = 0;
    scheduler.resync();
    expect(engine.opSummary()).toEqual(['setRate(1)', 'play']);
    expect(scheduler.current().segmentId).toBe('aaa000');
  });

  it('时间漂移出当前段 → 重新定位 + seek 校准 + 续播', () => {
    const { engine, scheduler } = setup(twoSegmentConfig());
    scheduler.start();
    engine.fireTick(4);
    engine.time = 15; // 漂移进 bbb 区间
    scheduler.resync();
    expect(scheduler.current().segmentId).toBe('bbb111');
    expect(engine.opSummary().slice(-3)).toEqual(['seek(15)', 'setRate(2)', 'play']);
  });

  it('时间漂移越过末段 → 结束并暂停（locateItem 越界兜底）', () => {
    const { engine, scheduler } = setup(twoSegmentConfig());
    scheduler.start();
    engine.fireTick(4);
    engine.time = 25; // 漂出全部段
    scheduler.resync();
    expect(scheduler.current().state).toBe('finished');
    expect(engine.opSummary().at(-1)).toBe('pause');
  });

  it('finished 状态下 resync 不动', () => {
    const { engine, scheduler } = setup(twoSegmentConfig());
    scheduler.start();
    engine.fireTick(10); // → bbb
    engine.fireTick(20); // 末段完 → finished
    expect(scheduler.current().state).toBe('finished');
    const ops = engine.ops.length;
    scheduler.resync();
    expect(engine.ops.length).toBe(ops);
  });
});
