/**
 * v0.3.2 · 项1：通知中心单测（纯逻辑，Node 可测——仿 persistence.ts 注入先例）。
 *
 * 覆盖：冻结三通道解析与优先级（D-9）、pruneInfos / pruneKindNotices / pruneNotices
 * 挤位纯函数、foldNotices 折叠纯函数、分级时长（info 5s / warn 10s / error 30s）、
 * 各类型独立上限 3 条与同文案折叠计数、track 到期 / cancel、freeze 完全静止（不计时）、
 * pauseAll/resumeAll **配对计数**顺延、暂停期到达的通知不计时、destroy。
 * 计时全部经注入的 fake 时钟驱动，不依赖真实定时器。
 */

import { describe, expect, it } from 'vitest';
import {
  NOTICE_ERROR_CAP,
  NOTICE_ERROR_TTL_MS,
  NOTICE_INFO_CAP,
  NOTICE_INFO_TTL_MS,
  NOTICE_WARN_CAP,
  NOTICE_WARN_TTL_MS,
  createNoticeCenter,
  foldNotices,
  pruneInfos,
  pruneKindNotices,
  pruneNotices,
  resolveNoticeTiming,
} from '../../../src/app/notice-center';
import type { Notice } from '../../../src/app/state';

function info(id: number): Notice {
  return { id, kind: 'info', text: `info-${id}` };
}

function warn(id: number): Notice {
  return { id, kind: 'warn', text: `warn-${id}` };
}

/** 可控 fake 时钟：advance 按到期顺序触发任务，先到期先执行。 */
function fakeClock() {
  let t = 0;
  let seq = 0;
  const jobs = new Map<number, { fireAt: number; fn: () => void }>();
  return {
    now: (): number => t,
    setTimeoutFn: (fn: () => void, ms: number): number => {
      const id = ++seq;
      jobs.set(id, { fireAt: t + ms, fn });
      return id;
    },
    clearTimeoutFn: (id: number): void => {
      jobs.delete(id);
    },
    advance(ms: number): void {
      const target = t + ms;
      for (;;) {
        let earliest: number | null = null;
        let earliestAt = Infinity;
        for (const [id, j] of jobs) {
          if (j.fireAt <= target && j.fireAt < earliestAt) {
            earliest = id;
            earliestAt = j.fireAt;
          }
        }
        if (earliest === null) break;
        const j = jobs.get(earliest)!;
        jobs.delete(earliest);
        t = j.fireAt;
        j.fn();
      }
      t = target;
    },
  };
}

describe('resolveNoticeTiming 冻结三通道与优先级（高覆盖低，D-9）', () => {
  it('无任何通道 → 不冻结、默认 TTL', () => {
    expect(resolveNoticeTiming({})).toEqual({ freeze: false, infoTtlMs: NOTICE_INFO_TTL_MS });
  });

  it('通道① URL ?fvpNoticeTtl=0 → 冻结完全静止', () => {
    expect(resolveNoticeTiming({ search: '?fvpNoticeTtl=0' })).toEqual({
      freeze: true,
      infoTtlMs: NOTICE_INFO_TTL_MS,
    });
  });

  it('通道① URL ?fvpNoticeTtl=500 → 不冻结、TTL=500（加速档）', () => {
    expect(resolveNoticeTiming({ search: '?a=1&fvpNoticeTtl=500' })).toEqual({ freeze: false, infoTtlMs: 500 });
  });

  it('通道② 注入标志 → 冻结', () => {
    expect(resolveNoticeTiming({ testFlag: true })).toEqual({
      freeze: true,
      infoTtlMs: NOTICE_INFO_TTL_MS,
    });
  });

  it('通道③ navigator.webdriver → 冻结（fixture 失效兜底）', () => {
    expect(resolveNoticeTiming({ webdriver: true })).toEqual({
      freeze: true,
      infoTtlMs: NOTICE_INFO_TTL_MS,
    });
  });

  it('优先级：URL 参数覆盖注入标志与 webdriver（?fvpNoticeTtl=500 + 双兜底 → 不冻结）', () => {
    expect(resolveNoticeTiming({ search: '?fvpNoticeTtl=500', testFlag: true, webdriver: true })).toEqual({
      freeze: false,
      infoTtlMs: 500,
    });
  });

  it('优先级：URL 冻结值 0 覆盖低通道；testFlag 覆盖 webdriver', () => {
    expect(resolveNoticeTiming({ search: '?fvpNoticeTtl=0', webdriver: true })).toEqual({
      freeze: true,
      infoTtlMs: NOTICE_INFO_TTL_MS,
    });
    expect(resolveNoticeTiming({ testFlag: true, webdriver: true })).toEqual({
      freeze: true,
      infoTtlMs: NOTICE_INFO_TTL_MS,
    });
  });
});

