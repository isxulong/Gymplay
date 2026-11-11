/**
 * E2E · 持久化门禁（M1 出口门禁 2/3/4）：
 * - F7 AC1：刷新恢复无损（分段、速度、勾选、顺序）；
 * - F7 AC2：存储清空回初始态不报错；
 * - F7 AC3：本地有配置 + 打开分享链接 → 草稿态冲突 UI，未确认前不写本地存储。
 */

import { test, expect } from '@playwright/test';
import { e2ePath } from './e2e-paths';

const FIXTURE = e2ePath('./fixtures/fixture-vp8-opus-10s.webm');

async function importAndMark(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('time-label')).toContainText('0:10');
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) v.currentTime = 4;
  });
  await page.getByTestId('mark-button').click();
  await expect(page.getByTestId('segment-list').locator('.segment')).toHaveCount(2);
}

/** 防抖 300ms + 余量，等自动保存落盘 */
async function waitAutosave(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForTimeout(500);
}

test('F7 AC1：刷新页面配置无损恢复', async ({ page }) => {
  await importAndMark(page);

  // 段1 命名 + 1.5x；段2 取消勾选
  const segs = page.getByTestId('segment-list').locator('.segment');
  await segs.nth(0).click();
  await page.getByTestId('detail-label').fill('冲刺组');
  await page.getByTestId('detail-label').press('Tab');
  await page.getByTestId('rate-1.5').click();
  await page.getByTestId('queue-check-1').click();
  await waitAutosave(page);

  await page.reload();

  // 配置恢复：段数 / 名称 / 速度 / 勾选态；视频需重新选择（File 不可持久化）
  await expect(page.getByTestId('needs-video')).toBeVisible();
  await expect(page.getByTestId('needs-video-text')).toContainText('fixture-vp8-opus-10s.webm');
  const segsAfter = page.getByTestId('segment-list').locator('.segment');
  await expect(segsAfter).toHaveCount(2);
  await expect(segsAfter.nth(0)).toContainText('冲刺组');
  await expect(segsAfter.nth(0)).toContainText('1.5x');
  await expect(segsAfter.nth(1)).toContainText('未勾选');

  // 重新选择同一视频 → 配对成功
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('time-label')).toContainText('0:10');
  await expect(page.getByTestId('needs-video')).toBeHidden();
  await expect(page.getByTestId('segment-list').locator('.segment')).toHaveCount(2);
});

test('F7 AC2：存储清空后回初始态、无报错', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await importAndMark(page);
  await waitAutosave(page);
  await expect(page.getByTestId('needs-video')).toBeHidden();

  // 模拟「浏览器本地存储被清空」：清空动作必须发生在没有任何应用页面存活时
  //（存活页面的 pagehide 会把内存配置写回）。用 initScript 在新文档引导前清空，等价于
  // 用户在浏览器设置里清除站点数据后重新打开。
  await page.context().addInitScript(() => localStorage.clear());
  await page.goto('/?fresh=1'); // 换 query 强制整页加载

  await expect(page.getByTestId('empty-state')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('F7 AC3：本地有配置时打开分享链接 → 草稿态，应用/保留两条路', async ({ page }) => {
  await importAndMark(page);
  await waitAutosave(page);

  const localBefore = await page.evaluate(() => localStorage.getItem('fvp:config'));
  expect(localBefore).toBeTruthy();

  // 构造一份不同的分享密钥（dev server 运行时路径，TS 侧用类型断言对齐真实模块）
  const foreignKey = await page.evaluate(async () => {
    const codecPath = '/src/core/config/codec.ts';
    const editPath = '/src/core/config/edit.ts';
    const codec = (await import(/* @vite-ignore */ codecPath)) as typeof import('../../src/core/config/codec');
    const edit = (await import(/* @vite-ignore */ editPath)) as typeof import('../../src/core/config/edit');
    const cfg = edit.createInitialConfig({ filename: 'coach.mp4', duration: 10 });
    const split = edit.splitSegmentAt(cfg, 3);
    const twoSegs = edit.splitSegmentAt(split.ok ? split.value : cfg, 7);
    return codec.encodeConfig(twoSegs.ok ? twoSegs.value : cfg);
  });

  // 带密钥打开（换 query 强制整页加载）
  await page.goto(`/?from=share#c=${foreignKey}`);

  // 冲突 UI：草稿态提示 + 两个选择
  await expect(page.getByTestId('conflict-banner')).toBeVisible();
  // 草稿内容可预览（3 段 = 对方配置），但本地存储未被改写
  await expect(page.getByTestId('segment-list').locator('.segment')).toHaveCount(3);
  expect(await page.evaluate(() => localStorage.getItem('fvp:config'))).toBe(localBefore);

  // 路径一：保留我的 → 本地配置原样恢复，hash 清除
  await page.getByTestId('conflict-discard').click();
  await expect(page.getByTestId('conflict-banner')).toBeHidden();
  await expect(page.getByTestId('segment-list').locator('.segment')).toHaveCount(2);
  expect(await page.evaluate(() => localStorage.getItem('fvp:config'))).toBe(localBefore);
  expect(await page.evaluate(() => window.location.hash)).toBe('');

  // 再次带密钥进入，改走「应用」
  await page.goto(`/?from=share2#c=${foreignKey}`);
  await expect(page.getByTestId('conflict-banner')).toBeVisible();
  await page.getByTestId('conflict-apply').click();
  await expect(page.getByTestId('conflict-banner')).toBeHidden();
  await expect(page.getByTestId('segment-list').locator('.segment')).toHaveCount(3);

  // 应用后本地存储已更新为对方配置（规范化 JSON 对比）
  const stored = await page.evaluate(() => localStorage.getItem('fvp:config'));
  const matchesKey = await page.evaluate(async ({ k, storedText }) => {
    const codecPath = '/src/core/config/codec.ts';
    const codec = (await import(/* @vite-ignore */ codecPath)) as typeof import('../../src/core/config/codec');
    const decoded = codec.decodeKey(k);
    if (!decoded.ok || !storedText) return false;
    return codec.canonicalize(decoded.value) === storedText;
  }, { k: foreignKey, storedText: stored });
  expect(matchesKey).toBe(true);
});
