/**
 * v0.3.3 · 项2（判据 2-d / 2-e）：通知暂停登记的接线用例。
 *
 * 背景：同一功能曾被两批补丁各写了一遍——07 号补丁在 `src/app/controller.ts` 建了
 * 按视图分键的登记（`pausedViews` 集合：detail / recycle / cockpit / hover），03 号
 * 补丁又在 `src/ui/editor.ts` 的 `render()` 里建了第二套（`pauseReasons` + `syncModalPause`），
 * 把三种弹层视图全部经 `pauseNoticeTimers()` 塞进 controller 的 `'hover'` 键。
 * 两套同挂在同一个 store 上、同一次状态变更里都执行，互相拆台：
 *   ① editor 侧无条件登记 'detail'（没有断点门）→ 桌面端打开右栏也暂停；
 *   ② 弹层视图与 hover 共用 'hover' 一个键 → 指针进出通知区会把弹层的暂停一起撤销。
 *
 * 本文件的 4 条用例即这两条语义的判据。它们驱动的是**真实的 UI 路径**：
 * `createEditorView().bind()` → `store.update()` → 真实 `render()`。
 * 因此若 editor 侧的重复登记还在，这些用例会红——这正是「能拦住」与「新代码让旧
 * 行为变红」的区别。
 *
 * 测试缝：node 环境无 DOM 库（且本批次不允许新增依赖），故在此手写最小 DOM 桩；
 * `pauseDepth()` 是 controller 内部 noticeCenter 的私有量，经 `vi.mock` 包一层
 * `createNoticeCenter` 取到实例观察，**不必为测试改动 controller 的生产代码**。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeEngine } from '../fakes/fake-engine';
import { createStore } from '../../../src/app/store';
import { initialState, type AppState } from '../../../src/app/state';
import { makeConfig, makeSegment } from '../helpers';
import type { Persistence } from '../../../src/core/config/persistence';
import type { PlayerConfig } from '../../../src/core/config/schema';
import type { PlayerEngine } from '../../../src/core/player/engine';
import type { NoticeCenter } from '../../../src/app/notice-center';

// ---- noticeCenter 实例捕获 + pauseAll/resumeAll 调用计数（不触碰生产代码） ----
const hoisted = vi.hoisted(() => ({
  ref: null as NoticeCenter | null,
  pauseAllCalls: 0,
  resumeAllCalls: 0,
}));
import { vi } from 'vitest';

vi.mock('../../../src/app/notice-center', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/app/notice-center')>();
  return {
    ...orig,
    createNoticeCenter: (opts: Parameters<typeof orig.createNoticeCenter>[0]) => {
      const real = orig.createNoticeCenter(opts);
      const center: NoticeCenter = {
        ...real,
        pauseAll: () => {
          hoisted.pauseAllCalls += 1;
          real.pauseAll();
        },
        resumeAll: () => {
          hoisted.resumeAllCalls += 1;
          real.resumeAll();
        },
      };
      hoisted.ref = center;
      return center;
    },
  };
});

// ---- 最小 DOM 桩（只覆盖 editor.ts / 子视图真实用到的那部分 API） ----
type L = { type: string; fn: (ev: unknown) => void };

class TextNode {
  nodeType = 3;
  parent: MiniNode | null = null;
  constructor(public data: string) {}
  get textContent(): string {
    return this.data;
  }
  remove(): void {
    const p = this.parent;
    if (!p) return;
    const i = p.childNodes.indexOf(this);
    if (i >= 0) p.childNodes.splice(i, 1);
    this.parent = null;
  }
}

class MiniNode {
  nodeType = 1;
  childNodes: Array<MiniNode | TextNode> = [];
  attrs: Record<string, string> = {};
  listeners: L[] = [];
  hidden = false;
  value = '';
  checked = false;
  className = '';
  parent: MiniNode | null = null;
  style: Record<string, string> & {
    setProperty?: (k: string, v: string) => void;
    getPropertyValue?: (k: string) => string;
  } = {};

  constructor(public tagName: string) {
    const map: Record<string, string> = {};
    this.style.setProperty = (k: string, v: string) => {
      map[k] = v;
    };
    this.style.getPropertyValue = (k: string) => map[k] ?? '';
  }

  get children(): MiniNode[] {
    return this.childNodes.filter((n): n is MiniNode => n.nodeType === 1);
  }

  get classList() {
    const read = (): string[] => (this.attrs.class ?? '').split(/\s+/).filter(Boolean);
    const write = (v: string[]): void => {
      this.attrs.class = v.join(' ');
    };
    return {
      add: (...c: string[]) => write([...new Set([...read(), ...c])]),
      remove: (...c: string[]) => write(read().filter((x) => !c.includes(x))),
      contains: (c: string) => read().includes(c),
      toggle: (c: string, on?: boolean) => {
        const has = read().includes(c);
        const want = on === undefined ? !has : on;
        if (want && !has) write([...read(), c]);
        if (!want && has) write(read().filter((x) => x !== c));
      },
    };
  }

  get dataset(): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(this.attrs)) {
      if (k.startsWith('data-')) {
        out[k.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
      }
    }
    return out;
  }

  get textContent(): string {
    return this.childNodes.map((n) => n.textContent).join('');
  }
  set textContent(v: string) {
    for (const n of this.childNodes) n.parent = null;
    this.childNodes = [];
    if (v !== '') {
      const t = new TextNode(v);
      t.parent = this;
      this.childNodes.push(t);
    }
  }

  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
    if (k === 'class') this.className = v;
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  toggleAttribute(k: string, on?: boolean): void {
    const has = Object.hasOwn(this.attrs, k);
    const want = on === undefined ? !has : on;
    if (want && !has) this.attrs[k] = '';
    if (!want && has) delete this.attrs[k];
  }

  appendChild(n: MiniNode | TextNode): void {
    n.parent = this;
    this.childNodes.push(n);
  }
  append(...nodes: Array<MiniNode | TextNode | string>): void {
    for (const n of nodes) {
      this.appendChild(typeof n === 'string' ? new TextNode(n) : n);
    }
  }
  insertBefore(n: MiniNode | TextNode, ref: MiniNode | TextNode | null): void {
    n.parent = this;
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(n);
    else this.childNodes.splice(i, 0, n);
  }
  replaceChildren(...nodes: Array<MiniNode | TextNode | string>): void {
    for (const n of this.childNodes) n.parent = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  remove(): void {
    const p = this.parent;
    if (!p) return;
    const i = p.childNodes.indexOf(this);
    if (i >= 0) p.childNodes.splice(i, 1);
    this.parent = null;
  }

  /** 极简选择器：只支持 `[attr="v"]`、`tag`、`tag[attr]`（editor 侧实际用到的三种形态） */
  private matches(sel: string): boolean {
    const attrOnly = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel);
    if (attrOnly) {
      const [, k, v] = attrOnly;
      if (!Object.hasOwn(this.attrs, k)) return false;
      return v === undefined || this.attrs[k] === v;
    }
    const tagAttr = /^([a-z]+)\[([\w-]+)\]$/.exec(sel);
    if (tagAttr) {
      const [, tag, k] = tagAttr;
      return this.tagName === tag && Object.hasOwn(this.attrs, k);
    }
    return this.tagName === sel;
  }

  private walk(): MiniNode[] {
    const out: MiniNode[] = [];
    for (const c of this.children) {
      out.push(c, ...c.walk());
    }
    return out;
  }

  querySelector(sel: string): MiniNode | null {
    return this.walk().find((n) => n.matches(sel)) ?? null;
  }
  querySelectorAll(sel: string): MiniNode[] {
    return this.walk().filter((n) => n.matches(sel));
  }
  closest(sel: string): MiniNode | null {
    if (this.matches(sel)) return this;
    let p: MiniNode | null = this.parent;
    while (p) {
      if (p.matches(sel)) return p;
      p = p.parent;
    }
    return null;
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.push({ type, fn });
  }
  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn));
  }
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
  select(): void {}
  click(): void {
    for (const l of this.listeners) if (l.type === 'click') l.fn({ target: this });
  }
  focus(): void {}
  getBoundingClientRect(): { height: number; width: number; top: number; left: number } {
    return { height: 0, width: 0, top: 0, left: 0 };
  }
}