describe('pruneInfos 挤位纯函数（freeze 时调用方不调用）', () => {
  it('info 数 ≤ cap → 不移除', () => {
    expect(pruneInfos([info(1), info(2), info(3)], NOTICE_INFO_CAP)).toEqual([]);
  });

  it('info 数超 cap → 返回最旧 info id（含新推入视角）', () => {
    expect(pruneInfos([warn(0), info(1), info(2), info(3), info(4)], NOTICE_INFO_CAP)).toEqual([1]);
  });

  // v0.3.3 · 项2：本条断言原名保留（X-9 只反转期望，不删不改名）。
  // v0.3.2 断言的正是缺陷行为「告警无界累积」；v0.3.3 起 warn/error 有独立上限 3 条，
  // 但**仍不占 info 的挤位名额**——名额彼此独立，故这里断言的是「独立名额」而非「永不参与」。
  it('非普通信息有独立上限 3 条且不占普通信息名额', () => {
    const notices: Notice[] = [warn(1), warn(2), warn(3), warn(4), warn(5)];
    // info 侧：一条 info 都没有 → info 挤位不移除任何东西（名额独立）
    expect(pruneInfos(notices, NOTICE_INFO_CAP)).toEqual([]);
    // warn 侧：5 条超出独立上限 3 → 最旧 2 条被移除
    expect(pruneKindNotices(notices, 'warn', NOTICE_WARN_CAP)).toEqual([1, 2]);
  });
});

