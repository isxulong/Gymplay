/**
 * v0.3.2 · 项3 E2E：换视频按钮（UX-反馈2）——首个换视频确认流自动化覆盖。
 *
 * 方案 v1.1 复测修正：replace-banner / replace-confirm / replace-cancel 及
 * COPY_REPLACE_CONFIRM 在 tests/ 全量零断言命中，本 spec 2 条为首个覆盖：
 *   1. 更换 → 确认 → 清空重建（新视频装载、配置清零、横幅文案含「且无法撤销」）
 *   2. 更换 → 取消 → 配置原样
 */

import { test, expect } from '@playwright/test';

const FIXTURE_URL = '/tests/e2e/fixtures/fixture-vp8-opus-10s.webm';
/** 文件系统路径（setInputFiles 用，与 export-import.spec 同构） */
const FIXTURE_PATH = new URL('./fixtures/fixture-vp8-opus-10s.webm', import.meta.url).pathname;

interface TestSegment {
  id: string;
  start: number;
  end: number;
  rate: number;
  label: string;
  inQueue: boolean;
}

/** 2 段种子配置（与 fixture 视频同名配对）。 */
function buildConfig(): Record<string, unknown> {
  const segments: TestSegment[] = [
    { id: 'seg001', start: 0, end: 4, rate: 1.5, label: '热身', inQueue: true },
    { id: 'seg002', start: 4, end: 10, rate: 2, label: '冲刺', inQueue: true },
  ];
  return {
    v: 1,
    video: { type: 'local', filename: 'fixture-vp8-opus-10s.webm', duration: 10 },
    segments,
    sequence: segments.map((s) => s.id),
    loop: { mode: 'queue', count: 3 },
  };
}

/**
 * 取 fixture 视频字节（换视频需「不同名」文件触发确认横幅）：经 Playwright
 * APIRequestContext 从 dev server 拉取（依赖白名单无 @types/node，不引入 fs，
 * 返回类型经 Playwright 自身类型推断，不做显式 Buffer 标注）。
 */
async function fetchFixtureBytes(page: import('@playwright/test').Page) {
  const resp = await page.request.get(FIXTURE_URL);
  expect(resp.ok()).toBeTruthy();
  return resp.body();
}

async function setupLoadedEditor(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript((json) => {
    window.localStorage.setItem('fvp:config', json);
  }, JSON.stringify(buildConfig()));
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(FIXTURE_PATH);
  await expect(page.getByTestId('segment-list').getByRole('button')).toHaveCount(2);
  await expect(page.getByTestId('change-video')).toBeVisible();
}

test('v0.3.2 · 项3：换视频 → 确认 → 配置清空重建（确认横幅含「且无法撤销」）', async ({ page }) => {
  await setupLoadedEditor(page);
  const fixtureBytes = await fetchFixtureBytes(page);

  // 换视频按钮 → file-input → 选择不同名视频 → 确认横幅
  await page.getByTestId('change-video').click();
  await page.getByTestId('file-input').setInputFiles({
    name: 'another-video.webm',
    mimeType: 'video/webm',
    buffer: fixtureBytes,
  });
  const banner = page.getByTestId('replace-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('且无法撤销');

  // 确认 → 清空重建：原配置段（热身/冲刺）清空，新视频以初始默认段重建（整段「段 1」）
  await page.getByTestId('replace-confirm').click();
  await expect(banner).toHaveCount(0);
  const segs = page.getByTestId('segment-list').getByRole('button');
  await expect(segs).toHaveCount(1);
  await expect(segs.first()).toContainText('段 1');
  await expect(segs.first()).not.toContainText('热身');
  await expect(page.getByTestId('time-label')).toContainText('0:10');
});

test('v0.3.2 · 项3：换视频 → 取消 → 原配置原样保留', async ({ page }) => {
  await setupLoadedEditor(page);
  const fixtureBytes = await fetchFixtureBytes(page);

  await page.getByTestId('change-video').click();
  await page.getByTestId('file-input').setInputFiles({
    name: 'another-video.webm',
    mimeType: 'video/webm',
    buffer: fixtureBytes,
  });
  await expect(page.getByTestId('replace-banner')).toBeVisible();

  // 取消 → 配置原样：2 段保留、横幅关闭、视频未换
  await page.getByTestId('replace-cancel').click();
  await expect(page.getByTestId('replace-banner')).toHaveCount(0);
  await expect(page.getByTestId('segment-list').getByRole('button')).toHaveCount(2);
  await expect(page.getByTestId('segment-list').getByRole('button').first()).toContainText('热身');
  await expect(page.getByTestId('time-label')).toContainText('0:10');
});
