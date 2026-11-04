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

import { describe, it, expect } from 'vitest';
import { FakeEngine } from '../fakes/fake-engine';
import { createStore } from '../../../src/app/store';
import { initialState, type AppState } from '../../../src/app/state';
import { makeConfig, makeSegment } from '../helpers';
import type { Persistence } from '../../../src/core/config/persistence';
import type { PlayerConfig } from '../../../src/core/config/schema';
import type { EditorController } from '../../../src/app/controller';
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