describe('createNoticeCenter 计时行为', () => {
  // v0.3.3 · 项2：本条断言原名保留（X-9 只反转期望，不删不改名）。
  // v0.3.2 断言的正是缺陷行为「告警不计时」；v0.3.3 起告警按 10 秒到期。
  it('告警按 10 秒到期', () => {
    const clock = fakeClock();
    const expired: number[] = [];
    const center = createNoticeCenter({
      infoTtlMs: 5000,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      now: clock.now,
      onExpire: (id) => expired.push(id),
    });
    center.track(info(7));
    center.track(warn(8));
    clock.advance(4999);
    expect(expired).toEqual([]);
    clock.advance(1); // t=5000：info 到期，告警仍存活
    expect(expired).toEqual([7]);
    clock.advance(5000); // t=10000：告警到期（10s）
    expect(expired).toEqual([7, 8]);
  });

  it('freeze = 完全静止：track 不安排任何计时', () => {
    const clock = fakeClock();
    const expired: number[] = [];
    const center = createNoticeCenter({
      infoTtlMs: 5000,
      freeze: true,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      now: clock.now,
      onExpire: (id) => expired.push(id),
    });
    center.track(info(1));
    center.track(info(2));
    clock.advance(60_000);
    expect(expired).toEqual([]);
  });

  it('cancel：手动关闭/挤位移除后不再触发 onExpire', () => {
    const clock = fakeClock();
    const expired: number[] = [];
    const center = createNoticeCenter({
      infoTtlMs: 5000,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      now: clock.now,
      onExpire: (id) => expired.push(id),
    });
    center.track(info(1));
    center.cancel(1);
    clock.advance(60_000);
    expect(expired).toEqual([]);
  });

  it('pauseAll/resumeAll：暂停冻结剩余时长，恢复按剩余顺延', () => {
    const clock = fakeClock();
    const expired: number[] = [];
    const center = createNoticeCenter({
      infoTtlMs: 5000,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      now: clock.now,
      onExpire: (id) => expired.push(id),
    });
    center.track(info(1)); // deadline = t+5000
    clock.advance(3000); // 剩余 2000
    center.pauseAll(); // 冻结剩余 2000ms
    clock.advance(60_000); // 暂停期间静止
    expect(expired).toEqual([]);
    center.resumeAll(); // 顺延：再过 2000ms 到期
    clock.advance(1999);
    expect(expired).toEqual([]);
    clock.advance(1);
    expect(expired).toEqual([1]);
  });

  it('pauseAll/resumeAll 对多条通知各自独立顺延', () => {
    const clock = fakeClock();
    const expired: number[] = [];
    const center = createNoticeCenter({
      infoTtlMs: 5000,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      now: clock.now,
      onExpire: (id) => expired.push(id),
    });
    center.track(info(1)); // 剩余将冻结在 4000
    clock.advance(1000);
    center.track(info(2)); // 剩余将冻结在 5000
    clock.advance(0);
    center.pauseAll();
    clock.advance(10_000);
    center.resumeAll();
    clock.advance(3999);
    expect(expired).toEqual([]);
    clock.advance(1);
    expect(expired).toEqual([1]); // 先到期
    clock.advance(1000);
    expect(expired).toEqual([1, 2]); // 后到期
  });

  it('destroy：清空全部计时器，到期不再触发', () => {
    const clock = fakeClock();
    const expired: number[] = [];
    const center = createNoticeCenter({
      infoTtlMs: 5000,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      now: clock.now,
      onExpire: (id) => expired.push(id),
    });
    center.track(info(1));
    center.track(info(2));
    center.destroy();
    clock.advance(60_000);
    expect(expired).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// v0.3.3 · 项2：分级时长 / 独立上限 / 同文案折叠 / 配对暂停计数
// 说明：上方两条被反转的旧断言（「非普通信息有独立上限 3 条且不占普通信息名额」与
// 「告警按 10 秒到期」）已原位替换期望值、标题保留；以下为新增用例，
// 数量 ≥ 被反转用例数（2），满足 X-9「测试总数只增不减」。
// ---------------------------------------------------------------------------

describe('v0.3.3 · 项2：分级时长常量（info 5s / warn 10s / error 30s）', () => {
  it('三级 TTL 常量取方案定稿值', () => {
    expect(NOTICE_INFO_TTL_MS).toBe(5000);
    expect(NOTICE_WARN_TTL_MS).toBe(10_000);
    expect(NOTICE_ERROR_TTL_MS).toBe(30_000);
  });

  it('三级独立上限各为 3 条', () => {
    expect(NOTICE_INFO_CAP).toBe(3);
    expect(NOTICE_WARN_CAP).toBe(3);
    expect(NOTICE_ERROR_CAP).toBe(3);
  });

  it('告警按 10 秒到期（判据 2-b：推进 2× 告警时长后计数归零）', () => {
    const clock = fakeClock();
    const expired: number[] = [];
    const center = createNoticeCenter({
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      now: clock.now,
      onExpire: (id) => expired.push(id),
    });
    center.track(warn(1));
    clock.advance(2 * NOTICE_WARN_TTL_MS); // 20s = 2× 告警时长
    expect(expired).toEqual([1]);
    expect(expired.length).toBe(0 + 1);
  });

  it('错误按 30 秒到期，且早于 30s 不消失', () => {
    const clock = fakeClock();
    const expired: number[] = [];
    const center = createNoticeCenter({
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      now: clock.now,
      onExpire: (id) => expired.push(id),
    });
    center.track({ id: 9, kind: 'error', text: '错误-9' });
    clock.advance(NOTICE_ERROR_TTL_MS - 1);
    expect(expired).toEqual([]);
    clock.advance(1);
    expect(expired).toEqual([9]);
  });

  it('三级时长互不串档：同一时刻登记的 info/warn/error 按各自 TTL 依次到期', () => {
    const clock = fakeClock();
    const expired: number[] = [];
    const center = createNoticeCenter({
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      now: clock.now,
      onExpire: (id) => expired.push(id),
    });
    center.track(info(1));
    center.track(warn(2));
    center.track({ id: 3, kind: 'error', text: 'e-3' });
    clock.advance(5000);
    expect(expired).toEqual([1]);
    clock.advance(5000); // t=10000
    expect(expired).toEqual([1, 2]);
    clock.advance(20_000); // t=30000
    expect(expired).toEqual([1, 2, 3]);
  });

  it('freeze 对 warn/error 同样生效：完全静止（不计时、不挤位）', () => {
    const clock = fakeClock();
    const expired: number[] = [];
    const center = createNoticeCenter({
      freeze: true,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      now: clock.now,
      onExpire: (id) => expired.push(id),
    });
    center.track(warn(1));
    center.track({ id: 2, kind: 'error', text: 'e-2' });
    clock.advance(120_000);
    expect(expired).toEqual([]);
  });
});

describe('v0.3.3 · 项2：独立上限与同文案折叠（判据 2-c）', () => {
  /** 生成 n 条同文案告警（id 递增） */
  function sameWarns(n: number, text = '同一失败原因'): Notice[] {
    return Array.from({ length: n }, (_, i) => ({ id: i + 1, kind: 'warn' as const, text }));
  }

  it('连发 17 条同文案告警：可见条数 ≤ 3 且第 2 条起显示折叠计数', () => {
    const notices = sameWarns(17);
    const shown = foldNotices(notices);
    // 同一文案折叠成 1 组 → 可见 1 条，远低于上限 3
    expect(shown.length).toBe(1);
    expect(shown.length).toBeLessThanOrEqual(3);
    expect(shown[0].kind).toBe('warn');
    expect(shown[0].text).toBe('同一失败原因');
    // 折叠计数：第 2 条起即计数 → 17 条显示「×17」（UI 读 count 渲染 ×N）
    expect(shown[0].count).toBe(17);
    expect(shown[0].count).toBeGreaterThan(1);
    // 折叠组保留全部 id（关闭整组时才不丢计时器）
    expect(shown[0].ids.length).toBe(17);
  });

  it('17 条互异文案告警：可见条数恰为上限 3（只留最新 3 组）', () => {
    const notices = Array.from({ length: 17 }, (_, i) => ({
      id: i + 1,
      kind: 'warn' as const,
      text: `失败原因-${i + 1}`,
    }));
    const shown = foldNotices(notices);
    expect(shown.length).toBe(NOTICE_WARN_CAP);
    // 保留最新 3 条（尾部）
    expect(shown.map((g) => g.text)).toEqual(['失败原因-15', '失败原因-16', '失败原因-17']);
  });

  it('告警与错误名额彼此独立：各自可见 3 条，互不挤占', () => {
    const notices: Notice[] = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: i + 1, kind: 'warn' as const, text: `w-${i + 1}` })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: 100 + i, kind: 'error' as const, text: `e-${i + 1}` })),
    ];
    const shown = foldNotices(notices);
    expect(shown.filter((g) => g.kind === 'warn').length).toBe(NOTICE_WARN_CAP);
    expect(shown.filter((g) => g.kind === 'error').length).toBe(NOTICE_ERROR_CAP);
  });

  it('info 不折叠：4 条同文案 info 仍为 4 行（保持 v0.3.2 既有 E2E 口径）', () => {
    const notices: Notice[] = Array.from({ length: 4 }, (_, i) => ({
      id: i + 1,
      kind: 'info' as const,
      text: '这份配置与当前内容一致',
    }));
    const shown = foldNotices(notices);
    expect(shown.length).toBe(4);
    expect(shown.every((g) => g.count === 1)).toBe(true);
  });

  it('pruneNotices：info 与 warn/error 名额各自独立，不互相挤占', () => {
    const notices: Notice[] = [
      ...Array.from({ length: 4 }, (_, i) => ({ id: i + 1, kind: 'info' as const, text: `i-${i + 1}` })),
      ...Array.from({ length: 17 }, (_, i) => ({ id: 10 + i, kind: 'warn' as const, text: '同一失败原因' })),
    ];
    const evict = pruneNotices(notices);
    // info 侧：4 条超 cap 3 → 最旧 1 条
    expect(evict).toContain(1);
    // warn 侧：17 条折叠成 1 组、未超 3 组上限 → 一条都不挤（不互相挤掉）
    expect(evict.filter((id) => id >= 10)).toEqual([]);
  });
});

