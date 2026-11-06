/**
 * v0.3.3 · 项2：通知中心（纯逻辑，Node 可测；仿 persistence.ts 注入先例）。
 *
 * 职责：按级别自动消失计时、并发挤位、暂停/恢复、手动取消与销毁。
 * 分级口径（v0.3.3 起，替换 v0.3.2 的「warn/error 永不自动消失」）：
 * - info  5 秒到期，上限 3 条（`pruneInfos` 只挑 info）；
 * - warn  10 秒到期，独立上限 3 条；
 * - error 30 秒到期，独立上限 3 条；
 * - warn/error 各自按「同文案折叠计数」呈现（同一文案再次出现显示「×N」，不新增一行）；
 * - warn/error **不占 info 的挤位名额**（刻意保留：让告警参与 info 挤位会导致
 *   「唯一的失败原因被 3 条普通信息挤掉」）。
 * 计时精度：全部计时经注入的 setTimeoutFn / clearTimeoutFn / now 驱动，Node 可测。
 *
 * 冻结语义（完全静止，AB-P2-7 / D-9）：freeze = 不计时 + 不挤位（对 info/warn/error 一致）。
 * 冻结通道与优先级（高 → 低，D-9）：
 * ① URL 参数 ?fvpNoticeTtl：0 = 冻结完全静止；正数 = 该次加载的 info TTL 毫秒（加速档）；
 * ② 注入标志 window.__GYMPLAY_TEST_FREEZE_NOTICES__（E2E auto-use fixture 主通道，
 *    per-browser-context 隔离）；
 * ③ navigator.webdriver === true（fixture 失效的零成本兜底）。
 *
 * 暂停语义（v0.3.3 改为配对计数）：
 * - pauseAll/resumeAll 按「进入 +1 / 退出 −1、归零才真正恢复」配对，支持多层模态叠加
 *   （段详情面板 + 回收站 + 驾驶舱同时暂停，关掉其中一层不会误解其它层）；
 * - 暂停期间到达的新通知**不启动计时**：登记为休眠条目（timerId = -1、剩余时长 = 完整时长），
 *   恢复时按完整时长重新起算——既不在暂停期 arm，也不在恢复时立即过期。
 */

import type { Notice, NoticeKind } from './state';

/** 普通信息：5 秒 / 上限 3 条（v0.3.2 原值，v0.3.3 不变）。 */
export const NOTICE_INFO_TTL_MS = 5000;
export const NOTICE_INFO_CAP = 3;
/** 告警：10 秒 / 独立上限 3 条（v0.3.3 新增）。 */
export const NOTICE_WARN_TTL_MS = 10_000;
export const NOTICE_WARN_CAP = 3;
/** 错误：30 秒 / 独立上限 3 条（v0.3.3 新增；用户关掉弹层后仍有时间补看）。 */
export const NOTICE_ERROR_TTL_MS = 30_000;
export const NOTICE_ERROR_CAP = 3;

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
 * info 挤位纯函数：info 超过 cap 时返回需移除的最旧 info id（含新推入条目的视角，
 * 调用方把新通知并入数组后传入）。freeze 时调用方不应调用本函数（不挤位）。
 *
 * v0.3.3 语义不变：**只挑 info**——warn/error 不占 info 的挤位名额。
 */
export function pruneInfos(notices: Notice[], cap: number): number[] {
  const infos = notices.filter((n) => n.kind === 'info');
  if (infos.length <= cap) return [];
  return infos.slice(0, infos.length - cap).map((n) => n.id);
}

/**
 * 单一级别的独立挤位（v0.3.3 新增）：warn / error 各按自己的 cap 挤掉最旧的同级别条目。
 * 与 `pruneInfos` 互不影响——两套名额彼此独立。
 */
export function pruneKindNotices(notices: Notice[], kind: NoticeKind, cap: number): number[] {
  const same = notices.filter((n) => n.kind === kind);
  if (same.length <= cap) return [];
  return same.slice(0, same.length - cap).map((n) => n.id);
}

export interface NoticeCaps {
  info?: number;
  warn?: number;
  error?: number;
}

