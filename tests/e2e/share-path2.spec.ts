/**
 * E2E 关键路径 2（蓝图 §6.3，M1 门禁）：
 * 密钥导入还原——把路径 1 生成的密钥贴进地址栏新开页面，配置完整还原
 * （分段 / 速度 / 勾选 / 顺序 / 循环），并引导导入同一视频（文案 B2）。
 * 附带 F8 AC4：被截断 / 篡改的链接给出「链接无效或不完整」且不进入半配置状态。
 */

import { test, expect } from '@playwright/test';
import { e2ePath } from './e2e-paths';

const FIXTURE = e2ePath('./fixtures/fixture-vp8-opus-10s.webm');

test('路径2：分享链接新开页面完整还原编排', async ({ page, browser }) => {
  // —— 发送方：编排一份有辨识度的配置 ——
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('time-label')).toContainText('0:10');

  const seek = (t: number): Promise<void> =>
    page.evaluate((sec) => {
      const v = document.querySelector('video');
      if (v) v.currentTime = sec;
    }, t);
  await seek(2);
  await page.getByTestId('mark-button').click();
  await seek(5);
  await page.getByTestId('mark-button').click();
  await expect(page.getByTestId('segment-list').locator('.segment')).toHaveCount(3);

  const segs = page.getByTestId('segment-list').locator('.segment');
  // 段1 命名「热身组」+ 0.5x
  await segs.nth(0).click();
  await page.getByTestId('detail-label').fill('热身组');
  await page.getByTestId('detail-label').press('Tab'); // blur 提交 change
  await page.getByTestId('rate-0.5').click();
  // 段2 = 2x；段3 = 3x（跳过区）
  await segs.nth(1).click();
  await page.getByTestId('rate-2').click();
  await segs.nth(2).click();
  await page.getByTestId('rate-3').click();
  // 取消勾选段3（F5 AC1 数据还原验证点）
  await page.getByTestId('queue-check-2').click();
  // 重复段1（重复段）
  await page.getByTestId('queue-dup-0').click();
  // 整列循环 ×2
  await page.getByTestId('loop-queue').click();
  await page.getByTestId('loop-count').fill('2');
  await page.getByTestId('loop-count').press('Tab'); // blur 提交 change

  // 生成密钥
  await page.getByTestId('share-open').click();
  await page.getByTestId('share-confirm').click();
  const link = await page.getByTestId('share-link').inputValue();
  expect(link).toContain('#c=');

  // —— 接收方：全新浏览器上下文（无本地配置）打开链接 ——
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  try {
    await page2.goto(link);
    // 配置直接生效，进入「待选择视频」引导（文案 B2）
    await expect(page2.getByTestId('needs-video')).toBeVisible();
    await expect(page2.getByTestId('needs-video-text')).toContainText('fixture-vp8-opus-10s.webm');
    await expect(page2.getByTestId('needs-video-guide')).toContainText('训练编排');

    // 分段 / 速度 / 勾选 / 顺序 / 循环完整还原（无需视频即可预览编排）
    const segs2 = page2.getByTestId('segment-list').locator('.segment');
    await expect(segs2).toHaveCount(3);
    await expect(segs2.nth(0)).toContainText('热身组');
    await expect(segs2.nth(0)).toContainText('0.5x');
    await expect(segs2.nth(1)).toContainText('2x');
    await expect(segs2.nth(2)).toContainText('3x');
    await expect(segs2.nth(2)).toContainText('未勾选');
    await expect(page2.getByTestId('queue-list').getByRole('listitem')).toHaveCount(4); // 3 段 + 重复段
    await expect(page2.getByTestId('loop-queue')).toBeChecked();
    await expect(page2.getByTestId('loop-count')).toHaveValue('2');

    // 导入同一视频 → 配对成功、无时长不一致告警
    await page2.getByTestId('file-input').setInputFiles(FIXTURE);
    await expect(page2.getByTestId('time-label')).toContainText('0:10');
    await expect(page2.getByTestId('needs-video')).toBeHidden();
    await expect(page2.getByTestId('notice').filter({ hasText: '可能不是同一份视频' })).toHaveCount(0);
  } finally {
    await ctx2.close();
  }
});

test('F8 AC4：被篡改 / 截断的链接提示无效且不进入半配置状态', async ({ page }) => {
  await page.goto('/#c=corrupted!!!not-base64url');
  await expect(page.getByTestId('notice').filter({ hasText: '链接无效或不完整' })).toBeVisible();
  // 不落配置：回到初始空态
  await expect(page.getByTestId('empty-state')).toBeVisible();
});