describe('v0.3.3 · 项2：配对暂停计数（判据 2-e）与暂停期登记', () => {
  function setup() {
    const clock = fakeClock();
    const expired: number[] = [];
    const center = createNoticeCenter({
      infoTtlMs: 5000,
      setTimeoutFn: clock.setTimeoutFn,
      clearTimeoutFn: clock.clearTimeoutFn,
      now: clock.now,
      onExpire: (id) => expired.push(id),
    });
    return { clock, expired, center };
  }

  it('配对语义：pause 两次、resume 一次 → 仍在暂停（不恢复计时）', () => {
    const { clock, expired, center } = setup();
    center.track(info(1));
    clock.advance(1000); // 剩余 4000
    center.pauseAll(); // depth 1
    center.pauseAll(); // depth 2（详情面板 + 回收站同时打开）
    clock.advance(60_000);
    center.resumeAll(); // depth 1：仍有另一层模态在暂停
    clock.advance(60_000);
    expect(expired).toEqual([]);
    expect(center.pauseDepth()).toBe(1);
    center.resumeAll(); // depth 0：真正恢复
    expect(center.pauseDepth()).toBe(0);
    clock.advance(3999);
    expect(expired).toEqual([]);
    clock.advance(1);
    expect(expired).toEqual([1]);
  });

  it('配对语义：两次 pause 与两次 resume 正确平衡（深度归零才恢复）', () => {
    const { clock, expired, center } = setup();
    center.track(info(1));
    center.pauseAll();
    center.pauseAll();
    center.pauseAll();
    expect(center.pauseDepth()).toBe(3);
    center.resumeAll();
    center.resumeAll();
    expect(center.pauseDepth()).toBe(1);
    clock.advance(10_000);
    expect(expired).toEqual([]);
    center.resumeAll();
    expect(center.pauseDepth()).toBe(0);
    clock.advance(5000);
    expect(expired).toEqual([1]);
  });

  it('异常路径不漏减：多余 resume 在 0 处夹紧，不产生负深度、不误恢复', () => {
    const { clock, expired, center } = setup();
    center.track(info(1));
    center.resumeAll(); // 未 pause 就 resume → 应被夹紧为 0，不报错
    expect(center.pauseDepth()).toBe(0);
    clock.advance(5000);
    expect(expired).toEqual([1]); // 计时未被误冻结
    center.resumeAll();
    expect(center.pauseDepth()).toBe(0);
  });

  it('暂停期间到达的新通知不启动计时（既不 arm 也不立即过期）', () => {
    const { clock, expired, center } = setup();
    center.pauseAll(); // 先进入暂停
    center.track(info(1)); // 暂停期到达
    clock.advance(60_000); // 暂停期推进大量时间
    expect(expired).toEqual([]); // 不 arm → 不会到期
    center.resumeAll(); // 恢复：应按**完整时长**起算，而不是「立即过期」
    clock.advance(4999);
    expect(expired).toEqual([]);
    clock.advance(1);
    expect(expired).toEqual([1]);
  });

  it('暂停期到达的 warn/error 同样按各自完整时长起算', () => {
    const { clock, expired, center } = setup();
    center.pauseAll();
    center.track(warn(2));
    center.track({ id: 3, kind: 'error', text: 'e-3' });
    clock.advance(120_000);
    expect(expired).toEqual([]);
    center.resumeAll();
    clock.advance(NOTICE_WARN_TTL_MS);
    expect(expired).toEqual([2]);
    clock.advance(NOTICE_ERROR_TTL_MS - NOTICE_WARN_TTL_MS);
    expect(expired).toEqual([2, 3]);
  });

  it('暂停期对已在计的计时器仍按剩余时长顺延（既有语义不被配对改动破坏）', () => {
    const { clock, expired, center } = setup();
    center.track(info(1));
    clock.advance(2000); // 剩余 3000
    center.pauseAll();
    center.pauseAll(); // 多层
    clock.advance(30_000);
    center.resumeAll();
    center.resumeAll();
    clock.advance(2999);
    expect(expired).toEqual([]);
    clock.advance(1);
    expect(expired).toEqual([1]);
  });

  it('destroy 复位暂停深度，避免残留态影响下一次装配', () => {
    const { center } = setup();
    center.pauseAll();
    center.pauseAll();
    expect(center.pauseDepth()).toBe(2);
    center.destroy();
    expect(center.pauseDepth()).toBe(0);
  });
});
