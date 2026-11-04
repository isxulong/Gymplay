/**
 * v0.3.2 · 项6 单测：未选中段可预览（维持不限制 + 视觉语义）——controller 层守卫。
 *
 * 视觉弱化（tl__seg--off / 斜纹轨道）是纯 CSS/类名，行为面守卫三条（方案 v1.1 · 项6 · 守卫化）：
 * 1. 未勾选段 selectSegment → engine 位置 = 段起点，不抛错（弱化不禁交互）；
 * 2. 队列播放中 seekPreview 仍可用（经项 7 语义：scheduler 在即停 → 自由预览）；
 * 3. 段列表点击路由 selectSegment：选中态切换 + 未勾选段同样可选中。
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

type Globals = Record<string, unknown>;
const g = globalThis as unknown as Globals;
g.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
g.window = {
  addEventListener() {},
  removeEventListener() {},
  location: { search: '' },
  __GYMPLAY_TEST_FREEZE_NOTICES__: true,
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
};
Object.defineProperty(g, 'navigator', { value: { webdriver: false }, configurable: true });

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

function setup(cfg: PlayerConfig): { engine: FakeEngine; controller: EditorController; store: { get(): AppState } } {
  const engine = new FakeEngine();
  const store = createStore<AppState>({
    ...initialState,
    config: cfg,
    configOrigin: 'local-edit',
    videoReady: true,
    videoName: cfg.video.filename,
    videoDuration: cfg.video.duration,
  });
  const controller = createEditorController({
    store,
    persistence: fakePersistence(),
    video: { paused: true, duration: cfg.video.duration } as unknown as HTMLVideoElement,
    engine: engine as unknown as PlayerEngine,
  });
  return { engine, controller, store };
}

/** 两段配置：B 段未勾选（inQueue=false） */
function cfgWithOffSegment(): PlayerConfig {
  return makeConfig({
    segments: [
      makeSegment({ id: 'aaa000', start: 0, end: 10, label: 'A', inQueue: true }),
      makeSegment({ id: 'bbb111', start: 10, end: 20, label: 'B', inQueue: false }),
    ],
    sequence: ['aaa000'],
  });
}

describe('v0.3.2 · 项6：未选中段可预览（守卫化）', () => {
  it('未勾选段 selectSegment → engine 位置 = 段起点，不抛错', () => {
    const { engine, controller } = setup(cfgWithOffSegment());
    expect(() => controller.selectSegment('bbb111')).not.toThrow();
    // 退出队列（无调度器时无指令）+ seek 到未勾选段起点 10
    expect(engine.opSummary()).toContain('seek(10)');
    expect(engine.getTime()).toBe(10);
  });

  it('队列播放中 seekPreview 仍可用（项 7 语义：scheduler 在即停 → 自由预览）', async () => {
    const cfg = makeConfig({
      segments: [makeSegment({ id: 'aaa000', start: 0, end: 10, rate: 2 })],
      sequence: ['aaa000'],
    });
    const { engine, controller } = setup(cfg);
    controller.playQueue();
    expect(engine.opSummary()).toContain('setRate(2)');
    controller.seekPreview(3);
    const ops = engine.opSummary();
    // 停队列复位 1x 后 seek(3)，预览不受队列持有播放权阻塞
    expect(ops).toContain('setRate(1)');
    expect(ops).toContain('seek(3)');
    expect(engine.getTime()).toBe(3);
  });

  it('段列表点击路由 selectSegment：选中态切换，未勾选段同样可选中', () => {
    const { controller, store } = setup(cfgWithOffSegment());
    controller.selectSegment('aaa000');
    expect(store.get().selectedSegmentId).toBe('aaa000');
    controller.selectSegment('bbb111'); // 未勾选段可选中（编辑入口不受限）
    expect(store.get().selectedSegmentId).toBe('bbb111');
  });
});
