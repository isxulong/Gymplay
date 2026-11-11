/**
 * E2E 关键路径 1（蓝图 §6.3，M1 门禁）：
 * 加载本地测试视频 → 编辑器打 3 段设 3 档速 → 生成密钥 → 播放队列 →
 * 断言调度器按预期切段变速（以引擎状态 playbackRate / currentTime 断言，不以画面断言）。
 *
 * 注：蓝图中路径 1 的「驾驶舱播放」随 M1/M2 分期收口为 M1 的队列播放
 * （同一 SegmentScheduler 驱动），驾驶舱 UI 属 M2 范围。
 */

import { test, expect } from '@playwright/test';
import { e2ePath } from './e2e-paths';

const FIXTURE = e2ePath('./fixtures/fixture-vp8-opus-10s.webm');

async function importFixture(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  // 装载完成标志：时间标签出现总时长 0:10
  await expect(page.getByTestId('time-label')).toContainText('0:10');
}

async function seekVideo(page: import('@playwright/test').Page, t: number): Promise<void> {
  await page.evaluate((sec) => {
    const v = document.querySelector('video');
    if (v) v.currentTime = sec;
  }, t);
}

async function readRate(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => document.querySelector('video')?.playbackRate ?? -1);
}

test('路径1：导入 → 打 3 段 → 设 3 档速 → 生成密钥 → 队列播放切段变速', async ({ page }) => {
  await importFixture(page);

  // 初始：单个全片段
  await expect(page.getByTestId('segment-list').locator('.segment')).toHaveCount(1);

  // 打点 1：t=2 → [0,2] [2,10]
  await seekVideo(page, 2);
  await page.getByTestId('mark-button').click();
  await expect(page.getByTestId('segment-list').locator('.segment')).toHaveCount(2);

  // 打点 2：t=5 → [0,2] [2,5] [5,10]
  await seekVideo(page, 5);
  await page.getByTestId('mark-button').click();
  await expect(page.getByTestId('segment-list').locator('.segment')).toHaveCount(3);

  // 设 3 档速：段1=1x（默认）、段2=2x、段3=4x
  const segButtons = page.getByTestId('segment-list').locator('.segment');
  await segButtons.nth(1).click(); // 选中段 2（同时跳到段起点播放，F2 AC2）
  await page.getByTestId('rate-2').click();
  await expect(segButtons.nth(1)).toContainText('2x');
  await segButtons.nth(2).click();
  await page.getByTestId('rate-4').click();
  await expect(segButtons.nth(2)).toContainText('4x');

  // 生成密钥（F8 AC1：先出文案 B 确认）
  await page.getByTestId('share-open').click();
  await expect(page.getByTestId('share-confirm-panel')).toBeVisible();
  await page.getByTestId('share-confirm').click();
  const link = await page.getByTestId('share-link').inputValue();
  expect(link).toContain('#c=');
  expect(link.length).toBeLessThanOrEqual(1500); // P10 判定线

  // 播放队列：调度切段变速（引擎状态断言）
  // 预期节奏：[0,2]@1x(2s) → [2,5]@2x(1.5s) → [5,10]@4x(1.25s)，约 4.75s 播完
  await page.getByTestId('play-queue').click();
  await expect(page.getByTestId('queue-status')).toHaveAttribute('data-playing', 'true');

  // 第一阶段：rate=1，播放头在 [0,2)
  await expect.poll(() => readRate(page)).toBe(1);

  // 推进到第三段：rate=4 且 currentTime ≥5
  await expect
    .poll(async () => ({ rate: await readRate(page), t: await page.evaluate(() => document.querySelector('video')?.currentTime ?? 0) }), { timeout: 15000 })
    .toMatchObject({ rate: 4 });
  const late = await page.evaluate(() => document.querySelector('video')?.currentTime ?? 0);
  expect(late).toBeGreaterThanOrEqual(5);

  // 播完：loop=off → finished，播放状态回落
  await expect(page.getByTestId('queue-status')).toHaveAttribute('data-playing', 'false', { timeout: 15000 });
});
