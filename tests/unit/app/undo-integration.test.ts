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
import {
  UNDO_ENTRY_MAX_BYTES,
  UNDO_STORAGE_KEY,
  undoEntryBytes,
} from '../../../src/app/undo-store';
import type { Persistence } from '../../../src/core/config/persistence';
import type { PlayerConfig } from '../../../src/core/config/schema';
import type { EditorController } from '../../../src/app/controller';
import type { PlayerEngine } from '../../../src/core/player/engine';

// ---- node 环境全局 stub（须在动态 import controller 前安装） ----
// 仓库未装 @types/node：配额用例用 Node 真实 Buffer.byteLength 判定假存储容量（运行期是原生实现）
declare const Buffer: { byteLength(input: string, encoding?: string): number };
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
    // v0.3.3 · 项3 · 断言反转（旧期望：点最早一条即立刻把配置回退到两次删除之前、栈变 3 条）。
    // 反转理由：门禁判定对象已从「栈顶」改为「被点击条目」（方案 §2.3 第 3/4 条）。点最早一条时
    // 该条 post（= 只删掉 B 的那份）不是当前世界线末端（当前 = B、A 都删了），因此**不能静默回退**
    // ——那会把用户后来的删除一并抹掉。新语义：先落 undoConfirm（写明将一并回退 1 处改动），
    // 配置与栈都不动；用户确认后才提交，并把被覆盖的当前配置存成反向记录。
    const pre = canonicalize(ctx.store.get().config!);
    ctx.controller.removeSegment('bbb111');
    ctx.controller.removeSegment('aaa000');
    const st1 = ctx.store.get();
    expect(st1.undoStack).toHaveLength(2);

    ctx.controller.undoDelete(st1.undoStack[0].id); // 点最早一步
    const st2 = ctx.store.get();
    // 旧断言：canonicalize(st2.config!) === pre / undoStack 长度 3 / 2 条置灰
    // 新口径分两步：点下去只是「落确认」，确认后才真正提交（旧断言把两步压成了一步）
    expect(canonicalize(st2.config!)).not.toBe(pre); // 点下去不立即改配置
    expect(st2.undoConfirm).not.toBeNull(); // 新：落恢复前确认，不立即改配置
    expect(st2.undoConfirm!.entryId).toBe(st1.undoStack[0].id);
    expect(st2.undoConfirm!.superseded).toBe(1); // 该条之后还有 1 条可恢复的删除
    expect(st2.undoConfirm!.overwritten).toBe(canonicalize(st2.config!)); // 被覆盖配置已备妥
    expect(st2.undoStack).toHaveLength(2); // 未提交，栈不变
    expect(st2.undoStack.filter((e) => e.stale)).toHaveLength(0); // 未提交，无置灰

    // 确认后提交：恢复目标是该条 pre = bbb111 被删之前的那份 = 两次删除之前（旧期望值本身仍成立）
    ctx.controller.confirmUndo();
    const st3 = ctx.store.get();
    expect(canonicalize(st3.config!)).toBe(pre);
    // 恢复记录/反向记录同时入栈：前 2 条置灰（stale-in-place，不删）+ 恢复记录 + 反向记录
    expect(st3.undoStack.filter((e) => e.stale)).toHaveLength(2);
    // 反向记录 = 被覆盖的那份当前配置（「B、A 都已删」），用于再撤回本次恢复
    const reverse = st3.undoStack[st3.undoStack.length - 1];
    expect(reverse.kind).toBe('restore');
    expect(reverse.reverse).toBe(true);
    expect(reverse.pre).toBe(st2.undoConfirm!.overwritten);
  });

  it('删段后调速（世界线断裂编辑）→ 栈清空、横幅消失、localStorage 键移除', () => {
    // v0.3.3 · 项3 · 断言反转（旧期望：调速后 undoStack 长度 0 / 横幅隐藏 / 存储键移除）。
    // 反转理由：这就是方案里被称为「第 766 行」的那个清栈点。调速属于**不改变「删了哪些段」
    // 的编辑**，把它当成「世界线断裂 → 历史全废」正是方案要修的缺陷（3-c）：一次改速率
    // 就让用户此前所有删除历史消失。新语义：非删除编辑**不入栈也不清栈**，历史与横幅都保留，
    // 存储键仍在；历史与当前编排的落差由「逐条门禁 + 恢复前确认」承担，而不是靠抹掉历史。
    ctx.controller.removeSegment('bbb111');
    expect(ctx.store.get().undoStack).toHaveLength(1);

    ctx.controller.setRate('aaa000', 2);
    const st = ctx.store.get();
    // 旧断言：toHaveLength(0) / undoBannerVisible === false / storage.has === false
    expect(st.undoStack).toHaveLength(1); // 新：历史保留
    expect(st.undoStack[0].kind).toBe('delete-segment');
    expect(st.undoBannerVisible).toBe(true); // 新：横幅仍在（历史还能用）
    // 上下文字段在调速前后同源：旧期望的「横幅消失」与新期望的「横幅可见」是两个互斥口径，
    // 新口径下存储载体仍在（键保留，内容为那 1 条历史）。
    expect(ctx.storage.has(UNDO_STORAGE_KEY)).toBe(true); // 新：不再 removeItem

    // 而且历史确实可用：点它不会被当成已失效，而是走「恢复前确认」（调速不在栈内）
    ctx.controller.undoDelete(st.undoStack[0].id);
    const stAfter = ctx.store.get();
    expect(stAfter.undoConfirm).not.toBeNull(); // 该条 post ≠ 当前（当前含调速）→ 需确认
    expect(stAfter.undoConfirm!.message).toContain('反向记录');
    // 确认后可恢复，且反向记录保住了调速后的编排
    ctx.controller.confirmUndo();
    const stDone = ctx.store.get();
    // 恢复目标 = 该条 pre（删 B 之前，含原本的 rate=1）——即「删 B + 调速」这两处改动一并回退
    expect(canonicalize(stDone.config!)).toBe(st.undoStack[0].pre);
    expect(stDone.undoConfirm).toBeNull();
    // 被覆盖的那份（含 rate=2）存成反向记录，可再撤回本次恢复
    const rev = stDone.undoStack[stDone.undoStack.length - 1];
    expect(rev.kind).toBe('restore');
    expect(rev.reverse).toBe(true);
    expect(rev.pre).toBe(stAfter.undoConfirm!.overwritten);
    expect(JSON.parse(rev.pre!).segments[0].rate).toBe(2);
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

describe('v0.3.3 · 项3：配额不足时丢弃条数必须回报给用户（缺陷 B 的可见后果）', () => {
  it('写入超过本地容量 → 落盘保留多条、undoBreak 记 dropped、warn 提示说清丢了几条', () => {
    // 装配一个「按 UTF-8 体积拒绝写入」的 localStorage：容量只够约 2 条历史
    const storage = installFakeStorage();
    const cfg = quotaConfig(60);
    // 单条删除记录的体积（用真实模块求值，不靠估算）——用于把容量卡在「约 2 条」上
    const victimId = cfg.segments[cfg.segments.length - 1].id;
    const oneEntry = undoEntryBytes({
      id: 1,
      createdAt: 1700000000000,
      kind: 'delete-segment',
      segLabel: '训'.repeat(20),
      pre: canonicalize(cfg),
      post: canonicalize({
        ...cfg,
        segments: cfg.segments.slice(0, -1),
        sequence: cfg.sequence.slice(0, -1),
      }),
    });
    const capacity = oneEntry * 2 + 200; // 容纳 2 条、容不下 3 条
    const writes: string[] = [];
    (g.window as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (Buffer.byteLength(v, 'utf8') > capacity) throw new Error('QuotaExceededError');
        writes.push(v);
        storage.set(k, v);
      },
      removeItem: (k: string) => void storage.delete(k),
      clear: () => storage.clear(),
    } as Storage;

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
      engine: new FakeEngine() as unknown as PlayerEngine,
    });

    // 连删 4 段：栈涨到 4 条时整体超过容量，必须降容而非整段丢掉
    controller.removeSegment(victimId);
    const ids = cfg.segments.slice(0, 3).map((s) => s.id);
    for (const id of ids) controller.removeSegment(id);

    const st = store.get();
    expect(st.undoStack).toHaveLength(4); // 会话内历史完整（被降容的是持久化副本）
    expect(st.undoBannerVisible).toBe(true);

    // 落盘条数：多个，不是 1 —— 证明渐进降容生效
    const persisted = (JSON.parse(storage.get(UNDO_STORAGE_KEY)!) as { entries: unknown[] }).entries.length;
    expect(
      persisted,
      `容量 ${capacity} B / 单条 ${oneEntry} B：落盘 ${persisted} 条，应 > 1`,
    ).toBeGreaterThan(1);

    // 丢弃条数经 undoBreak 回报（capacity 分类，dropped = 实际丢弃量）
    expect(st.undoBreak).toMatchObject({ kind: 'capacity', dropped: 4 - persisted });

    // 用户可见提示：说清「丢了几条」，不是静默 ok:true
    const warns = st.notices.filter((n) => n.kind === 'warn');
    expect(warns.length).toBeGreaterThan(0);
    const text = warns[warns.length - 1].text;
    expect(text).toContain(`已丢弃最旧的 ${4 - persisted} 条`);
    expect(text).toContain('空间不足');
  });
});

