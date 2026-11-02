/**
 * L0 · Media Session 封装（定稿 §2.3：play / pause / nexttrack / previoustrack）。
 * 线控（蓝牙耳机媒体键）经此映射到段控制；API 缺失或 setActionHandler
 * 抛错时静默降级为不可用（R13 降级由上层出文案）。
 */

export interface MediaSessionHandlers {
  onPlay: () => void;
  onPause: () => void;
  /** 下一段 */
  onNext: () => void;
  /** 上一段 */
  onPrevious: () => void;
}

export interface MediaSessionController {
  readonly supported: boolean;
  setPlaybackState(state: 'none' | 'paused' | 'playing'): void;
  setMetadata(meta: { title: string; artist?: string }): void;
  destroy(): void;
}

interface MediaSessionNavigator {
  mediaSession?: {
    setActionHandler(action: string, handler: (() => void) | null): void;
    playbackState: string;
    metadata: unknown;
  };
  // MediaMetadata 由构造环境提供
}

export function createMediaSession(
  handlers: MediaSessionHandlers,
  nav?: MediaSessionNavigator,
): MediaSessionController {
  const n = nav ?? (typeof navigator !== 'undefined' ? (navigator as MediaSessionNavigator) : undefined);
  const ms = n?.mediaSession;
  const supported = !!ms;

  if (ms) {
    const bind = (action: string, handler: () => void): void => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        // 个别平台不支持某 action（如 previoustrack）→ 跳过该键，其余保留
      }
    };
    bind('play', handlers.onPlay);
    bind('pause', handlers.onPause);
    bind('nexttrack', handlers.onNext);
    bind('previoustrack', handlers.onPrevious);
  }

  return {
    get supported() {
      return supported;
    },
    setPlaybackState(state) {
      if (ms) ms.playbackState = state;
    },
    setMetadata(meta) {
      if (!ms || typeof MediaMetadata === 'undefined') return;
      try {
        ms.metadata = new MediaMetadata({ title: meta.title, artist: meta.artist ?? 'Gymplay' });
      } catch {
        // 元数据失败不影响控制
      }
    },
    destroy() {
      if (!ms) return;
      for (const action of ['play', 'pause', 'nexttrack', 'previoustrack']) {
        try {
          ms.setActionHandler(action, null);
        } catch {
          // 忽略
        }
      }
    },
  };
}
