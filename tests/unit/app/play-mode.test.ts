/**
 * v0.3.2 · 项7 单测：变速隔离（F7′）——FakeEngine 指令序列断言。
 *
 * 三条核心不变量（方案 v1.1 · 项7）：
 * 1. 队列播完归 1x：末段 2x 播完 → onFinish 显式复位（不残留段值）；
 * 2. 改速后预览 1x：段值 2 的配置下自由预览起播，play 前有 setRate(1)；
 * 3. selectSegment 前置 setRate(1)：队列 2x 播放中点选 → 退出队列后以 1x 段首起播。
 *
 * 测试缝：createEditorController 支持注入 PlayerEngine（opts.engine，v0.3.2 新增），
 * node 环境下以全局 stub 提供 controller 创建期触碰的 document / window / navigator。
 */

import { describe, it, expect, vi } from 'vitest';
import { FakeEngine } from '../fakes/fake-engine';
import { createStore } from '../../../src/app/store';
import { initialState, type AppState } from '../../../src/app/state';
import { makeConfig, makeSegment } from '../helpers';
import type { Persistence } from '../../../src/core/config/persistence';
import type { PlayerConfig } from '../../../src/core/config/schema';
import type { EditorController, PlayMode, QueueFrame } from '../../../src/app/controller';
import type { PlayerEngine } from '../../../src/core/player/engine';

// ---- node 环境全局 stub（须在动态 import controller 前安装） ----
// window.__GYMPLAY_TEST_FREEZE_NOTICES__ = true → 通知冻结（不产生计时器）
type Globals = Record<string, unknown>;
const g = globalThis as unknown as Globals;
g.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
g.window = {
  addEventListener() {},
  removeEventListener() {},
  location: { search: '' },
  __GYMPLAY_TEST_FREEZE_NOTICES__: true,
};
// Node ≥21 的全局 navigator 为 getter-only，须用 defineProperty 覆盖
Object.defineProperty(g, 'navigator', { value: { webdriver: false }, configurable: true });

// 动态 import：确保上述 stub 在模块求值前就位
// BA-F-12 测试缝：包装真实 SegmentScheduler（行为零改动），仅捕获构造入参中的 PlayPlan
const { capturedPlans } = vi.hoisted(() => ({ capturedPlans: [] as unknown[] }));
vi.mock('../../../src/core/scheduler/scheduler', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/core/scheduler/scheduler')>();
  class CapturingSegmentScheduler extends mod.SegmentScheduler {
    constructor(...args: ConstructorParameters<typeof mod.SegmentScheduler>) {
      super(...args);
      capturedPlans.push(args[2]);
    }
  }
  return { ...mod, SegmentScheduler: CapturingSegmentScheduler };
});
const { createEditorController } = await import('../../../src/app/controller');

function fakePersistence(): Persistence {
  return {
    save() {},
    saveNow() {},
    load() {
      return null;
    },
    clear() {},
    degraded: false,
    onDegraded() {},
    savePlayback() {},
    loadPlayback() {
      return null;
    },
    clearPlayback() {},
  };
}

interface Setup {
  engine: FakeEngine;
  controller: EditorController;
  video: { paused: boolean; duration: number };
}

function setup(cfg: PlayerConfig): Setup {
  const engine = new FakeEngine();
  const store = createStore<AppState>({
    ...initialState,
    config: cfg,
    configOrigin: 'local-edit',
    videoReady: true,
    videoName: cfg.video.filename,
    videoDuration: cfg.video.duration,
  });
  const video = { paused: true, duration: cfg.video.duration };
  const controller = createEditorController({
    store,
    persistence: fakePersistence(),
    video: video as unknown as HTMLVideoElement,
    engine: engine as unknown as PlayerEngine,
  });
  return { engine, controller, video };
}

