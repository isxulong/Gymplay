/**
 * L0 · Screen Wake Lock 封装（请求 / 释放 / 失败回调）。
 *
 * P11 结论（2026-11 iPhone 实测 5 分钟不锁屏）：Wake Lock 有效 → 按「可用」
 * 路径实现；同时保留 API 缺失 / 请求被拒（低电量等）的静默降级——
 * 降级时由 onUnavailable 回调交给 UI 出文案 D（定稿 §1.2），功能本身不阻塞。
 * 页面回前台自动重新请求（系统会在切后台时释放锁）。
 */

/** 用户可见文案（定稿 §1.2 文案 D） */
export const COPY_WAKE_LOCK_UNAVAILABLE =
  '当前浏览器不支持自动保持亮屏。训练期间请在系统设置中将『自动锁定』调长，避免播放中断。';

interface WakeLockNavigator {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
}

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', cb: () => void): void;
}

interface VisibilityDocument {
  visibilityState: string;
  addEventListener(type: 'visibilitychange', cb: () => void): void;
}

export interface WakeLockController {
  readonly supported: boolean;
  /** 当前是否持有锁 */
  active(): boolean;
  /** 请求锁；返回是否成功持有。失败静默降级并触发 onUnavailable。 */
  request(): Promise<boolean>;
  release(): Promise<void>;
  /** API 缺失或请求被拒时回调（UI 出文案 D）。 */
  onUnavailable(cb: () => void): void;
  destroy(): void;
}

export function createWakeLock(nav?: WakeLockNavigator, doc?: VisibilityDocument): WakeLockController {
  const n = nav ?? (typeof navigator !== 'undefined' ? (navigator as WakeLockNavigator) : undefined);
  const d =
    doc ?? (typeof document !== 'undefined' ? (document as VisibilityDocument) : undefined);
  const supported = !!n?.wakeLock;
  let sentinel: WakeLockSentinelLike | null = null;
  let wantLock = false;
  let destroyed = false;
  const unavailableCbs = new Set<() => void>();

  function notifyUnavailable(): void {
    for (const cb of unavailableCbs) cb();
  }

  async function request(): Promise<boolean> {
    wantLock = true;
    if (!n?.wakeLock) {
      notifyUnavailable(); // 静默降级：不抛错，仅提示
      return false;
    }
    try {
      sentinel = await n.wakeLock.request('screen');
      sentinel.addEventListener('release', () => {
        sentinel = null;
      });
      return true;
    } catch {
      sentinel = null;
      notifyUnavailable();
      return false;
    }
  }

  // 回前台自动重取锁（P11 可用路径的一部分）
  const onVisible = (): void => {
    if (!destroyed && wantLock && d?.visibilityState === 'visible' && sentinel === null) {
      void request();
    }
  };
  d?.addEventListener('visibilitychange', onVisible);

  return {
    get supported() {
      return supported;
    },
    active: () => sentinel !== null && !sentinel.released,
    request,
    async release() {
      wantLock = false;
      const s = sentinel;
      sentinel = null;
      if (s && !s.released) {
        try {
          await s.release();
        } catch {
          // 释放失败无需上报
        }
      }
    },
    onUnavailable(cb) {
      unavailableCbs.add(cb);
    },
    destroy() {
      destroyed = true;
      wantLock = false;
      unavailableCbs.clear();
    },
  };
}