/**
 * v0.3.3 · 项3 · 字节级容量边界（验收口径，替代三套估算法）。
 * 质检官实测：282 段（65,384 B）正常追加、**283 段（65,616 B）立刻塌栈**、中间无缓冲。
 * 本组断言用仓库**真实**的 `canonicalize` + `undoEntryBytes`（不重写一份计算器）重现这两个点，
 * 并断言修复后的行为：282 段 → 正常入栈；283 段 → **拒收该条 + warn 提示 + 原栈原样保留**。
 *
 * 尺寸口径说明（与质检官的数字不同源、但边界同构）：`undoEntryBytes(entry)` 计的是**单条记录**
 * 的 JSON 字节，删除类记录同时装着 `pre`（删前全量配置）与 `post`（删后全量配置），所以它
 * ≈ 2 份配置体积 + 开销。本组把「配置形状」固定为：每段 label 14 字、`video.filename` 21 字、
 * `duration` 2840、段区间 [10i, 10i+10)，于是
 * - 282 段：entry = 65,305 B（余 231 B，正常入栈）
 * - 283 段：entry = 65,537 B（超 1 B，必须拒收）
 * 每多一段固定 +232 B（两份 canonical 各多一段的净增量），所以这 1 B 的余量不是巧合而是可复算的。
 * 这两条断言不依赖任何「某档字节数」，只依赖「282 通过 / 283 拒收」这个跳变点本身。
 */
