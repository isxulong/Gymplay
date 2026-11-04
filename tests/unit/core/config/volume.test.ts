/**
 * v0.3.1 · R2 音量偏好存取单测（验收标准 R2 AC3/AC6 的 Node 侧断言）。
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VOLUME_PREFS,
  VOLUME_STORAGE_KEY,
  clampVolume,
  createVolumePrefsStore,
  parseVolumePrefs,
  serializeVolumePrefs,
} from '../../../../src/core/config/volume';
import type { KeyValueStorage } from '../../../../src/core/config/persistence';

function memStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe('clampVolume', () => {
  it('钳制到 [0,1]，非有限数回退默认 1', () => {
    expect(clampVolume(0.3)).toBe(0.3);
    expect(clampVolume(-0.5)).toBe(0);
    expect(clampVolume(1.7)).toBe(1);
    expect(clampVolume(Number.NaN)).toBe(1);
  });
});

describe('parseVolumePrefs / serializeVolumePrefs', () => {
  it('往返一致；序列化时音量被钳制', () => {
    const raw = serializeVolumePrefs({ volume: 0.3, muted: true });
    expect(parseVolumePrefs(raw)).toEqual({ volume: 0.3, muted: true });
    expect(serializeVolumePrefs({ volume: 2, muted: false })).toBe('{"muted":false,"volume":1}');
  });

  it('缺失 / 损坏 / 字段非法 → null', () => {
    expect(parseVolumePrefs(null)).toBeNull();
    expect(parseVolumePrefs('not-json')).toBeNull();
    expect(parseVolumePrefs('{"volume":"0.3","muted":false}')).toBeNull();
    expect(parseVolumePrefs('{"volume":0.3}')).toBeNull();
    expect(parseVolumePrefs('[0.3,false]')).toBeNull();
  });
});

describe('createVolumePrefsStore（R2 AC3 按设备记忆）', () => {
  it('无存档 → 默认值（100%、非静音）', () => {
    const store = createVolumePrefsStore({ storage: memStorage() });
    expect(store.load()).toEqual(DEFAULT_VOLUME_PREFS);
    expect(store.degraded).toBe(false);
  });

  it('保存后可读回；键名为 gymplay:volume', () => {
    const storage = memStorage();
    const store = createVolumePrefsStore({ storage });
    store.save({ volume: 0.3, muted: false });
    expect(storage.data.has(VOLUME_STORAGE_KEY)).toBe(true);
    expect(createVolumePrefsStore({ storage }).load()).toEqual({ volume: 0.3, muted: false });
  });

  it('存档损坏 → 静默回退默认值', () => {
    const storage = memStorage();
    storage.setItem(VOLUME_STORAGE_KEY, '{broken');
    expect(createVolumePrefsStore({ storage }).load()).toEqual(DEFAULT_VOLUME_PREFS);
  });
});

describe('createVolumePrefsStore 存储降级（R2 AC6）', () => {
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

  it('存储抛错 → 降级为会话内记忆，不抛错、不阻断', () => {
    const store = createVolumePrefsStore({ storage: throwingStorage() });
    expect(store.degraded).toBe(true);
    expect(store.load()).toEqual(DEFAULT_VOLUME_PREFS);
    expect(() => store.save({ volume: 0.4, muted: true })).not.toThrow();
    expect(store.load()).toEqual({ volume: 0.4, muted: true });
  });
});


describe('createVolumePrefsStore 运行中降级', () => {
  it('探针通过后读写抛错 → 中途降级为会话内记忆', () => {
    const data = new Map<string, string>();
    let fail = false;
    const storage: KeyValueStorage = {
      getItem: (k) => {
        if (fail) throw new Error('denied');
        return data.get(k) ?? null;
      },
      setItem: (k, v) => {
        if (fail) throw new Error('denied');
        data.set(k, v);
      },
      removeItem: (k) => void data.delete(k),
    };
    const store = createVolumePrefsStore({ storage });
    expect(store.degraded).toBe(false);
    fail = true;
    expect(() => store.save({ volume: 0.6, muted: false })).not.toThrow();
    expect(store.degraded).toBe(true);
    expect(store.load()).toEqual({ volume: 0.6, muted: false });
  });
});