describe('v0.3.2 · 项7：变速隔离（FakeEngine 指令序列）', () => {
  it('队列播完归 1x——末段 2x 播完，onFinish 后最后一条 setRate 为 1', async () => {
    const cfg = makeConfig({
      segments: [makeSegment({ id: 'aaa000', start: 0, end: 10, rate: 2 })],
      sequence: ['aaa000'],
    });
    const { engine, controller } = setup(cfg);
    controller.playQueue();
    // 起播：调度器对段下发段值速率 2
    expect(engine.opSummary()).toContain('setRate(2)');
    // 推进媒体时间越过段末（rVFC=false → 轮询驱动 50ms 一拍），等轮询 tick 触发 finish
    engine.time = 10.5;
    await new Promise((r) => setTimeout(r, 300));
    const rates = engine.ops.filter((op) => op.type === 'setRate').map((op) => op.rate);
    expect(rates.length).toBeGreaterThan(0);
    expect(rates[rates.length - 1]).toBe(1);
  });

  it('改速后预览 1x——段值 2 的配置下 togglePlay，play 前有 setRate(1) 且无 setRate(2)', () => {
    const cfg = makeConfig({
      segments: [makeSegment({ id: 'aaa000', start: 0, end: 10, rate: 2 })],
      sequence: ['aaa000'],
    });
    const { engine, controller } = setup(cfg);
    controller.togglePlay();
    const ops = engine.opSummary();
    expect(ops).toContain('setRate(1)');
    expect(ops).toContain('play');
    expect(ops.indexOf('setRate(1)')).toBeLessThan(ops.indexOf('play'));
    expect(ops).not.toContain('setRate(2)');
  });

  it('selectSegment 前置 setRate(1)——队列 2x 播放中点选另一段，退出队列后以 1x 段首起播', () => {
    const cfg = makeConfig({
      segments: [
        makeSegment({ id: 'aaa000', start: 0, end: 10, rate: 2, label: 'A' }),
        makeSegment({ id: 'bbb111', start: 10, end: 20, rate: 1.5, label: 'B' }),
      ],
      sequence: ['aaa000', 'bbb111'],
    });
    const { engine, controller } = setup(cfg);
    controller.playQueue();
    expect(engine.opSummary()).toContain('setRate(2)');
    // 清空起播指令，聚焦 selectSegment 触发的序列
    engine.ops.length = 0;
    controller.selectSegment('bbb111');
    const ops = engine.opSummary();
    // 退出队列（stopQueueInternal → setRate(1)）先于 seek(段首) / play
    expect(ops).toContain('setRate(1)');
    expect(ops).toContain('seek(10)');
    expect(ops).toContain('play');
    expect(ops.indexOf('setRate(1)')).toBeLessThan(ops.indexOf('seek(10)'));
    expect(ops.indexOf('seek(10)')).toBeLessThan(ops.indexOf('play'));
    // 不携带被点段的段值速率 1.5
    expect(ops).not.toContain('setRate(1.5)');
  });
});



// ---- v0.3.2 · 项9：单段试听（audit 状态机 + 15 行打断语义矩阵核心路径） ----

const { resolvePlayAction } = await import('../../../src/app/controller');

describe('v0.3.2 · 项9：resolvePlayAction 纯函数矩阵（矩阵 #1）', () => {
  const cases: Array<[PlayMode, boolean, string]> = [
    ['idle', true, 'preview-play'],
    ['idle', false, 'preview-pause'],
    ['preview', true, 'preview-play'],
    ['preview', false, 'preview-pause'],
    ['queue', true, 'resume'],
    ['queue', false, 'pause'],
    ['audit', true, 'resume'],
    ['audit', false, 'pause'],
  ];
  for (const [mode, paused, expected] of cases) {
    it(`${mode} × paused=${paused} → ${expected}`, () => {
      expect(resolvePlayAction(mode, paused)).toBe(expected);
    });
  }
});

