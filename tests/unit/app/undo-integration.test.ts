/**
 * v0.3.2 · 项2+10 集成单测：controller 撤销世界线栈端到端。
 *
 * 覆盖方案 v1.1 项2+10 测试影响表中「删→undo 配置逐字一致」「连删截断回退」
 * 「世界线断裂清栈」「草稿态不落盘」四条核心语义（E2E 侧另有 4 条真浏览器用例）。
 *
 * 测试缝：createEditorController 的 opts.engine（FakeEngine）+ window.localStorage 假存储；
 * node 环境全局 stub 与 play-mode.test.ts 同源。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeEngine } from '../fakes/fake-engine';
import { createStore } from '../../../src/app/store';
import { initialState, type AppState } from '../../../src/app/state';
import { makeConfig, makeSegment } from '../helpers';
import { canonicalize } from '../../../src/core/config/codec';
import { UNDO_STORAGE_KEY } from '../../../src/app/undo-store';
import type { Persistence } from '../../../src/core/config/persistence';
import type { PlayerConfig } from '../../../src/core/config/schema';
import type { EditorController } from '../../../src/app/controller';
import type { PlayerEngine } from '../../../src/core/player/engine';

// ---- node 环境全局 stub（须在动态 import controller 前安装） ----
type Globals = Record<string, unknown>;
const g = globalThis as unknown as Globals;
g.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
g.window = {
  addEventListener() {},
  removeEventListener() {},
  location: { search: '' },
  __GYMPLAY_TEST_FREEZE_NOTICES__: true,
};
Object.defineProperty(g, 'navigator', { value: { webdriver: false }, configurable: true });

const { createEditorController } = await import('../../../src/app/controller');

/** Map 支撑的假 localStorage（每用例重建挂到 window 上） */
function installFakeStorage(): Map<string, string> {
  const m = new Map<string, string>();
  (g.window as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  } as Storage;
  return m;
}

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
  controller: EditorController;
  store: { get(): AppState };
  storage: Map<string, string>;
}

/** 以「未进入草稿态的本地编辑态」装配 controller（撤销栈正常落盘） */
function setup(cfg: PlayerConfig): Setup {
  const storage = installFakeStorage();
  const store = createStore<AppState>({
    ...initialState,
    config: cfg,
    configOrigin: 'local-edit',
    videoReady: true,
    videoName: cfg.video.filename,
    videoDuration: cfg.video.duration,
  });
  const engine = new FakeEngine();
  const controller = createEditorController({
    store,
    persistence: fakePersistence(),
    video: { paused: true, duration: cfg.video.duration } as unknown as HTMLVideoElement,
    engine: engine as unknown as PlayerEngine,
  });
  return { controller, store, storage };
}

function threeSegConfig(): PlayerConfig {
  return makeConfig({
    segments: [
      makeSegment({ id: 'aaa000', start: 0, end: 10, label: 'A' }),
      makeSegment({ id: 'bbb111', start: 10, end: 20, label: 'B' }),
      makeSegment({ id: 'ccc222', start: 20, end: 30, label: 'C' }),
    ],
    sequence: ['aaa000', 'bbb111', 'ccc222'],
  });
}

describe('v0.3.2 · 项2+10：controller 撤销栈集成', () => {
  let ctx: Setup;
  beforeEach(() => {
    ctx = setup(threeSegConfig());
  });

  it('删段 → 栈入栈 1 条并落盘 → undoDelete 后配置与删除前 canonical 逐字一致', () => {
    const pre = canonicalize(ctx.store.get().config!);
    ctx.controller.removeSegment('bbb111');
    const st1 = ctx.store.get();
    expect(st1.undoStack).toHaveLength(1);
    expect(st1.undoStack[0]).toMatchObject({ kind: 'delete-segment', segLabel: 'B' });
    expect(st1.undoBannerVisible).toBe(true);
    expect(ctx.storage.has(UNDO_STORAGE_KEY)).toBe(true);

    ctx.controller.undoDelete(st1.undoStack[0].id);
    const st2 = ctx.store.get();
    expect(canonicalize(st2.config!)).toBe(pre); // 逐字一致（世界线回退）
    expect(st2.undoBannerVisible).toBe(false);
    // 截断保留：原删除条目置灰 + 1 条 restore 记录（只读展示，不可再恢复）
    expect(st2.undoStack).toHaveLength(2);
    expect(st2.undoStack[0].stale).toBe(true);
    expect(st2.undoStack[1].kind).toBe('restore');
  });

  it('连删两段 → undoDelete 最早一步：后续删除条目一并置灰，配置回到两次删除之前', () => {
    const pre = canonicalize(ctx.store.get().config!);
    ctx.controller.removeSegment('bbb111');
    ctx.controller.removeSegment('aaa000');
    const st1 = ctx.store.get();
    expect(st1.undoStack).toHaveLength(2);

    ctx.controller.undoDelete(st1.undoStack[0].id); // 恢复最早一步
    const st2 = ctx.store.get();
    expect(canonicalize(st2.config!)).toBe(pre);
    expect(st2.undoStack).toHaveLength(3); // 2 条置灰 + 1 条 restore
    expect(st2.undoStack.filter((e) => e.stale)).toHaveLength(2);
  });

  it('删段后调速（世界线断裂编辑）→ 栈清空、横幅消失、localStorage 键移除', () => {
    ctx.controller.removeSegment('bbb111');
    expect(ctx.store.get().undoStack).toHaveLength(1);

    ctx.controller.setRate('aaa000', 2);
    const st = ctx.store.get();
    expect(st.undoStack).toHaveLength(0);
    expect(st.undoBannerVisible).toBe(false);
    expect(ctx.storage.has(UNDO_STORAGE_KEY)).toBe(false);
  });

  it('草稿态（pendingKeyConfig）删段：栈仅内存不落盘，编辑只写草稿', () => {
    // 重装：以草稿态装配（模拟 URL 密钥导入待确认场景）
    const draft = threeSegConfig();
    const storage = installFakeStorage();
    const store = createStore<AppState>({
      ...initialState,
      config: null,
      pendingKeyConfig: draft,
      configOrigin: null,
      videoReady: true,
    });
    const controller = createEditorController({
      store,
      persistence: fakePersistence(),
      video: { paused: true, duration: draft.video.duration } as unknown as HTMLVideoElement,
      engine: new FakeEngine() as unknown as PlayerEngine,
    });
    controller.removeSegment('bbb111');
    const st = store.get();
    // 草稿被编辑（只改 pendingKeyConfig，不写本地 config / localStorage）
    expect(st.pendingKeyConfig!.segments).toHaveLength(2);
    expect(st.config).toBeNull();
    // 规则 5：草稿态撤销栈仅内存
    expect(st.undoStack).toHaveLength(1);
    expect(storage.has(UNDO_STORAGE_KEY)).toBe(false);
  });
});