/** 配额场景用配置：段名全中文（单条删除记录体积大，便于把容量卡在「若干条」上） */
function quotaConfig(count: number): PlayerConfig {
  const segments = Array.from({ length: count }, (_, i) => ({
    id: `q${i.toString(36).padStart(5, '0')}`,
    start: i * 8,
    end: i * 8 + 8,
    rate: 1,
    label: '训'.repeat(20),
    inQueue: true,
  }));
  return {
    v: 1,
    video: { type: 'local', filename: 'workout.mp4', duration: count * 8 + 80 },
    segments,
    sequence: segments.map((s) => s.id),
    loop: { mode: 'off' },
  };
}

function bulkConfig(count: number): PlayerConfig {
  const segments = Array.from({ length: count }, (_, i) => ({
    id: `s${i.toString(36).padStart(5, '0')}`,
    start: i * 10,
    end: i * 10 + 10,
    rate: 1,
    label: 'x'.repeat(14),
    inQueue: true,
  }));
  return {
    v: 1,
    video: { type: 'local', filename: 'workoutxxxxxxxxxx.mp4', duration: 2840 },
    segments,
    sequence: segments.map((s) => s.id),
    loop: { mode: 'off' },
  };
}

/** 以「指定配置 + 可选预置撤销栈」装配 controller（用于「原栈保留」断言） */
function setupWith(cfg: PlayerConfig, seedStack: AppState['undoStack'] = []): Setup {
  const storage = installFakeStorage();
  const store = createStore<AppState>({
    ...initialState,
    config: cfg,
    configOrigin: 'local-edit',
    videoReady: true,
    videoName: cfg.video.filename,
    videoDuration: cfg.video.duration,
    undoStack: seedStack,
    undoTotal: seedStack.length,
    undoRecoverable: seedStack.filter((e) => !e.stale && e.kind !== 'restore').length,
    undoBannerVisible: seedStack.length > 0,
  });
  const controller = createEditorController({
    store,
    persistence: fakePersistence(),
    video: { paused: true, duration: cfg.video.duration } as unknown as HTMLVideoElement,
    engine: new FakeEngine() as unknown as PlayerEngine,
  });
  return { controller, store, storage };
}

