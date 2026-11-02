/**
 * L1 · NativeEngine：基于 <video> 元素的 PlayerEngine 实现。
 *
 * 本文件是 DOM/媒体元素绑定层。按定稿 §2.5：jsdom/happy-dom 的
 * HTMLMediaElement 是 stub，NativeEngine 的契约一致性用例在 Playwright
 * 真实浏览器层执行（M1 起）；Node/Vitest 侧只测抽出的纯函数
 * （clampRate / chooseTickStrategy）。因此本文件不进 core 覆盖率统计。
 *
 * 关键行为：
 * - 时间源三通道归一：rVFC（主线，P3 实测最优）+ timeupdate + 50ms 轮询兜底，
 *   择优与降级是引擎内部细节，调度器只消费统一的 onTick；
 * - setRate：按能力区间钳制（Firefox 区间外静音），preservesPitch 默认开启（P4 结论）；
 * - play()：无手势被拒（P7-A，预期行为）→ 上报 gesture-required，由上层引导用户点击；
 * - P8：video 元素需带 playsinline（由 UI/装配层设置，此处防御性再设一次）。
 */

import {
  clampRate,
  type EngineEvent,
  type PlayerEngine,
  type RateRange,
  type VideoSource,
} from './engine';

interface PitchVideoElement extends HTMLVideoElement {
  // rVFC（requestVideoFrameCallback/cancelVideoFrameCallback）在当前 DOM lib 中
  // 已有类型声明；是否可用以运行时 `'requestVideoFrameCallback' in video` 判定。
  webkitPreservesPitch?: boolean;
  mozPreservesPitch?: boolean;
}

export interface NativeEngineOptions {
  rateRange?: RateRange;
  /** rVFC 是否可用（L0 能力探测结论注入） */
  rVFC: boolean;
}

export function createNativeEngine(video: PitchVideoElement, opts: NativeEngineOptions): PlayerEngine {
  const range = opts.rateRange ?? { min: 0.5, max: 4 };
  const tickCbs = new Set<(now: number) => void>();
  const eventCbs = new Set<(e: EngineEvent) => void>();
  let destroyed = false;
  let rvfcHandle: number | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  video.playsInline = true; // P8：页内播放成立

  function emitTick(): void {
    for (const cb of tickCbs) cb(video.currentTime);
  }

  function emitEvent(e: EngineEvent): void {
    for (const cb of eventCbs) cb(e);
  }

  function startChannels(): void {
    // 主线：rVFC（P3 实测 P95=0.024s）
    if (opts.rVFC && typeof video.requestVideoFrameCallback === 'function') {
      const loop = (): void => {
        if (destroyed) return;
        emitTick();
        rvfcHandle = video.requestVideoFrameCallback!(loop);
      };
      rvfcHandle = video.requestVideoFrameCallback(loop);
    }
    // 兜底：50ms 轮询（P3 对照组，实测 P95=0.037s 亦达标）
    pollTimer = setInterval(emitTick, 50);
  }

  function onTimeUpdate(): void {
    emitTick();
  }
  function onStalled(): void {
    emitEvent({ type: 'stalled' });
  }
  function onEnded(): void {
    emitEvent({ type: 'ended' });
  }
  function onError(): void {
    emitEvent({ type: 'error', message: `媒体错误（code=${String(video.error?.code ?? 'unknown')}）` });
  }

  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('stalled', onStalled);
  video.addEventListener('ended', onEnded);
  video.addEventListener('error', onError);

  return {
    async load(source: VideoSource): Promise<void> {
      video.src = source.url;
      video.preload = 'auto';
      await new Promise<void>((resolve, reject) => {
        const ok = (): void => cleanup(resolve);
        const bad = (): void => cleanup(() => reject(new Error('视频元数据加载失败')));
        const cleanup = (done: () => void): void => {
          video.removeEventListener('loadedmetadata', onOk);
          video.removeEventListener('error', onBad);
          done();
        };
        const onOk = (): void => ok();
        const onBad = (): void => bad();
        video.addEventListener('loadedmetadata', onOk);
        video.addEventListener('error', onBad);
        video.load();
      });
      startChannels();
    },
    async play(): Promise<void> {
      try {
        await video.play();
      } catch (err) {
        // P7-A：无手势 play() 被拒属预期——上报由上层引导用户点击起手
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          emitEvent({ type: 'gesture-required' });
          return;
        }
        throw err;
      }
    },
    pause(): void {
      video.pause();
    },
    seek(seconds: number): void {
      video.currentTime = Math.max(0, seconds);
    },
    setRate(rate: number): void {
      video.playbackRate = clampRate(rate, range);
      // P4 听感结论：preservesPitch 默认开启（0.5~2x 听感跟练区）
      video.preservesPitch = true;
      video.webkitPreservesPitch = true;
      video.mozPreservesPitch = true;
    },
    getTime(): number {
      return video.currentTime;
    },
    onTick(cb) {
      tickCbs.add(cb);
    },
    onEvent(cb) {
      eventCbs.add(cb);
    },
    destroy(): void {
      destroyed = true;
      if (rvfcHandle !== null && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(rvfcHandle);
      }
      if (pollTimer !== null) clearInterval(pollTimer);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('stalled', onStalled);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      tickCbs.clear();
      eventCbs.clear();
      video.removeAttribute('src');
      video.load();
    },
  };
}