describe('v0.3.2 · 项9：auditScheduler 与 queueFrame 隔离（BA-F-4）+ 打断矩阵', () => {
  function auditConfig(): PlayerConfig {
    return makeConfig({
      segments: [
        makeSegment({ id: 'aaa000', start: 0, end: 10, rate: 2, label: 'A' }),
        makeSegment({ id: 'bbb111', start: 10, end: 20, rate: 1.5, label: 'B' }),
      ],
      sequence: ['aaa000', 'bbb111'],
    });
  }

  it('BA-F-4：试听期队列帧为空态（queueIndex=-1）且 audit 字段随帧下发', () => {
    const { engine, controller } = setup(auditConfig());
    const frames: QueueFrame[] = [];
    controller.onFrame((_t, q) => { frames.push(q); });
    controller.startAudition('aaa000');
    expect(frames[frames.length - 1]?.queueIndex).toBe(-1);
    expect(frames[frames.length - 1]?.queueTotal).toBe(0);
    expect(frames[frames.length - 1]?.auditSegmentId).toBe('aaa000');
    expect(frames[frames.length - 1]?.auditRate).toBe(2);
    expect(engine.opSummary()).toContain('setRate(2)');
  });

  it('BA-F-12：试听 PlayPlan 携带 sequence 真实下标（≥ 0，禁用 -1 哨兵）', () => {
    const { controller } = setup(auditConfig());
    capturedPlans.length = 0;
    controller.startAudition('bbb111');
    expect(capturedPlans.length).toBe(1);
    const plan = capturedPlans[0] as {
      items: Array<{ segmentId: string; sequenceIndex: number }>;
    };
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].segmentId).toBe('bbb111');
    // G-3 / BA-F-12：真实下标 = cfg.sequence.indexOf(seg.id)，防御性禁用 -1 哨兵
    expect(plan.items[0].sequenceIndex).toBeGreaterThanOrEqual(0);
    expect(plan.items[0].sequenceIndex).toBe(1);
  });

  it('矩阵 #1：试听中 togglePlay 暂停/续播，不退出、速率保持段值', () => {
    const { engine, controller, video } = setup(auditConfig());
    controller.startAudition('aaa000');
    engine.ops.length = 0;
    // 播放中 → pause（stub video.paused 起播后仍 true，先模拟播放态）
    (video as { paused: boolean }).paused = false;
    controller.togglePlay();
    expect(engine.opSummary()).toContain('pause');
    expect(engine.opSummary()).not.toContain('setRate(1)');
    (video as { paused: boolean }).paused = true;
    engine.ops.length = 0;
    controller.togglePlay();
    expect(engine.opSummary()).toContain('play');
    expect(engine.opSummary()).not.toContain('setRate(1)');
  });

  it('矩阵 #6：调速作用于试听中的段 → 就地生效不打断（无 pause/play，setRate 新值）', () => {
    const { engine, controller } = setup(auditConfig());
    controller.startAudition('aaa000');
    engine.ops.length = 0;
    controller.setRate('aaa000', 1.5);
    const ops = engine.opSummary();
    expect(ops).toContain('setRate(1.5)');
    expect(ops).not.toContain('pause');
    expect(ops).not.toContain('play');
    // 段字段已提交（rate 1.5 生效于配置）
    const frames: QueueFrame[] = [];
    controller.onFrame((_t, q) => { frames.push(q); });
    controller.exitAudition();
    expect(frames[frames.length - 1]?.auditSegmentId).toBeNull();
  });

  it('矩阵 #7：调速作用于其他段 → 停止试听（速率归 1）', () => {
    const { engine, controller } = setup(auditConfig());
    controller.startAudition('aaa000');
    engine.ops.length = 0;
    const frames: QueueFrame[] = [];
    controller.onFrame((_t, q) => { frames.push(q); });
    controller.setRate('bbb111', 1);
    expect(engine.opSummary()).toContain('setRate(1)');
    expect(frames[frames.length - 1]?.auditSegmentId).toBeNull();
  });

  it('矩阵 #2：seekPreview 退出试听（归 1x + seek 到目标位）', () => {
    const { engine, controller } = setup(auditConfig());
    controller.startAudition('aaa000');
    engine.ops.length = 0;
    controller.seekPreview(15);
    const ops = engine.opSummary();
    expect(ops).toContain('setRate(1)');
    expect(ops).toContain('seek(15)');
    expect(ops.indexOf('setRate(1)')).toBeLessThan(ops.indexOf('seek(15)'));
  });

  it('矩阵 #12：stopQueue 停止试听', () => {
    const { engine, controller } = setup(auditConfig());
    controller.startAudition('aaa000');
    engine.ops.length = 0;
    controller.stopQueue();
    expect(engine.opSummary()).toContain('setRate(1)');
    expect(engine.opSummary()).toContain('pause');
  });

  it('矩阵 #10 + BA-F-13：自然播完（含越界路径）→ onFinish → 归 1x / idle / 徽标回预览', async () => {
    const { engine, controller } = setup(auditConfig());
    controller.startAudition('aaa000');
    const frames: QueueFrame[] = [];
    controller.onFrame((_t, q) => { frames.push(q); });
    // 推进媒体时间越过段末（rVFC=false → 50ms 轮询），tick 触发 advancePastEnd → onFinish
    engine.time = 10.5;
    await new Promise((r) => setTimeout(r, 300));
    const rates = engine.ops.filter((op) => op.type === 'setRate').map((op) => op.rate);
    expect(rates[rates.length - 1]).toBe(1);
    expect(frames[frames.length - 1]?.auditSegmentId).toBeNull();
    // 调度器已停：再次 startAudition 可重启（幂等重建，矩阵 #4）
    engine.ops.length = 0;
    controller.startAudition('aaa000');
    expect(engine.opSummary()).toContain('setRate(2)');
    expect(engine.opSummary()).toContain('seek(0)');
  });
});
