import { describe, expect, it } from 'vitest';
import {
  chooseTickStrategy,
  POLL_INTERVAL_MS,
  RVFC_STALL_MS,
  systemClock,
} from '../../../../src/core/player/clock';
import { FakeClock } from '../../fakes/fake-clock';

describe('clock · 调度主线决策（P3）', () => {
  it('rVFC 可用 → 主线 rvfc；不可用 → polling 兜底', () => {
    expect(chooseTickStrategy({ rVFC: true })).toBe('rvfc');
    expect(chooseTickStrategy({ rVFC: false })).toBe('polling');
  });

  it('常量与 P3 实测口径一致：轮询 50ms、静默阈值 500ms', () => {
    expect(POLL_INTERVAL_MS).toBe(50);
    expect(RVFC_STALL_MS).toBe(500);
  });

  it('systemClock.now 单调非减', async () => {
    const a = systemClock.now();
    await new Promise((r) => setTimeout(r, 5));
    expect(systemClock.now()).toBeGreaterThanOrEqual(a);
  });
});

describe('FakeClock 设施自检', () => {
  it('advance 泵动间隔定时器（含重复排期）', () => {
    const clock = new FakeClock();
    let fires = 0;
    clock.setInterval(() => fires++, 50);
    clock.advance(200);
    expect(fires).toBe(4);
  });

  it('clearInterval 后不再触发', () => {
    const clock = new FakeClock();
    let fires = 0;
    const h = clock.setInterval(() => fires++, 50);
    clock.advance(50);
    clock.clearInterval(h);
    clock.advance(200);
    expect(fires).toBe(1);
  });

  it('now 随 advance 前进（秒）', () => {
    const clock = new FakeClock(10);
    clock.advance(1500);
    expect(clock.now()).toBeCloseTo(11.5);
  });
});
