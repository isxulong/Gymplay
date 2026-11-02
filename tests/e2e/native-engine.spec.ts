/**
 * NativeEngine 契约测试（定稿 §2.5：契约一致性用例在 Playwright 真实浏览器层执行）。
 *
 * 与 Node 侧 FakeEngine 契约同一组输入序列（load → setRate → play → tick →
 * seek → pause → 播至 ended → destroy），断言 NativeEngine 的对外可观察行为：
 * 时间回流、速率钳制、preservesPitch 默认开启、ended 事件、destroy 后静默。
 */

import { test, expect } from '@playwright/test';

interface ContractResult {
  loadOk: boolean;
  durationSec: number;
  rateApplied: number;
  rateClamped: number;
  preservesPitch: boolean;
  played: boolean;
  tickCount: number;
  seekedTo3: number;
  pausedOk: boolean;
  endedFired: boolean;
  ticksStoppedAfterDestroy: boolean;
  events: string[];
  error?: string;
}

test('NativeEngine 契约（真实 <video> + VP8/Opus fixture）', async ({ page }) => {
  await page.goto('/e2e-harness.html');
  await page.waitForFunction(() => (window as unknown as { __harnessReady?: boolean }).__harnessReady === true);

  const result = (await page.evaluate(() =>
    (window as unknown as { __harness: { runContract(): Promise<ContractResult> } }).__harness.runContract(),
  )) as ContractResult;

  expect(result.error).toBeUndefined();
  expect(result.loadOk).toBe(true);
  expect(result.durationSec).toBeGreaterThan(9);
  expect(result.durationSec).toBeLessThan(12);

  // setRate：正常值透传、超界钳到协议上限 4、preservesPitch 默认开启（P4 结论）
  expect(result.rateApplied).toBe(2);
  expect(result.rateClamped).toBe(4);
  expect(result.preservesPitch).toBe(true);

  // play 后时间通道有 tick 回流（rVFC 主线或 50ms 轮询兜底）
  expect(result.played).toBe(true);
  expect(result.tickCount).toBeGreaterThan(0);

  // seek 定位精度（契约口径：±0.5s 内）
  expect(Math.abs(result.seekedTo3 - 3)).toBeLessThan(0.5);

  expect(result.pausedOk).toBe(true);
  // 播到末尾触发 ended 事件
  expect(result.endedFired).toBe(true);
  expect(result.events).toContain('ended');
  // destroy 后通道全部静默
  expect(result.ticksStoppedAfterDestroy).toBe(true);
});
