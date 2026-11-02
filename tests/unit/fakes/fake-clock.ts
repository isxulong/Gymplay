/**
 * FakeClock（测试设施，蓝图 §6.2）：脚本化时钟。
 * 预置一条时间线，测试用 advance(ms) 逐步推进；注入式定时器随时间推进泵动触发。
 * 调度器不读真实时间，所有断言在脚本化时间线上确定可重复。
 */

import type { Clock } from '../../../src/core/player/clock';

interface FakeTimer {
  id: number;
  cb: () => void;
  intervalMs: number;
  nextFireAt: number; // 挂钟秒
}

export class FakeClock implements Clock {
  private wallSec: number;
  private timers = new Map<number, FakeTimer>();
  private nextId = 1;

  constructor(startSec = 0) {
    this.wallSec = startSec;
  }

  now(): number {
    return this.wallSec;
  }

  setInterval(cb: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { id, cb, intervalMs: ms, nextFireAt: this.wallSec + ms / 1000 });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** 推进挂钟 ms 毫秒；到点的定时器按序触发（间隔定时器重复排期）。 */
  advance(ms: number): void {
    const target = this.wallSec + ms / 1000;
    for (;;) {
      let due: FakeTimer | null = null;
      for (const t of this.timers.values()) {
        if (t.nextFireAt <= target + 1e-12 && (due === null || t.nextFireAt < due.nextFireAt)) due = t;
      }
      if (due === null) break;
      this.wallSec = due.nextFireAt;
      due.nextFireAt += due.intervalMs / 1000;
      due.cb();
    }
    this.wallSec = target;
  }

  /** 当前在册定时器数量（断言降级/停用时用）。 */
  get activeTimers(): number {
    return this.timers.size;
  }
}
