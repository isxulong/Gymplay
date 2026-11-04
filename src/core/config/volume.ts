/**
 * v0.3.1 · R2 音量偏好：按设备记忆（localStorage），不进分享密钥。
 *
 * 设计口径（需求文档 R2 方案要点 3/4）：
 * - 键 `gymplay:volume`，值为 JSON：{ volume: 0..1, muted: boolean }；
 * - 音量是设备环境相关偏好，不进入 URL hash 密钥 / .json 导出 / Schema v1 任何位置；
 * - 存取失败（隐私模式 / 配额）→ 静默降级为会话内记忆，不阻断播放、不弹提示；
 *   无存档时默认 volume=1、muted=false。
 *
 * 纯函数 + 注入式存储（复用 persistence 的 KeyValueStorage 抽象与降级模式），
 * Node 侧 vitest 覆盖（计入 core 覆盖率门禁）。
 */

import type { KeyValueStorage } from './persistence';

export const VOLUME_STORAGE_KEY = 'gymplay:volume';

export interface VolumePrefs {
  /** 0..1 */
  volume: number;
  muted: boolean;
}

export const DEFAULT_VOLUME_PREFS: VolumePrefs = { volume: 1, muted: false };

/** 钳制音量到 [0, 1]；非有限数回退 1（默认满音量）。 */
export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 1;
  return Math.min(1, Math.max(0, volume));
}

/** 序列化偏好（稳定 key 序，便于测试断言）。 */
export function serializeVolumePrefs(prefs: VolumePrefs): string {
  return JSON.stringify({ muted: prefs.muted, volume: clampVolume(prefs.volume) });
}

/** 解析存档；缺失 / 损坏 / 字段非法 → null（调用方回退默认值）。 */
export function parseVolumePrefs(raw: string | null): VolumePrefs | null {
  if (raw === null) return null;
  try {
    const x: unknown = JSON.parse(raw);
    if (typeof x !== 'object' || x === null) return null;
    const o = x as Record<string, unknown>;
    if (typeof o.volume !== 'number' || !Number.isFinite(o.volume)) return null;
    if (typeof o.muted !== 'boolean') return null;
    return { volume: clampVolume(o.volume), muted: o.muted };
  } catch {
    return null;
  }
}

export interface VolumePrefsStore {
  load(): VolumePrefs;
  save(prefs: VolumePrefs): void;
  /** true = 持久存储不可用，当前仅会话内记忆。 */
  readonly degraded: boolean;
}

function defaultStorage(): KeyValueStorage | undefined {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 音量偏好存取：写探测失败或运行期存取抛错 → 会话内内存降级（静默）。
 * 与 persistence 的降级纪律一致，但不共用其键空间与文案通道（R2 AC6：
 * 不报错、不弹阻断性提示）。
 */
export function createVolumePrefsStore(opts: { storage?: KeyValueStorage } = {}): VolumePrefsStore {
  const backing: KeyValueStorage | undefined = opts.storage ?? defaultStorage();
  let memory: string | null = null;
  let degraded = false;

  function probe(storage: KeyValueStorage): boolean {
    const probeKey = '__fvp_volume_probe__';
    try {
      storage.setItem(probeKey, '1');
      storage.removeItem(probeKey);
      return true;
    } catch {
      return false;
    }
  }

  if (!backing || !probe(backing)) degraded = true;

  return {
    get degraded() {
      return degraded;
    },
    load(): VolumePrefs {
      let raw: string | null;
      if (degraded) {
        raw = memory;
      } else {
        try {
          raw = backing!.getItem(VOLUME_STORAGE_KEY);
        } catch {
          degraded = true;
          raw = memory;
        }
      }
      return parseVolumePrefs(raw) ?? { ...DEFAULT_VOLUME_PREFS };
    },
    save(prefs: VolumePrefs): void {
      const raw = serializeVolumePrefs(prefs);
      if (degraded) {
        memory = raw;
        return;
      }
      try {
        backing!.setItem(VOLUME_STORAGE_KEY, raw);
      } catch {
        degraded = true;
        memory = raw;
      }
    },
  };
}
