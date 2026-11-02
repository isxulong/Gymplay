/**
 * L3 旁挂 · 本地自动保存与恢复（定稿 §2.2 persistence 子模块）
 *
 * - key 为 `fvp:config`；任何配置变更后防抖 300ms 写入；
 * - 序列化复用与密钥相同的规范化 JSON（不经压缩）；
 * - 恢复时先过 validate；校验失败 / 数据损坏 → 静默丢弃回初始空态，仅控制台留警告
 *   （F7 AC2 的合理外延：AC2 原文场景为存储被清空，此处扩至数据损坏）；
 * - 写入用 try/catch 探测，失败（隐私模式 / 配额 0）→ 降级为会话内内存保存 +
 *   触发文案 F（R14，定稿 §1.2）。
 *
 * P7-B 兜底语义（探针结论：iOS 切后台音频中断）：本模块同时提供播放进度快照
 * （`fvp:playback`），配合 SegmentScheduler.resync() 实现「回前台 currentTime 校准续播」；
 * 快照与配置同属一套「校验失败静默丢弃」纪律。
 */

import { canonicalize } from './codec';
import { validate, type PlayerConfig } from './schema';

export const CONFIG_STORAGE_KEY = 'fvp:config';
export const PLAYBACK_STORAGE_KEY = 'fvp:playback';
export const SAVE_DEBOUNCE_MS = 300;

/** 用户可见文案（定稿 §1.2 文案 F） */
export const COPY_STORAGE_UNAVAILABLE =
  '当前浏览器无法本地保存（可能处于隐私模式）。配置只保留在本次会话中，建议生成分享链接或导出配置备份。';

/** localStorage 的最小结构抽象，便于测试注入假存储。 */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 播放进度快照（P7-B 恢复设计）。 */
export interface PlaybackSnapshot {
  /** 队列内下标（PlayPlan.items 的 index） */
  queueIndex: number;
  segmentId: string;
  /** 段内偏移（秒） */
  offsetSec: number;
  playing: boolean;
  /** ISO 时间戳 */
  savedAt: string;
}

export interface Persistence {
  /** 防抖保存（默认 300ms 合并）。 */
  save(cfg: PlayerConfig): void;
  /** 立即保存（页面隐藏 / 关闭前调用）。 */
  saveNow(cfg: PlayerConfig): void;
  /** 读取并校验；损坏 / 校验失败 → 静默丢弃返回 null（控制台留警告）。 */
  load(): PlayerConfig | null;
  clear(): void;
  /** true = 持久存储不可用，当前仅会话内内存保存。 */
  readonly degraded: boolean;
  /** 降级发生时回调（UI 层用于触发文案 F）。 */
  onDegraded(cb: () => void): void;
  savePlayback(snapshot: PlaybackSnapshot): void;
  loadPlayback(): PlaybackSnapshot | null;
  clearPlayback(): void;
}

export interface PersistenceOptions {
  storage?: KeyValueStorage;
  key?: string;
  playbackKey?: string;
  debounceMs?: number;
  /** 测试注入；默认取全局 setTimeout/clearTimeout。 */
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  warn?: (message: string) => void;
}

function defaultStorage(): KeyValueStorage | undefined {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

function isValidSnapshot(x: unknown): x is PlaybackSnapshot {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as Record<string, unknown>;
  return (
    Number.isInteger(s.queueIndex) &&
    (s.queueIndex as number) >= 0 &&
    typeof s.segmentId === 'string' &&
    typeof s.offsetSec === 'number' &&
    Number.isFinite(s.offsetSec) &&
    s.offsetSec >= 0 &&
    typeof s.playing === 'boolean' &&
    typeof s.savedAt === 'string'
  );
}

export function createPersistence(opts: PersistenceOptions = {}): Persistence {
  const key = opts.key ?? CONFIG_STORAGE_KEY;
  const playbackKey = opts.playbackKey ?? PLAYBACK_STORAGE_KEY;
  const debounceMs = opts.debounceMs ?? SAVE_DEBOUNCE_MS;
  const setTimeoutFn = opts.setTimeoutFn ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimeoutFn =
    opts.clearTimeoutFn ?? ((handle: unknown) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
  const warn = opts.warn ?? ((message: string) => console.warn(`[fvp] ${message}`));

  // 写入探测（定稿 §2.2）：失败 → 会话内内存降级 + 文案 F 钩子
  const memory = new Map<string, string>();
  let degraded = false;
  const degradedCallbacks: Array<() => void> = [];
  const backing: KeyValueStorage | undefined = opts.storage ?? defaultStorage();

  function probe(storage: KeyValueStorage): boolean {
    const probeKey = '__fvp_probe__';
    try {
      storage.setItem(probeKey, '1');
      storage.removeItem(probeKey);
      return true;
    } catch {
      return false;
    }
  }

  if (!backing || !probe(backing)) degraded = true;

  function markDegraded(): void {
    if (degraded) return;
    degraded = true;
    for (const cb of degradedCallbacks) cb();
  }

  function writeRaw(k: string, value: string): void {
    if (degraded) {
      memory.set(k, value);
      return;
    }
    try {
      backing!.setItem(k, value);
    } catch {
      // 运行期写入失败（如配额写满）→ 同样降级
      markDegraded();
      memory.set(k, value);
    }
  }

  function readRaw(k: string): string | null {
    if (degraded) return memory.get(k) ?? null;
    try {
      return backing!.getItem(k);
    } catch {
      markDegraded();
      return memory.get(k) ?? null;
    }
  }

  function removeRaw(k: string): void {
    memory.delete(k);
    if (degraded) return;
    try {
      backing!.removeItem(k);
    } catch {
      markDegraded();
    }
  }

  let pending: PlayerConfig | null = null;
  let timer: unknown = null;

  function flush(): void {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
    if (pending !== null) {
      writeRaw(key, canonicalize(pending));
      pending = null;
    }
  }

  return {
    get degraded() {
      return degraded;
    },
    onDegraded(cb) {
      if (degraded) cb();
      else degradedCallbacks.push(cb);
    },
    save(cfg) {
      pending = cfg;
      if (timer !== null) clearTimeoutFn(timer);
      timer = setTimeoutFn(flush, debounceMs);
    },
    saveNow(cfg) {
      pending = cfg;
      flush();
    },
    load() {
      const text = readRaw(key);
      if (text === null) return null;
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        warn('本地配置已损坏，已丢弃并回到初始空态');
        removeRaw(key);
        return null;
      }
      const result = validate(raw);
      if (!result.ok) {
        warn(`本地配置未通过校验（${result.error.message}），已丢弃并回到初始空态`);
        removeRaw(key);
        return null;
      }
      return result.value;
    },
    clear() {
      pending = null;
      if (timer !== null) {
        clearTimeoutFn(timer);
        timer = null;
      }
      removeRaw(key);
    },
    savePlayback(snapshot) {
      writeRaw(playbackKey, canonicalize(snapshot));
    },
    loadPlayback() {
      const text = readRaw(playbackKey);
      if (text === null) return null;
      try {
        const raw: unknown = JSON.parse(text);
        if (isValidSnapshot(raw)) return raw;
      } catch {
        // fall through
      }
      warn('播放进度快照已损坏，已丢弃');
      removeRaw(playbackKey);
      return null;
    },
    clearPlayback() {
      removeRaw(playbackKey);
    },
  };
}