describe('v0.3.3 · 项3：字节级容量边界（282 通过 / 283 拒收，验收口径）', () => {
  it('282 段：删除条目 65,305 B ≤ 64KB → 正常追加（不误伤）', () => {
    const cfg = bulkConfig(282);
    const ctx = setupWith(cfg);
    const victim = cfg.segments[cfg.segments.length - 1].id;
    ctx.controller.removeSegment(victim);
    const st = ctx.store.get();

    // 边界前提自证：这条记录的实测字节必须真的在 64KB 之内（否则「通过」不说明任何事）
    const justPushed = st.undoStack[st.undoStack.length - 1];
    expect(justPushed.kind).toBe('delete-segment');
    expect(undoEntryBytes(justPushed)).toBeLessThanOrEqual(UNDO_ENTRY_MAX_BYTES);
    expect(undoEntryBytes(justPushed)).toBe(65305); // 固定形状下的实际值（形状一改，这里跟着变）

    expect(st.undoStack).toHaveLength(1);
    expect(st.undoBannerVisible).toBe(true);
    expect(st.undoBreak).toBeNull(); // 未触发容量痕迹
    expect(st.notices.filter((n) => n.kind === 'warn')).toHaveLength(0); // 不得有「过大的」警告
    expect(ctx.storage.has(UNDO_STORAGE_KEY)).toBe(true);
  });

  it('283 段：删除条目 65,537 B > 64KB → 拒收该条 + warn 提示 + 原栈原样保留（不塌栈）', () => {
    const cfg = bulkConfig(283);
    // 预置一条既有历史，用来证明「拒收的那条不会挤掉原栈」——旧行为会把它塌成 1 条（且是新的那条）
    const seed: AppState['undoStack'] = [
      {
        id: 1,
        createdAt: 1700000000000,
        kind: 'delete-segment',
        segLabel: '既有历史',
        pre: canonicalize(bulkConfig(3)),
        post: canonicalize(bulkConfig(2)),
      },
    ];
    const ctx = setupWith(cfg, seed);
    expect(ctx.store.get().undoStack).toHaveLength(1);

    ctx.controller.removeSegment(cfg.segments[cfg.segments.length - 1].id);
    const st = ctx.store.get();

    // 边界前提自证：这条记录的实测字节必须真的超 64KB（超出的幅度极小，正是「无缓冲」的体现）
    expect(undoEntryBytes({
      id: 2,
      createdAt: 1700000000000,
      kind: 'delete-segment',
      segLabel: 'x'.repeat(14),
      pre: canonicalize(cfg),
      post: canonicalize(bulkConfig(282)),
    })).toBe(65537); // 65,536 + 1

    // ① 拒收：不新增条目
    expect(st.undoStack).toHaveLength(1);
    expect(st.undoStack[0].id).toBe(1);
    expect(st.undoStack[0].segLabel).toBe('既有历史');
    // ② 原栈不被塌掉 / 不被新条替换（旧行为：[entry] 整栈替换）
    expect(st.undoStack.filter((e) => !e.stale)).toHaveLength(1);
    // ③ 痕迹：capacity 分类、dropped = 0（一条旧历史都没丢）
    expect(st.undoBreak).toMatchObject({ kind: 'capacity', dropped: 0 });
    // ④ 提示：warn 级，且明确告知「之前的撤销历史仍然保留」
    const warns = st.notices.filter((n) => n.kind === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].text).toContain('超过 64KB 上限');
    expect(warns[0].text).toContain('之前的撤销历史仍然保留');
    // ⑤ 横幅仍可见（旧历史还在、仍可恢复）
    expect(st.undoBannerVisible).toBe(true);
    // ⑥ 既有历史仍真的能用：点它不会被丢弃
    ctx.controller.undoDelete(1);
    expect(ctx.store.get().undoStack).toHaveLength(1);
  });
});