type Globals = Record<string, unknown>;
const g = globalThis as unknown as Globals;

/** 桌面断点开关：`isDesktopViewport()` 读 window.matchMedia，按用例切换 */
let desktop = false;

function installMiniDom(): void {
  const documentElement = new MiniNode('html');
  const body = new MiniNode('body');
  const doc = {
    documentElement,
    body,
    visibilityState: 'visible',
    addEventListener(): void {},
    removeEventListener(): void {},
    createElement: (tag: string) => new MiniNode(tag),
    createTextNode: (t: string) => new TextNode(t),
    getElementById(): MiniNode | null {
      return null;
    },
  };
  g.document = doc;
  g.Element = MiniNode;
  g.Node = MiniNode;
  g.requestAnimationFrame = (fn: () => void) => {
    fn();
    return 1;
  };
  g.cancelAnimationFrame = () => {};
  g.window = {
    addEventListener(): void {},
    removeEventListener(): void {},
    location: { search: '', hash: '', pathname: '/' },
    history: { replaceState(): void {} },
    localStorage: makeStorage(),
    matchMedia: (q: string) => ({ matches: q.includes('960') ? desktop : false, media: q }),
    __GYMPLAY_TEST_FREEZE_NOTICES__: true,
  };
  Object.defineProperty(g, 'navigator', {
    value: { webdriver: false, clipboard: { writeText: async () => {} } },
    configurable: true,
  });
}

function makeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  } as unknown as Storage;
}

installMiniDom();

const { createEditorController } = await import('../../../src/app/controller');
const { createEditorView } = await import('../../../src/ui/editor');

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

interface Ctx {
  controller: ReturnType<typeof createEditorController>;
  store: ReturnType<typeof createStore<AppState>>;
  center: NoticeCenter;
}

/**
 * 按 main.ts 的真实装配顺序建视图并绑定：
 * createEditorView → createEditorController → bind（bind 内首帧 render）。
 */
function setup(): Ctx {
  hoisted.ref = null;
  hoisted.pauseAllCalls = 0;
  hoisted.resumeAllCalls = 0;
  const cfg = threeSegConfig();
  const store = createStore<AppState>({
    ...initialState,
    config: cfg,
    configOrigin: 'local-edit',
    videoReady: true,
    videoName: cfg.video.filename,
    videoDuration: cfg.video.duration,
  });
  const root = new MiniNode('div');
  const view = createEditorView(root as unknown as HTMLElement);
  const controller = createEditorController({
    store,
    persistence: fakePersistence(),
    video: view.video,
    engine: new FakeEngine() as unknown as PlayerEngine,
  });
  view.bind(store, controller);
  const center = hoisted.ref;
  if (!center) throw new Error('noticeCenter 未被捕获：vi.mock 未生效');
  return { controller, store, center };
}

describe('v0.3.3 · 项2：通知暂停登记接线（判据 2-d / 2-e）', () => {
  let ctx: Ctx;
  beforeEach(() => {
    desktop = false; // 默认移动端（<960）：detail-sheet 是浮层，遮挡通知区
    ctx = setup();
  });

  it('1. 移动端：开详情 → pauseDepth 1；关详情 → 归 0', () => {
    ctx.controller.selectSegment('bbb111');
    expect(ctx.store.get().selectedSegmentId).toBe('bbb111');
    expect(ctx.center.pauseDepth()).toBe(1);

    ctx.controller.deselectSegment();
    expect(ctx.store.get().selectedSegmentId).toBeNull();
    expect(ctx.center.pauseDepth()).toBe(0);
  });

  it('2. 桌面端：开详情 → pauseDepth 必须仍为 0（右栏是 position: static，不遮挡）', () => {
    desktop = true; // ≥960px
    ctx.controller.selectSegment('bbb111');
    expect(ctx.store.get().selectedSegmentId).toBe('bbb111');
    // 判据本身：桌面端不得因打开右栏而制造暂停源
    expect(ctx.center.pauseDepth()).toBe(0);
  });

  it('3. 分层配对：开详情 + 开回收站 → 深度 1；关详情仍暂停；关回收站归 0', () => {
    ctx.controller.selectSegment('bbb111');
    ctx.controller.openRecycle();
    // 集合型登记：两层同时在，只对 notice-center 形成一次配对（不是 +2）
    expect(ctx.center.pauseDepth()).toBe(1);

    ctx.controller.deselectSegment();
    // 关掉其中一层不得误解另一层：详情关了，回收站还开着 → 仍在暂停
    expect(ctx.center.pauseDepth()).toBeGreaterThan(0);

    ctx.controller.closeRecycle();
    expect(ctx.center.pauseDepth()).toBe(0);
  });

  it('4. 两套登记不再互相拆台：弹层与 hover 互不撤销对方', () => {
    // 方向一：详情开着时指针移出通知区（hover → false），弹层的暂停必须仍在
    ctx.controller.selectSegment('bbb111');
    ctx.controller.pauseNoticeTimers(); // 先进入通知区（hover 键置位）
    ctx.controller.resumeNoticeTimers(); // 指针移出通知区（hover 键取消）
    expect(ctx.center.pauseDepth()).toBeGreaterThan(0);

    // 方向二：指针仍在通知区（hover 保持 true）时关掉回收站，回收站的暂停取消，
    // 但 hover 这一层的暂停必须仍在
    ctx.controller.deselectSegment();
    ctx.controller.closeRecycle();
    ctx.controller.pauseNoticeTimers();
    ctx.controller.openRecycle();
    ctx.controller.closeRecycle();
    expect(ctx.center.pauseDepth()).toBeGreaterThan(0);
  });
});
