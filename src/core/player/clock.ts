/**
 * L1 · Clock 接口与时间源决策。
 *
 * 可测性设计（蓝图 §6.2）：调度器不读 Date.now / performance.now，
 * 只读注入的 Clock；测试用脚本化 FakeClock 逐步推进断言。
 *
 * 调度主线决策（P3 实测，2026-11 iPhone 真机）：
 *   rVFC 主线 P95=0.024s、setInterval(50ms) 对照 P95=0.037s，均 ≤0.300s
 *   → 主线 = rVFC，50ms 轮询兜底；两种模式都实现，运行时可降级。
 */

export interface Clock {
  /** 单调递增的挂钟秒数。 */
  now(): number;
  /** 注入式定时器（测试用 FakeClock 手动泵动）。 */
  setInterval(cb: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** 生产环境系统时钟。 */
export const systemClock: Clock = {
  now: () => performance.now() / 1000,
  setInterval: (cb, ms) => globalThis.setInterval(cb, ms),
  clearInterval: (handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]),
};

/** 轮询兜底间隔（P3 对照组参数） */
export const POLL_INTERVAL_MS = 50;
/** rVFC 通道静默超过该时长即降级到轮询（远大于 P3 实测 P95=0.024s 的正常间隔） */
export const RVFC_STALL_MS = 500;

export type TickStrategy = 'rvfc' | 'polling';

/**
 * 纯函数：按能力探测结果选调度主线。
 * rVFC 可用 → 主线 rVFC；不可用（含 iOS 旧版）→ 50ms 轮询兜底。
 */
export function chooseTickStrategy(caps: { rVFC: boolean }): TickStrategy {
  return caps.rVFC ? 'rvfc' : 'polling';
}
