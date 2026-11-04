/**
 * v0.3.2 · 项1：通知中心（纯逻辑，Node 可测；仿 persistence.ts 注入先例）。
 *
 * 职责：info 级通知的自动消失计时（默认 5s）、暂停/恢复（hover/focus 区域级暂停，
 * pause 冻结 deadline、resume 顺延剩余时长）、手动取消与销毁。
 * warn/error 永不自动消失、永不参与挤位。
 *
 * 冻结语义（完全静止，AB-P2-7 / D-9）：freeze = 不计时 + 不挤位。
 * 冻结通道与优先级（高 → 低，D-9）：
 * ① URL 参数 ?fvpNoticeTtl：0 = 冻结完全静止；正数 = 该次加载的 info TTL 毫秒（加速档）；
 * ② 注入标志 window.__GYMPLAY_TEST_FREEZE_NOTICES__（E2E auto-use fixture 主通道，
 *    per-browser-context 隔离）；
 * ③ navigator.webdriver === true（fixture 失效的零成本兜底）。
 */

import type { Notice } from './state';

export const NOTICE_INFO_TTL_MS = 5000;
export const NOTICE_INFO_CAP = 3;

export interface NoticeTiming {
  /** 完全静止：不计时 + 不挤位 */
  freeze: boolean;
  infoTtlMs: number;
}

/** 冻结通道解析（纯函数：依赖全部注入，Node 可测）。 */
export function resolveNoticeTiming(env: {
  search?: string;
  testFlag?: boolean;
  webdriver?: boolean;
}): NoticeTiming {
  const search = env.search ?? '';
  // 通道①：URL 参数（显式一等通道）
  const m = /[?&]fvpNoticeTtl=(\d+)/.exec(search);
  if (m) {
    const v = Number(m[1]);
    if (v === 0) return { freeze: true, infoTtlMs: NOTICE_INFO_TTL_MS };
    return { freeze: false, infoTtlMs: v };
  }
  // 通道②：E2E fixture 注入标志
  if (env.testFlag) return { freeze: true, infoTtlMs: NOTICE_INFO_TTL_MS };
  // 通道③：navigator.webdriver 兜底
  if (env.webdriver) return { freeze: true, infoTtlMs: NOTICE_INFO_TTL_MS };
  return { freeze: false, infoTtlMs: NOTICE_INFO_TTL_MS };
}

/**
 * 挤位纯函数：info 超过 cap 时返回需移除的最旧 info id（含新推入条目的视角，
 * 调用方把新通知并入数组后传入）。freeze 时调用方不应调用本函数（不挤位）。
 */
export function pruneInfos(notices: Notice[], cap: number): number[] {
  const infos = notices.filter((n) => n.kind === 'info');
  if (infos.length <= cap) return [];
  return infos.slice(0, infos.length - cap).map((n) => n.id);
}

interface TimerEntry {
  timerId: number;
  /** 到期时刻（now() 口径）；暂停时失效，恢复时重算 */
  deadline: number;
  /** 暂停后剩余毫秒；未暂停时等于 infoTtlMs */
  remainingMs: number;
}

export interface NoticeCenter {
  /** 登记一条通知：info 且未冻结 → 安排自动消失 */
  track(notice: Notice): void;
  /** 手动关闭 / 挤位移除时取消计时 */
  cancel(id: number): void;
  /** hover/focus 区域级暂停：清计时器、冻结剩余时长 */
  pauseAll(): void;
  /** 恢复：按剩余时长顺延重排 */
  resumeAll(): void;
  destroy(): void;
}

export function createNoticeCenter(opts: {
  infoTtlMs?: number;
  freeze?: boolean;
  setTimeoutFn?: (fn: () => void, ms: number) => number;
  clearTimeoutFn?: (id: number) => void;
  now?: () => number;
  onExpire: (id: number) => void;
}): NoticeCenter {
  const infoTtlMs = opts.infoTtlMs ?? NOTICE_INFO_TTL_MS;
  const freeze = opts.freeze ?? false;
  const setTimeoutFn =
    opts.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number);
  const clearTimeoutFn = opts.clearTimeoutFn ?? ((id: number) => clearTimeout(id as Parameters<typeof clearTimeout>[0]));
  const now = opts.now ?? (() => Date.now());

  const timers = new Map<number, TimerEntry>();

  function arm(id: number, ms: number): void {
    const timerId = setTimeoutFn(() => {
      timers.delete(id);
      opts.onExpire(id);
    }, ms);
    const prev = timers.get(id);
    if (prev) clearTimeoutFn(prev.timerId);
    timers.set(id, { timerId, deadline: now() + ms, remainingMs: ms });
  }

  return {
    track(notice): void {
      if (freeze || notice.kind !== 'info') return;
      arm(notice.id, infoTtlMs);
    },
    cancel(id): void {
      const e = timers.get(id);
      if (e) {
        clearTimeoutFn(e.timerId);
        timers.delete(id);
      }
    },
    pauseAll(): void {
      const t = now();
      for (const e of timers.values()) {
        if (e.timerId === -1) continue;
        e.remainingMs = Math.max(0, e.deadline - t);
        clearTimeoutFn(e.timerId);
        e.timerId = -1;
      }
    },
    resumeAll(): void {
      for (const [id, e] of [...timers]) {
        if (e.timerId !== -1) continue;
        if (e.remainingMs <= 0) {
          timers.delete(id);
          opts.onExpire(id);
          continue;
        }
        arm(id, e.remainingMs);
      }
    },
    destroy(): void {
      for (const e of timers.values()) clearTimeoutFn(e.timerId);
      timers.clear();
    },
  };
}
