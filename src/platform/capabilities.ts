/**
 * L0 · 能力探测（定稿 §2.1：Screen Wake Lock、localStorage 均由 L0 封装探测）。
 *
 * 结论喂给各层决策：调度主线选择（P3：rVFC / 50ms 轮询）、wake-lock 可用路径（P11）、
 * 引擎时间源通道、自动播放策略（P7-A：无手势 play() 必被拒，交互全部以用户点击起手）。
 * 所有探测防御性执行：任何 API 缺失/抛错都降级为「不可用」，绝不抛出。
 */

export interface Capabilities {
  /** requestVideoFrameCallback 可用（P1/P3 主线前提） */
  rVFC: boolean;
  /** 平台可设 playbackRate 区间（Firefox 区间外静音，引擎据此钳制） */
  rateRange: { min: number; max: number };
  /** Screen Wake Lock API 存在（P11：iPhone 实测有效） */
  wakeLock: boolean;
  /** Media Session API 存在 */
  mediaSession: boolean;
  /** HEVC 容器/编码可播性（P9：iPhone 实测 hev1/hvc1 双样本可直读） */
  hevc: 'supported' | 'unsupported' | 'unknown';
}

export interface CapabilitiesEnv {
  navigator?: Navigator;
  createVideo?: () => HTMLVideoElement;
}

export function detectCapabilities(env: CapabilitiesEnv = {}): Capabilities {
  const nav = env.navigator ?? (typeof navigator !== 'undefined' ? navigator : undefined);
  const createVideo =
    env.createVideo ?? (typeof document !== 'undefined' ? () => document.createElement('video') : undefined);

  let rVFC = false;
  let rateRange = { min: 0.5, max: 4 };
  let hevc: Capabilities['hevc'] = 'unknown';

  if (createVideo) {
    try {
      const video = createVideo();
      rVFC = 'requestVideoFrameCallback' in video;
      hevc = probeHevc(video);
      rateRange = probeRateRange(video) ?? rateRange;
    } catch {
      // 探测失败一律按不可用处理
    }
  }

  return {
    rVFC,
    rateRange,
    wakeLock: !!nav && 'wakeLock' in nav,
    mediaSession: !!nav && 'mediaSession' in nav,
    hevc,
  };
}

/** HEVC 双样本探测（P9：hev1 与 hvc1 任一可播即认为可直读）。 */
function probeHevc(video: HTMLVideoElement): 'supported' | 'unsupported' | 'unknown' {
  try {
    const hev1 = video.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"');
    const hvc1 = video.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"');
    if (hev1 === '' && hvc1 === '') return 'unsupported';
    return 'supported';
  } catch {
    return 'unknown';
  }
}

/**
 * rate 区间探测：写读 playbackRate 回环。部分平台写超界值会被钳回，
 * 读回值即平台上界；探测失败返回 null 用协议缺省。
 */
function probeRateRange(video: HTMLVideoElement): { min: number; max: number } | null {
  try {
    const original = video.playbackRate;
    video.playbackRate = 16;
    const max = video.playbackRate <= 0 || video.playbackRate > 16 ? 4 : Math.min(video.playbackRate, 4);
    video.playbackRate = original || 1;
    if (!Number.isFinite(max) || max <= 0) return null;
    return { min: 0.5, max: Math.max(0.5, max) };
  } catch {
    return null;
  }
}
