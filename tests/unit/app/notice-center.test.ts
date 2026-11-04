/**
 * v0.3.2 · 项1：通知中心单测（纯逻辑，Node 可测——仿 persistence.ts 注入先例）。
 *
 * 覆盖：冻结三通道解析与优先级（D-9）、pruneInfos 挤位纯函数、
 * track 到期 / cancel、freeze 完全静止（不计时）、pauseAll/resumeAll 顺延、destroy。
 * 计时全部经注入的 fake 时钟驱动，不依赖真实定时器。
 */

import { describe, expect, it } from 'vitest';
import {
  NOTICE_INFO_CAP,
  NOTICE_INFO_TTL_MS,
  createNoticeCenter,
  pruneInfos,
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

  it('warn/error 永不参与挤位', () => {
    const notices: Notice[] = [warn(1), warn(2), warn(3), warn(4), warn(5)];
    expect(pruneInfos(notices, NOTICE_INFO_CAP)).toEqual([]);
  });
});

describe('createNoticeCenter 计时行为', () => {
  it('track 登记 info → 到期触发 onExpire；warn 不计时', () => {
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
    clock.advance(1);
    expect(expired).toEqual([7]);
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
