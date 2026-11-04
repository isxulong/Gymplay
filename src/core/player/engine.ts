/**
 * L1 · 播放器内核层：PlayerEngine 接口（层间契约，蓝图 §3.2）。
 *
 * 引擎是所有上层与浏览器怪异行为之间的唯一屏障。调度器只见本接口，
 * 测试用 FakeEngine 断言「指令序列正确」而非「视频真的在播」。
 * 接口粒度以蓝图为契约；getTime 为轮询调度模式（P3 兜底）所需的细化补充。
 */

/** 视频源描述。v1 仅本地文件（定稿 §2.4：video.type 仅 "local"）。 */
export interface VideoSource {
  kind: 'local';
  /** object URL（URL.createObjectURL 产物） */
  url: string;
  filename: string;
}

export type EngineEvent =
  | { type: 'stalled' }
  | { type: 'ended' }
  | { type: 'gesture-required' } // P7-A：无手势 play() 被拒，需用户点击起手
  | { type: 'error'; message: string };

export interface PlayerEngine {
  load(source: VideoSource): Promise<void>;
  /** 内部处理 iOS 手势解锁重试；被自动播放策略拒绝时上报 gesture-required。 */
  play(): Promise<void>;
  pause(): void;
  /** 跳转到指定秒数。 */
  seek(seconds: number): void;
  /** 内部按平台能力钳制并处理静音策略；preservesPitch 默认开启（P4 结论）。 */
  setRate(rate: number): void;
  /** v0.3.1 · R2：设置音量（0..1，超界钳制）。属运行时状态，不进分享密钥。 */
  setVolume(volume: number): void;
  /** v0.3.1 · R2：静音切换；取消静音后音量保持原值。 */
  setMuted(muted: boolean): void;
  /** 当前媒体时间（秒）。供轮询调度与 resync 校准使用。 */
  getTime(): number;
  /** 三通道归一（timeupdate + rVFC + 50ms 轮询兜底）的时间回调。 */
  onTick(cb: (now: number) => void): void;
  onEvent(cb: (e: EngineEvent) => void): void;
  destroy(): void;
}

export interface RateRange {
  min: number;
  max: number;
}

/** 协议区间（Schema v1：0.5 ≤ rate ≤ 4）。平台实际可用范围由引擎钳制，不进协议。 */
export const DEFAULT_RATE_RANGE: RateRange = { min: 0.5, max: 4 };

/**
 * 纯函数：把目标倍速钳制进平台能力区间（Firefox 等平台区间外会静音）。
 * §2.5：Node 侧 L1 只测这类抽出的纯函数。
 */
export function clampRate(rate: number, range: RateRange = DEFAULT_RATE_RANGE): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(range.max, Math.max(range.min, rate));
}