/**
 * 全级别挤位（v0.3.3 新增，供 controller 的 `notify()` 单点调用）。
 *
 * - info 走 `pruneInfos`（名额只算 info）；
 * - warn / error 各按**折叠后的条目数**计名额：同文案的 N 条算一组，只有整组被挤出时
 *   该组全部 id 才进入返回值——因此 17 条同文案告警不会互相挤掉，而是折叠成一组。
 */
export function pruneNotices(notices: Notice[], caps: NoticeCaps = {}): number[] {
  const infoCap = caps.info ?? NOTICE_INFO_CAP;
  const evict: number[] = [...pruneInfos(notices, infoCap)];
  const kindCaps: Array<[NoticeKind, number]> = [
    ['warn', caps.warn ?? NOTICE_WARN_CAP],
    ['error', caps.error ?? NOTICE_ERROR_CAP],
  ];
  for (const [kind, cap] of kindCaps) {
    const groups: Array<{ text: string; ids: number[] }> = [];
    const map = new Map<string, { text: string; ids: number[] }>();
    for (const n of notices) {
      if (n.kind !== kind) continue;
      const g = map.get(n.text);
      if (g) g.ids.push(n.id);
      else {
        const item = { text: n.text, ids: [n.id] };
        map.set(n.text, item);
        groups.push(item);
      }
    }
    if (groups.length <= cap) continue;
    for (const g of groups.slice(0, groups.length - cap)) evict.push(...g.ids);
  }
  return evict;
}

/** 折叠后的展示条目（同文案合并为一行，`count ≥ 2` 时 UI 显示「×N」）。 */
export interface NoticeDisplayItem {
  kind: NoticeKind;
  text: string;
  count: number;
  ids: number[];
}

/**
 * 展示侧折叠 + 独立上限（v0.3.3 新增，纯函数，UI 直接消费）。
 *
 * - info 不折叠：每条各占一行（保持 v0.3.2 的 E2E 口径：4 条同文案 info 仍显示 4 行）；
 * - warn / error 按「kind + 文案」折叠计数；
 * - warn / error 各只展示**最新的** cap 组（按到达顺序取尾部），即「可见 ≤ 3」；
 * - 返回顺序沿用到达顺序，info 与 warn/error 的相对次序不变。
 */
export function foldNotices(notices: Notice[], caps: NoticeCaps = {}): NoticeDisplayItem[] {
  const groups: NoticeDisplayItem[] = [];
  const map = new Map<string, NoticeDisplayItem>();
  for (const n of notices) {
    if (n.kind === 'info') {
      groups.push({ kind: n.kind, text: n.text, count: 1, ids: [n.id] });
      continue;
    }
    const key = `${n.kind}\u0000${n.text}`;
    const g = map.get(key);
    if (g) {
      g.count += 1;
      g.ids.push(n.id);
    } else {
      const item: NoticeDisplayItem = { kind: n.kind, text: n.text, count: 1, ids: [n.id] };
      map.set(key, item);
      groups.push(item);
    }
  }
  const warnCap = caps.warn ?? NOTICE_WARN_CAP;
  const errorCap = caps.error ?? NOTICE_ERROR_CAP;
  // 从尾部（最新）往回选中各类型的 quota，其余标记丢弃；info 一律保留
  const keep = new Set<NoticeDisplayItem>();
  let warnKeep = 0;
  let errorKeep = 0;
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const g = groups[i];
    if (g.kind === 'info') {
      keep.add(g);
    } else if (g.kind === 'warn') {
      if (warnKeep < warnCap) {
        warnKeep += 1;
        keep.add(g);
      }
    } else {
      if (errorKeep < errorCap) {
        errorKeep += 1;
        keep.add(g);
      }
    }
  }
  return groups.filter((g) => keep.has(g));
}

interface TimerEntry {
  timerId: number;
  /** 到期时刻（now() 口径）；暂停时失效，恢复时重算 */
  deadline: number;
  /** 暂停后剩余毫秒；未暂停时等于该级别的 TTL */
  remainingMs: number;
}

