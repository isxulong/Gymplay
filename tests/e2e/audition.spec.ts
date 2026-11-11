/**
 * v0.3.2 · 项9 E2E：单段试听（audit 状态机 + 15 行打断语义矩阵）。
 *
 * 六条（方案项9 测试影响清单）：
 * 1. 起播徽标：段列表「试听」→ 段首 @段值起播，徽标「试听 · 段名 · 速率」（橙色）；
 * 2. 暂停续播保速：试听中 transport ▶/⏸ → 暂停/续播，不退出、速率保持段值（矩阵 #1）；
 * 3. scrub 退出：试听中拖进度条 → 退出试听，速率归 1、徽标回预览（矩阵 #2）；
 * 4. 调速热更新：试听中改速率 → 就地生效不打断（矩阵 #6）；
 * 5. 自然播完归 1x：到达段 end → 试听结束，速率归 1、徽标回预览（矩阵 #10）；
 * 6. 换段退出：试听中点选另一段 → 段首 @1x 自由预览起播（矩阵 #3）。
 *
 * testid 契约：段列表快捷入口 audition-seg-{id}；sheet 主入口 audition-start / audition-stop；
 * 徽标 play-mode-badge 三态（试听 · X · Nx / 队列 · … / 预览 · 1x）。
 */

import { test, expect } from '@playwright/test';
import { e2ePath } from './e2e-paths';

const FIXTURE = e2ePath('./fixtures/fixture-vp8-opus-10s.webm');

interface TestSegment {
  id: string;
  start: number;
  end: number;
  rate: number;
  label: string;
  inQueue: boolean;
}

/** 两段：A 0-5 @1x（真实 5s），B 5-10 @1x——1x 段保证窗口宽裕、断言不与竞速 */
function twoSegConfig(): Record<string, unknown> {
  const segments: TestSegment[] = [
    { id: 'aaa000', start: 0, end: 5, rate: 1, label: '热身', inQueue: true },
    { id: 'bbb111', start: 5, end: 10, rate: 1, label: '冲刺', inQueue: true },
  ];
  return {
    v: 1,
    video: { type: 'local', filename: 'fixture-vp8-opus-10s.webm', duration: 10 },
    segments,
    sequence: segments.map((s) => s.id),
    loop: { mode: 'off' },
  };
}

async function seedAndLoad(
  page: import('@playwright/test').Page,
  cfg: Record<string, unknown>,
): Promise<void> {
  await page.addInitScript((payload) => {
    window.localStorage.setItem('fvp:config', payload);
  }, JSON.stringify(cfg));
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('play-queue')).toBeVisible();
}

async function playbackRate(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const v = document.querySelector('video');
    return v ? v.playbackRate : -1;
  });
}

test('项9 · 起播徽标：段列表「试听」→ 段首起播，徽标为试听态 @m375', async ({ page }) => {
  await seedAndLoad(page, twoSegConfig());
  await page.getByTestId('audition-seg-aaa000').click();
  await expect(page.getByTestId('play-mode-badge')).toHaveText('试听 · 热身 · 1x');
  // 徽标橙色态
  await expect(page.getByTestId('play-mode-badge')).toHaveClass(/fvp-play-mode-badge--audit/);
  // ■ 停止按钮（队列区）在试听中可用（矩阵 #12 disabled 条件）
  await expect(page.getByTestId('stop-queue')).toBeEnabled();
});

test('项9 · 暂停续播保速：试听中 ▶/⏸ 不退出、速率不变（矩阵 #1） @m375', async ({ page }) => {
  await seedAndLoad(page, twoSegConfig());
  await page.getByTestId('audition-seg-aaa000').click();
  await expect(page.getByTestId('play-mode-badge')).toHaveText('试听 · 热身 · 1x');
  await page.getByTestId('play-toggle').click();
  await page.waitForTimeout(300);
  // 暂停后仍是试听态、速率未归 1 之外的变化
  await expect(page.getByTestId('play-mode-badge')).toHaveText('试听 · 热身 · 1x');
  await page.getByTestId('play-toggle').click();
  await page.waitForTimeout(300);
  await expect(page.getByTestId('play-mode-badge')).toHaveText('试听 · 热身 · 1x');
});

test('项9 · scrub 退出：试听中拖进度条 → 退出试听，速率归 1、徽标回预览（矩阵 #2）', async ({ page }) => {
  await seedAndLoad(page, twoSegConfig());
  await page.getByTestId('audition-seg-aaa000').click();
  await expect(page.getByTestId('play-mode-badge')).toHaveText('试听 · 热身 · 1x');
  // 水平拖动进度条（超过 MOVE_SLOP）→ onSeek → seekPreview 守卫退出试听
  const tl = page.getByTestId('timeline');
  const box = await tl.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.3, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.6, box!.y + box!.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await expect(page.getByTestId('play-mode-badge')).toHaveText('预览 · 1x');
  expect(await playbackRate(page)).toBe(1);
});

test('项9 · 调速热更新：试听中经详情改速率 → 就地生效不打断（矩阵 #6）', async ({ page }) => {
  await seedAndLoad(page, twoSegConfig());
  // 先选中段（打开 sheet），再起播试听（移动端 sheet 模态顺序经验：入口互不遮挡）
  await page.getByTestId('segment-item-aaa000').click();
  await expect(page.getByTestId('detail-label')).toBeVisible();
  await page.getByTestId('audition-start').click();
  await expect(page.getByTestId('play-mode-badge')).toHaveText('试听 · 热身 · 1x');
  await page.getByTestId('rate-2').click();
  await page.waitForTimeout(300);
  // 就地生效：徽标速率刷 2、播放速率 2、仍是试听态
  await expect(page.getByTestId('play-mode-badge')).toHaveText('试听 · 热身 · 2x');
  expect(await playbackRate(page)).toBe(2);
});

test('项9 · 自然播完归 1x：到达段 end → 试听结束（矩阵 #10）', async ({ page }) => {
  await seedAndLoad(page, twoSegConfig());
  await page.getByTestId('audition-seg-aaa000').click();
  await expect(page.getByTestId('play-mode-badge')).toHaveText('试听 · 热身 · 1x');
  // A 段 0-5 @1x：真实 5s 播完，留余量等 8s
  await expect(page.getByTestId('play-mode-badge')).toHaveText('预览 · 1x', { timeout: 9000 });
  expect(await playbackRate(page)).toBe(1);
});

test('项9 · 换段退出：试听中点选另一段 → 段首 @1x 自由预览起播（矩阵 #3） @m375', async ({ page }) => {
  await seedAndLoad(page, twoSegConfig());
  await page.getByTestId('audition-seg-aaa000').click();
  await expect(page.getByTestId('play-mode-badge')).toHaveText('试听 · 热身 · 1x');
  await page.getByTestId('segment-item-bbb111').click();
  await page.waitForTimeout(300);
  await expect(page.getByTestId('play-mode-badge')).toHaveText('预览 · 1x');
  expect(await playbackRate(page)).toBe(1);
  // 跳到新段起点（B 段首 5s）
  const t = await page.evaluate(() => document.querySelector('video')?.currentTime ?? -1);
  expect(t).toBeGreaterThanOrEqual(5);
});
