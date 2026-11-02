import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildHashWithKey,
  extractKeyFromHash,
  readKeyFromLocation,
  writeKeyToLocation,
} from '../../../../src/core/config/hash';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 构造一个带 hash 的假 location + replaceState spy 的假 window */
function stubWindow(hash: string): { replaceState: ReturnType<typeof vi.fn> } {
  const replaceState = vi.fn();
  vi.stubGlobal('window', {
    location: { hash, pathname: '/play', search: '' },
    history: { replaceState },
  });
  return { replaceState };
}

describe('hash 读写', () => {
  it('extract/build 互逆', () => {
    const key = 'eyJ2IjoxfQ-abc_DEF';
    expect(extractKeyFromHash(buildHashWithKey(key))).toBe(key);
  });

  it('空 hash / 无 c 参数 → null', () => {
    expect(extractKeyFromHash('')).toBeNull();
    expect(extractKeyFromHash('#')).toBeNull();
    expect(extractKeyFromHash('#x=1')).toBeNull();
    expect(extractKeyFromHash('#c=')).toBeNull();
  });

  it('多参数中定位 c（前后都有其他参数）', () => {
    expect(extractKeyFromHash('#a=1&c=KEY123&b=2')).toBe('KEY123');
    expect(extractKeyFromHash('#c=KEY123&b=2')).toBe('KEY123');
  });

  it('无 = 的裸参数被跳过', () => {
    expect(extractKeyFromHash('#fragment&c=K')).toBe('K');
    expect(extractKeyFromHash('#c')).toBeNull();
  });

  it('readKeyFromLocation 注入式读取', () => {
    expect(readKeyFromLocation({ hash: '#c=abc' })).toBe('abc');
    expect(readKeyFromLocation({ hash: '' })).toBeNull();
  });

  it('readKeyFromLocation 默认走 window.location；无 window 时返回 null', () => {
    stubWindow('#c=KEY9');
    expect(readKeyFromLocation()).toBe('KEY9');
    vi.unstubAllGlobals(); // Node 环境无 window
    expect(readKeyFromLocation()).toBeNull();
  });
});

describe('writeKeyToLocation', () => {
  it('写入密钥并保留其他 hash 参数（replaceState 不导航）', () => {
    const { replaceState } = stubWindow('#a=1&c=OLD');
    writeKeyToLocation('NEW_KEY');
    expect(replaceState).toHaveBeenCalledOnce();
    const url = replaceState.mock.calls[0][2] as string;
    expect(url).toBe('/play#a=1&c=NEW_KEY');
    expect(url.startsWith('#')).toBe(false);
  });

  it('key=null 清除 c 参数；无其他参数时 hash 置空', () => {
    const a = stubWindow('#a=1&c=OLD');
    writeKeyToLocation(null);
    expect(a.replaceState.mock.calls[0][2]).toBe('/play#a=1');

    const b = stubWindow('#c=OLD');
    writeKeyToLocation(null);
    expect(b.replaceState.mock.calls[0][2]).toBe('/play');
  });

  it('无 window / 无 replaceState 时静默跳过', () => {
    vi.stubGlobal('window', { location: { hash: '' }, history: {} }); // 无 replaceState
    expect(() => writeKeyToLocation('K')).not.toThrow();
    vi.unstubAllGlobals(); // 无 window
    expect(() => writeKeyToLocation('K')).not.toThrow();
  });
});
