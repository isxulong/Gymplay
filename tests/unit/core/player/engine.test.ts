import { describe, expect, it } from 'vitest';
import { clampRate, DEFAULT_RATE_RANGE } from '../../../../src/core/player/engine';

describe('engine 纯函数 · clampRate（§2.5：Node 侧只测抽出的纯函数）', () => {
  it('协议缺省区间 0.5~4', () => {
    expect(DEFAULT_RATE_RANGE).toEqual({ min: 0.5, max: 4 });
  });

  it('区间内原样通过', () => {
    expect(clampRate(2)).toBe(2);
    expect(clampRate(0.5)).toBe(0.5);
    expect(clampRate(4)).toBe(4);
  });

  it('超界钳回端点（Firefox 区间外静音的防御）', () => {
    expect(clampRate(0.1)).toBe(0.5);
    expect(clampRate(16)).toBe(4);
  });

  it('平台区间收窄时按平台钳（如某平台 max=2）', () => {
    expect(clampRate(3, { min: 0.5, max: 2 })).toBe(2);
  });

  it('非法输入回 1x', () => {
    expect(clampRate(NaN)).toBe(1);
    expect(clampRate(Infinity)).toBe(1);
  });
});
