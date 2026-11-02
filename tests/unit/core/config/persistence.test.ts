import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPersistence,
  type KeyValueStorage,
  type PlaybackSnapshot,
} from '../../../../src/core/config/persistence';
import { makeConfig } from '../../helpers';

/** 内存版 localStorage */
function fakeStorage(): KeyValueStorage & { dump: Map<string, string> } {
  const dump = new Map<string, string>();
  return {
    dump,
    getItem: (k) => dump.get(k) ?? null,
    setItem: (k, v) => void dump.set(k, v),
    removeItem: (k) => void dump.delete(k),
  };
}

/** 永远抛错的存储（模拟 iOS 隐私模式 / 配额 0） */
function throwingStorage(): KeyValueStorage {
  return {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
    removeItem: () => {
      throw new Error('denied');
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('persistence · 自动保存与恢复（定稿 §2.2）', () => {
  it('save 防抖 300ms：窗口内多次修改只落一次，内容为最新', () => {
    const storage = fakeStorage();
    const p = createPersistence({ storage });
    const a = makeConfig();
    const b = makeConfig({ loop: { mode: 'queue', count: 2 } });
    p.save(a);
    vi.advanceTimersByTime(100);
    p.save(b);
    expect(storage.dump.has('fvp:config')).toBe(false); // 防抖窗口内未落盘
    vi.advanceTimersByTime(300);
    expect(storage.dump.size).toBe(1);
    expect(p.load()?.loop).toEqual({ mode: 'queue', count: 2 });
  });

  it('saveNow 立即落盘，load 完整还原（序列化不压缩、可读 JSON）', () => {
    const storage = fakeStorage();
    const p = createPersistence({ storage });
    const cfg = makeConfig();
    p.saveNow(cfg);
    const text = storage.dump.get('fvp:config')!;
    expect(text).toContain('"segments"'); // 未压缩
    expect(p.load()).toEqual(cfg);
  });

  it('损坏 JSON → 静默丢弃回初始空态 + 控制台警告（F7 AC2 外延）', () => {
    const storage = fakeStorage();
    storage.dump.set('fvp:config', '{corrupted');
    const warn = vi.fn();
    const p = createPersistence({ storage, warn });
    expect(p.load()).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(storage.dump.has('fvp:config')).toBe(false); // 已清除
  });

  it('内容合法 JSON 但不过 Schema → 同样丢弃', () => {
    const storage = fakeStorage();
    storage.dump.set('fvp:config', '{"v":99}');
    const p = createPersistence({ storage, warn: () => {} });
    expect(p.load()).toBeNull();
  });

  it('存储探测失败 → 会话内内存降级 + 触发文案 F 回调（R14）', () => {
    const p = createPersistence({ storage: throwingStorage(), warn: () => {} });
    expect(p.degraded).toBe(true);
    const onDegraded = vi.fn();
    p.onDegraded(onDegraded);
    expect(onDegraded).toHaveBeenCalledOnce(); // 已降级时注册即回调
    // 降级后仍可在会话内保存/恢复
    const cfg = makeConfig();
    p.saveNow(cfg);
    expect(p.load()).toEqual(cfg);
  });

  it('运行期写入失败 → 降级为内存保存并回调', () => {
    const storage = fakeStorage();
    const p = createPersistence({ storage, warn: () => {} });
    expect(p.degraded).toBe(false);
    storage.setItem = () => {
      throw new Error('quota');
    };
    p.saveNow(makeConfig());
    expect(p.degraded).toBe(true);
    expect(p.load()).not.toBeNull(); // 内存兜底仍可读
  });

  it('clear 清除配置', () => {
    const storage = fakeStorage();
    const p = createPersistence({ storage });
    p.saveNow(makeConfig());
    p.clear();
    expect(p.load()).toBeNull();
  });

  it('读取时 getItem 抛错 → 运行期降级，后续写读走内存', () => {
    const storage = fakeStorage();
    const p = createPersistence({ storage, warn: () => {} });
    p.saveNow(makeConfig());
    expect(p.degraded).toBe(false);
    storage.getItem = () => {
      throw new Error('denied');
    };
    expect(p.load()).toBeNull(); // 底层读抛错且内存尚无缓存 → null
    expect(p.degraded).toBe(true);
    p.saveNow(makeConfig());
    expect(p.load()).not.toBeNull(); // 降级后写读走内存兜底
  });

  it('clear 时 removeItem 抛错 → 静默降级不崩溃', () => {
    const storage = fakeStorage();
    const p = createPersistence({ storage, warn: () => {} });
    p.saveNow(makeConfig());
    storage.removeItem = () => {
      throw new Error('denied');
    };
    expect(() => p.clear()).not.toThrow();
    expect(p.degraded).toBe(true);
  });

  it('Node 环境无 window → 默认存储探测失败 → 降级', () => {
    const p = createPersistence({ warn: () => {} }); // 不注入 storage
    expect(p.degraded).toBe(true);
  });

  it('window.localStorage 访问即抛错（极端隐私模式）→ 降级', () => {
    vi.stubGlobal('window', {
      get localStorage(): never {
        throw new Error('blocked');
      },
    });
    try {
      const p = createPersistence({ warn: () => {} });
      expect(p.degraded).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('降级前注册的回调：运行期写入失败时仍被触发', () => {
    const storage = fakeStorage();
    const p = createPersistence({ storage, warn: () => {} });
    const onDegraded = vi.fn();
    p.onDegraded(onDegraded); // 未降级时仅登记
    expect(onDegraded).not.toHaveBeenCalled();
    storage.setItem = () => {
      throw new Error('quota');
    };
    p.saveNow(makeConfig());
    expect(onDegraded).toHaveBeenCalledOnce();
  });

  it('防抖窗口内 clear → 撤销待写的定时器', () => {
    const storage = fakeStorage();
    const p = createPersistence({ storage });
    p.save(makeConfig()); // 进入防抖窗口
    p.clear(); // clear 应撤销 pending 定时器
    vi.advanceTimersByTime(300);
    expect(storage.dump.has('fvp:config')).toBe(false);
  });
});

describe('persistence · 播放进度快照（P7-B 回前台校准续播）', () => {
  const snap: PlaybackSnapshot = {
    queueIndex: 2,
    segmentId: 'abc123',
    offsetSec: 4.5,
    playing: true,
    savedAt: '2026-11-02T20:00:00+08:00',
  };

  it('快照往返', () => {
    const p = createPersistence({ storage: fakeStorage(), warn: () => {} });
    p.savePlayback(snapshot());
    expect(p.loadPlayback()).toEqual(snapshot());
    function snapshot(): PlaybackSnapshot {
      return { ...snap };
    }
  });

  it('损坏快照 → 静默丢弃', () => {
    const storage = fakeStorage();
    storage.dump.set('fvp:playback', '{"queueIndex":-1}');
    const warn = vi.fn();
    const p = createPersistence({ storage, warn });
    expect(p.loadPlayback()).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('非合法 JSON 的快照 → 同样静默丢弃', () => {
    const storage = fakeStorage();
    storage.dump.set('fvp:playback', '{corrupted');
    const warn = vi.fn();
    const p = createPersistence({ storage, warn });
    expect(p.loadPlayback()).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(storage.dump.has('fvp:playback')).toBe(false);
  });

  it('clearPlayback 生效', () => {
    const p = createPersistence({ storage: fakeStorage(), warn: () => {} });
    p.savePlayback(snap);
    p.clearPlayback();
    expect(p.loadPlayback()).toBeNull();
  });
});