/**
 * v0.3.3 · 项3 · 中文段名下的字节护栏（缺陷 A 的用户可见后果）。
 *
 * 上面那组边界用例用的是 ASCII 段名（`x`.repeat(14)）——ASCII 下码元数 = 字节数，
 * 旧实现「取 String.length」在那儿恰好不失真，所以那一组**穿不过**缺陷 A。
 * 真实中文段名（一个汉字 3 字节 / 1 码元）才会让旧口径低估 19%–30%，
 * 把本该拒收的条目放进来、随后写存储时撞配额。本组用中文段名重测同一条判定链。
 */
describe('v0.3.3 · 项3：中文段名下字节护栏仍能拦住（缺陷 A）', () => {
  /** 230 段 / 段名 14 个汉字：真实 UTF-8 65,960 B（超 424 B），旧口径报 53,102 B 会放行 */
  function cjkBulkConfig(count: number): PlayerConfig {
    const segments = Array.from({ length: count }, (_, i) => ({
      id: `c${i.toString(36).padStart(5, '0')}`,
      start: i * 8,
      end: i * 8 + 8,
      rate: 1,
      label: '训'.repeat(14),
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

  it('230 段中文段名：条目真实超 64KB → 拒收该条 + warn 提示 + 原栈原样保留', () => {
    const cfg = cjkBulkConfig(230);
    const seed: AppState['undoStack'] = [
      {
        id: 1,
        createdAt: 1700000000000,
        kind: 'delete-segment',
        segLabel: '既有历史',
        pre: canonicalize(cjkBulkConfig(3)),
        post: canonicalize(cjkBulkConfig(2)),
      },
    ];
    const ctx = setupWith(cfg, seed);
    const victim = cfg.segments[cfg.segments.length - 1].id;
    ctx.controller.removeSegment(victim);
    const st = ctx.store.get();

    // 前提自证：这条被拒收的记录，真实字节必须真的超限（否则「拒收」不说明任何事）
    const wouldBeEntry = {
      id: 2,
      createdAt: 1700000000000,
      kind: 'delete-segment' as const,
      segLabel: '训'.repeat(14),
      pre: canonicalize(cfg),
      post: canonicalize(cjkBulkConfig(229)),
    };
    const realB = Buffer.byteLength(
      JSON.stringify({ v: 1, entries: [wouldBeEntry] }),
      'utf8',
    );
    expect(
      realB,
      `230 段中文条目真实 ${realB} B，应超过上限 ${UNDO_ENTRY_MAX_BYTES} B`,
    ).toBeGreaterThan(UNDO_ENTRY_MAX_BYTES);
    expect(undoEntryBytes(wouldBeEntry)).toBe(realB); // 口径与真实字节一致

    // ① 拒收：栈里仍是那条既有历史
    expect(st.undoStack).toHaveLength(1);
    expect(st.undoStack[0].id).toBe(1);
    // ② 痕迹：capacity 分类、dropped=0
    expect(st.undoBreak).toMatchObject({ kind: 'capacity', dropped: 0 });
    // ③ 提示：warn 级，写明超限字节与上限
    const warns = st.notices.filter((n) => n.kind === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].text).toContain(`${realB} 字节`);
    expect(warns[0].text).toContain('超过 64KB 上限');
    expect(warns[0].text).toContain('之前的撤销历史仍然保留');
    // ④ 横幅仍在（旧历史可用）
    expect(st.undoBannerVisible).toBe(true);
  });
});
