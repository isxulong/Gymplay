/**
 * v0.3.1 · R1 垂直距离灵敏度档位单测（交互方案 v1.1 §7.3 / §9 清单第 4 条）。
 * 阈值 32/96px、迟滞 8px 为方案建议值。
 */

import { describe, expect, it } from 'vitest';
import {
  FINE_GEAR1_DY_PX,
  FINE_GEAR2_DY_PX,
  FINE_HYSTERESIS_PX,
  GEAR_LABELS,
  GEAR_RATIOS,
  SNAP_WINDOW_PX,
  gearForDistance,
  snapToBoundaries,
} from '../../../src/ui/editor/scrub-gear';

describe('gearForDistance 档位分段（不按角度，只看垂直距离）', () => {
  it('d ≤ 32px 保持 1x', () => {
    expect(gearForDistance(0, 0)).toBe(0);
    expect(gearForDistance(32, 0)).toBe(0);
  });

  it('32 < d ≤ 96 升入精调 1/4', () => {
    expect(gearForDistance(33, 0)).toBe(1);
    expect(gearForDistance(96, 0)).toBe(1);
  });

  it('d > 96 升入精调 1/8（含从 0 直接跳档）', () => {
    expect(gearForDistance(97, 0)).toBe(2);
    expect(gearForDistance(200, 1)).toBe(2);
  });

  it('向上（负距离）按 0 计：不进入精调', () => {
    expect(gearForDistance(-50, 0)).toBe(0);
  });
});

describe('gearForDistance 8px 迟滞（阈值附近往返不闪切）', () => {
  it('1/4 档回落到 32-8=24 以下才降回 1x', () => {
    expect(gearForDistance(30, 1)).toBe(1); // 阈值内 + 迟滞带
    expect(gearForDistance(25, 1)).toBe(1); // 迟滞带内不降
    expect(gearForDistance(24, 1)).toBe(0); // 越过迟滞才降
  });

  it('1/8 档回落到 96-8=88 以下才降到 1/4，再到 24 以下降回 1x', () => {
    expect(gearForDistance(95, 2)).toBe(2);
    expect(gearForDistance(89, 2)).toBe(2);
    expect(gearForDistance(88, 2)).toBe(1);
    expect(gearForDistance(24, 2)).toBe(0);
  });

  it('升档无迟滞：越过阈值即升', () => {
    expect(gearForDistance(FINE_GEAR1_DY_PX + 1, 0)).toBe(1);
    expect(gearForDistance(FINE_GEAR2_DY_PX + 1, 1)).toBe(2);
  });
});

describe('常量与标签（方案 v1.1 §8）', () => {
  it('阈值与迟滞为建议值 32/96/8', () => {
    expect(FINE_GEAR1_DY_PX).toBe(32);
    expect(FINE_GEAR2_DY_PX).toBe(96);
    expect(FINE_HYSTERESIS_PX).toBe(8);
  });

  it('档位比例 1 / 1/4 / 1/8，气泡文案齐备', () => {
    expect(GEAR_RATIOS).toEqual([1, 0.25, 0.125]);
    expect(GEAR_LABELS).toEqual(['1x', '精调 1/4', '精调 1/8']);
  });
});

describe('snapToBoundaries 段落边界吸附（v1.1 §3.2，复核一 P2-2）', () => {
  const BOUNDARIES = [0, 2, 5, 8, 10];
  // secPerPx = 0.01 → ±8px = ±0.08s、±4px = ±0.04s、±2px = ±0.02s

  it('1x 档落点在边界 ±8px 内吸附到该边界（含窗口边缘）', () => {
    expect(snapToBoundaries(2.05, BOUNDARIES, 0.01, 0)).toBe(2); // +5px
    expect(snapToBoundaries(1.93, BOUNDARIES, 0.01, 0)).toBe(2); // -7px
    expect(snapToBoundaries(2.08, BOUNDARIES, 0.01, 0)).toBe(2); // 恰在窗口边缘
  });

  it('1x 档超出 ±8px 不吸附', () => {
    expect(snapToBoundaries(2.09, BOUNDARIES, 0.01, 0)).toBeNull();
    expect(snapToBoundaries(3.5, BOUNDARIES, 0.01, 0)).toBeNull();
  });

  it('吸附窗口随档位缩小：±8px（1x）→ ±4px（1/4）→ ±2px（1/8）', () => {
    expect(SNAP_WINDOW_PX).toEqual([8, 4, 2]);
    expect(snapToBoundaries(2.05, BOUNDARIES, 0.01, 1)).toBeNull(); // 5px > 4px
    expect(snapToBoundaries(2.04, BOUNDARIES, 0.01, 1)).toBe(2); // 4px 恰在窗口内
    expect(snapToBoundaries(2.03, BOUNDARIES, 0.01, 2)).toBeNull(); // 3px > 2px
    expect(snapToBoundaries(2.02, BOUNDARIES, 0.01, 2)).toBe(2); // 2px 恰在窗口内
  });

  it('多边界同时入窗时吸附到最近边界', () => {
    // 3.0 距 2 为 1.0s、距 5 为 2.0s，窗口放宽后都应选 2
    expect(snapToBoundaries(2.04, [2, 2.06], 0.01, 0)).toBe(2.06); // 更近者优先
    expect(snapToBoundaries(3.0, BOUNDARIES, 0.2, 0)).toBe(2); // 窗口 ±1.6s，距 2 更近
  });

  it('边界集合为空或 secPerPx 非法时不吸附', () => {
    expect(snapToBoundaries(2.0, [], 0.01, 0)).toBeNull();
    expect(snapToBoundaries(2.0, BOUNDARIES, 0, 0)).toBeNull();
  });
});
