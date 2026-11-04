/**
 * v0.3.1 · R1 变速拖动（交互方案 v1.1 §7.3）：指尖与时间轴轨道中心线的
 * 垂直距离 d 驱动灵敏度档位（1x / 1/4 / 1/8），不按手势角度判定。
 *
 * 纯函数模块，Node 侧 vitest 直接覆盖。阈值与迟滞为方案建议值，
 * 集中在文件顶部常量便于真机实测后调参。
 *
 * 档位语义：
 * - d 只取垂直分量、向下为正（向上按 0 计，不进入精调）；
 * - 升档需越过阈值，降档需回落到阈值以下 FINE_HYSTERESIS_PX（8px 迟滞防闪切）；
 * - 同一垂直距离 → 同一档位（左下/右下斜拖与垂直下压等价）。
 */

/** 档位 0=1x 常速，1=精调 1/4，2=精调 1/8。 */
export type ScrubGear = 0 | 1 | 2;

// ---- 手势与档位常量（v1.1 §8；阈值/迟滞为建议值） ----
/** 轻点判定：按下→抬起时长上限（ms） */
export const TAP_MAX_MS = 300;
/** 点击/拖动消歧位移（px）：位移 < 此值视为点击（产品验收标准 R1 AC2/AC3 口径为 5px） */
export const MOVE_SLOP_PX = 5;
/** 精调 1/4 档触发距离（px）：d > 32 升档 */
export const FINE_GEAR1_DY_PX = 32;
/** 精调 1/8 档触发距离（px）：d > 96 升档 */
export const FINE_GEAR2_DY_PX = 96;
/** 迟滞区间（px）：降档需回落到阈值以下 8px */
export const FINE_HYSTERESIS_PX = 8;
/** 精调 1/4 灵敏度比例（≈2.2s/px @49min/340px） */
export const FINE_RATIO_1 = 1 / 4;
/** 精调 1/8 灵敏度比例（≈1.1s/px @49min/340px） */
export const FINE_RATIO_2 = 1 / 8;

/** 档位灵敏度乘数（相对 1x 直拖）。 */
export const GEAR_RATIOS: readonly [number, number, number] = [1, FINE_RATIO_1, FINE_RATIO_2];

/** 气泡档位文字（v1.1 §7.3 可发现性设计）。 */
export const GEAR_LABELS: readonly [string, string, string] = ['1x', '精调 1/4', '精调 1/8'];

/**
 * 垂直距离 + 当前档位 → 新档位（含 8px 迟滞）。
 * - d 为指尖到轨道中心线的垂直距离（px），向下为正；调用方保证 d ≥ 0。
 * - 升档阈值严格大于（d > 阈值），降档阈值含迟滞（d ≤ 阈值 - 8 才降）。
 */
export function gearForDistance(d: number, current: ScrubGear): ScrubGear {
  const dist = Math.max(0, d);
  if (current === 0) {
    if (dist > FINE_GEAR2_DY_PX) return 2;
    if (dist > FINE_GEAR1_DY_PX) return 1;
    return 0;
  }
  if (current === 1) {
    if (dist > FINE_GEAR2_DY_PX) return 2;
    if (dist <= FINE_GEAR1_DY_PX - FINE_HYSTERESIS_PX) return 0;
    return 1;
  }
  // current === 2
  if (dist <= FINE_GEAR2_DY_PX - FINE_HYSTERESIS_PX) {
    return dist <= FINE_GEAR1_DY_PX - FINE_HYSTERESIS_PX ? 0 : 1;
  }
  return 2;
}

// ---- v0.3.1 补强 · 段落边界吸附（v1.1 §3.2，复核一 P2-2） ----
/**
 * 吸附窗口（px，按档位）：1x → ±8px，随精调档缩小（1/4 → ±4px、1/8 → ±2px）。
 * ±8px / ±2px 为 v1.1 §3.2 方案值，1/4 档 ±4px 为两端的线性折中（建议值，可调）。
 */
export const SNAP_WINDOW_PX: readonly [number, number, number] = [8, 4, 2];

/**
 * 段落边界吸附：t（秒）距某边界在窗口内时返回该边界（多个命中取最近），否则 null。
 * 窗口按当前档位换算为秒：SNAP_WINDOW_PX[gear] × secPerPx（v1.1 §3.2「随精调档位缩小」）。
 */
export function snapToBoundaries(
  t: number,
  boundaries: readonly number[],
  secPerPx: number,
  gear: ScrubGear,
): number | null {
  if (secPerPx <= 0) return null;
  const windowSec = SNAP_WINDOW_PX[gear] * secPerPx;
  let best: number | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const b of boundaries) {
    const dist = Math.abs(t - b);
    if (dist <= windowSec + 1e-9 && dist < bestDist - 1e-12) {
      best = b;
      bestDist = dist;
    }
  }
  return best;
}