export interface NoticeCenter {
  /** 登记一条通知：未冻结 → 按级别安排自动消失（暂停期登记为休眠条目） */
  track(notice: Notice): void;
  /** 手动关闭 / 挤位移除时取消计时 */
  cancel(id: number): void;
  /** 暂停计时（配对：多次调用需等次数的 resumeAll 才恢复） */
  pauseAll(): void;
  /** 恢复计时（配对：计数归零才真正重排全部休眠计时器） */
  resumeAll(): void;
  /** 当前暂停深度（诊断 / 断言用） */
  pauseDepth(): number;
  destroy(): void;
}

export function createNoticeCenter(opts: {
  infoTtlMs?: number;
  warnTtlMs?: number;
  errorTtlMs?: number;
  freeze?: boolean;
  setTimeoutFn?: (fn: () => void, ms: number) => number;
  clearTimeoutFn?: (id: number) => void;
  now?: () => number;
  onExpire: (id: number) => void;
}): NoticeCenter {
  const infoTtlMs = opts.infoTtlMs ?? NOTICE_INFO_TTL_MS;
  const warnTtlMs = opts.warnTtlMs ?? NOTICE_WARN_TTL_MS;
  const errorTtlMs = opts.errorTtlMs ?? NOTICE_ERROR_TTL_MS;
  const freeze = opts.freeze ?? false;
  const setTimeoutFn =
    opts.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number);
  const clearTimeoutFn = opts.clearTimeoutFn ?? ((id: number) => clearTimeout(id as Parameters<typeof clearTimeout>[0]));
  const now = opts.now ?? (() => Date.now());

  const timers = new Map<number, TimerEntry>();
  /** 配对计数：进入模态 +1，退出 −1，归零才真正恢复 */
  let depth = 0;

  function ttlFor(kind: NoticeKind): number {
    if (kind === 'warn') return warnTtlMs;
    if (kind === 'error') return errorTtlMs;
    return infoTtlMs;
  }

  function arm(id: number, ms: number): void {
    const prev = timers.get(id);
    if (prev) clearTimeoutFn(prev.timerId);
    const timerId = setTimeoutFn(() => {
      timers.delete(id);
      opts.onExpire(id);
    }, ms);
    timers.set(id, { timerId, deadline: now() + ms, remainingMs: ms });
  }

  return {
    track(notice): void {
      // freeze = 完全静止：不计时、不挤位（对 info/warn/error 一致）
      if (freeze) return;
      const ms = ttlFor(notice.kind);
      if (ms <= 0) return;
      if (depth > 0) {
        // 暂停期间到达：不 arm（不启动计时），也不立即过期——登记休眠条目，
        // 恢复时按完整时长起算（既不吃掉暂停时长，也不会一恢复就消失）
        const prev = timers.get(notice.id);
        if (prev && prev.timerId !== -1) clearTimeoutFn(prev.timerId);
        timers.set(notice.id, { timerId: -1, deadline: now() + ms, remainingMs: ms });
        return;
      }
      arm(notice.id, ms);
    },
    cancel(id): void {
      const e = timers.get(id);
      if (e) {
        if (e.timerId !== -1) clearTimeoutFn(e.timerId);
        timers.delete(id);
      }
    },
    pauseAll(): void {
      depth += 1;
      if (depth > 1) return; // 已在暂停态：只累加计数，不重复冻结
      const t = now();
      for (const e of timers.values()) {
        if (e.timerId === -1) continue;
        e.remainingMs = Math.max(0, e.deadline - t);
        clearTimeoutFn(e.timerId);
        e.timerId = -1;
      }
    },
    resumeAll(): void {
      // 先减后判：多余 resume 在 0 处夹紧，不出现负深度（异常路径不漏减、也不多减）
      if (depth === 0) return;
      depth -= 1;
      if (depth > 0) return; // 仍有其它模态在暂停：保持冻结
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
    pauseDepth(): number {
      return depth;
    },
    destroy(): void {
      for (const e of timers.values()) if (e.timerId !== -1) clearTimeoutFn(e.timerId);
      timers.clear();
      depth = 0;
    },
  };
}
