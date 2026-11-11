/**
 * E2E 关键路径 3（蓝图 §6.3 / 定稿 §四 M2 门禁）：练时驾驶舱。
 * 导入 → 打点分段设速 → 进入驾驶舱 →
 * F6 AC1 首屏只呈现段名/超大倒计时/三大按钮（无编辑入口、队列进度不进首屏）；
 * F6 AC4 倒计时实时递减（含倍速折算）；
 * 三大按钮跳段（上一段/下一段）与暂停继续；
 * F6 AC2 误触隔离（点舞台空白不改变播放状态、不进编辑）；
 * 下滑手势区 → 队列进度 + loop.mode 三态热切换（循环接入）；
 * 两步确认退出回编辑器。
 */

import { test, expect } from '@playwright/test';
import { e2ePath } from './e2e-paths';

const FIXTURE = e2ePath('./fixtures/fixture-vp8-opus-10s.webm');

async function importFixture(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('time-label')).toContainText('0:10');
}

async function seekVideo(page: import('@playwright/test').Page, t: number): Promise<void> {
  await page.evaluate((sec) => {
    const v = document.querySelector('video');
    if (v) v.currentTime = sec;
  }, t);
}

async function videoState(page: import('@playwright/test').Page): Promise<{ paused: boolean; rate: number; t: number }> {
  return page.evaluate(() => {
    const v = document.querySelector('video');
    return { paused: v?.paused ?? true, rate: v?.playbackRate ?? -1, t: v?.currentTime ?? -1 };
  });
}

test('路径3：驾驶舱跟练（首屏三要素 / 倒计时 / 跳段 / 误触隔离 / 下滑面板循环接入 / 退出）', async ({ page }) => {
  await importFixture(page);

  // 打点：t=6 → [0,6]@1x + [6,10]，段2 = 2x
  await seekVideo(page, 6);
  await page.getByTestId('mark-button').click();
  const segs = page.getByTestId('segment-list').locator('.segment');
  await expect(segs).toHaveCount(2);
  await segs.nth(1).click();
  await page.getByTestId('rate-2').click();
  await expect(segs.nth(1)).toContainText('2x');

  // 进入驾驶舱 → 自动从队列头开播
  await page.getByTestId('enter-cockpit').click();
  await expect(page.getByTestId('cockpit-host')).toBeVisible();
  await expect(page.getByTestId('editor-host')).toBeHidden();

  // F6 AC5 降级路径：headless Chromium 无 Wake Lock API → 顶部一次性文案 D；关掉再验后续
  await expect(page.getByTestId('cockpit-wakelock-hint')).toBeVisible();
  await page.getByTestId('cockpit-hint-close-wakelock').click();
  await expect(page.getByTestId('cockpit-wakelock-hint')).toBeHidden();

  // F6 AC1：首屏三要素齐全
  await expect(page.getByTestId('cockpit-seg-name')).toBeVisible();
  await expect(page.getByTestId('cockpit-countdown')).toBeVisible();
  await expect(page.getByTestId('cockpit-prev')).toBeVisible();
  await expect(page.getByTestId('cockpit-toggle')).toBeVisible();
  await expect(page.getByTestId('cockpit-next')).toBeVisible();
  // 无编辑入口（编辑器整树隐藏）；队列进度面板不进首屏
  await expect(page.getByTestId('segment-list')).toBeHidden();
  await expect(page.getByTestId('cockpit-panel')).not.toHaveClass(/cockpit-panel--open/);

  // F6 AC4：倒计时实时递减（段1 [0,6]@1x → 6.0s 起倒数）
  const toSec = (s: string | null): number => {
    const m = s?.match(/^(\d+):(\d\d)\.(\d)$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 10 : NaN;
  };
  const c1 = toSec(await page.getByTestId('cockpit-countdown').textContent());
  await page.waitForTimeout(700);
  const c2 = toSec(await page.getByTestId('cockpit-countdown').textContent());
  expect(c1).not.toBeNaN();
  expect(c2).toBeLessThan(c1);

  // F6 AC2 误触隔离：点倒计时（按钮区外）→ 播放状态不变、不进编辑器
  await page.getByTestId('cockpit-countdown').click();
  expect((await videoState(page)).paused).toBe(false);
  await expect(page.getByTestId('editor-host')).toBeHidden();

  // 三大按钮 · 下一段 → [6,10]@2x
  await page.getByTestId('cockpit-next').click();
  await expect.poll(async () => (await videoState(page)).rate).toBe(2);
  expect((await videoState(page)).t).toBeGreaterThanOrEqual(5.9);

  // 三大按钮 · 上一段 → 回 [0,6]@1x
  await page.getByTestId('cockpit-prev').click();
  await expect.poll(async () => (await videoState(page)).rate).toBe(1);
  expect((await videoState(page)).t).toBeLessThan(2);

  // 三大按钮 · 暂停 / 继续
  await page.getByTestId('cockpit-toggle').click();
  await expect.poll(async () => (await videoState(page)).paused).toBe(true);
  await expect(page.getByTestId('cockpit-toggle')).toContainText('继续');
  await page.getByTestId('cockpit-toggle').click();
  await expect.poll(async () => (await videoState(page)).paused).toBe(false);
  await expect(page.getByTestId('cockpit-toggle')).toContainText('暂停');

  // 下滑手势区：向下拖动舞台 → 队列进度面板滑入
  await page.mouse.move(300, 160);
  await page.mouse.down();
  await page.mouse.move(300, 480, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByTestId('cockpit-panel')).toHaveClass(/cockpit-panel--open/);
  await expect(page.getByTestId('cockpit-progress')).toContainText('第 1/2 项');
  await expect(page.getByTestId('cockpit-queue-item-0')).toBeVisible();
  await expect(page.getByTestId('cockpit-queue-item-1')).toBeVisible();

  // 循环接入：驾驶舱内切单段循环（热切换不打断播放）→ 当前段播完自动重播
  await page.getByTestId('cockpit-loop-segment').click();
  expect((await videoState(page)).paused).toBe(false); // 热切换不暂停
  await expect(page.getByTestId('cockpit-progress')).toContainText(/已重播 [1-9]\d* 次/, { timeout: 15000 });

  // 退出：两步确认 → 回编辑器、播放停止
  await page.getByTestId('cockpit-exit').click();
  await page.getByTestId('cockpit-exit-confirm').click();
  await expect(page.getByTestId('editor-host')).toBeVisible();
  await expect(page.getByTestId('cockpit-host')).toBeHidden();
  await expect.poll(async () => (await videoState(page)).paused).toBe(true);
  await expect(page.getByTestId('queue-status')).toHaveAttribute('data-playing', 'false');
});

test('驾驶舱边界：队列为空时进入被拒绝并提示', async ({ page }) => {
  await importFixture(page);
  // 唯一段取消勾选 → 队列空
  await page.getByTestId('queue-check-0').click();
  await expect(page.getByTestId('enter-cockpit')).toBeDisabled();
});
