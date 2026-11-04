/**
 * v0.3.2 · 项7 E2E：变速隔离（F7′）+ 模式徽标。
 *
 * 五条（试听相关用例 Phase 4 一并落地）：
 * 1. 停止归 1x——队列 2x 播放中点停止，徽标回「预览 · 1x」、playbackRate 归 1；
 * 2. 改速后预览 1x——段值 2 的配置下自由播放，playbackRate 为 1（段值不泄漏）；
 * 3. 队列暂停续播——暂停/继续不改变段值速率与徽标；
 * 4. scrub 退出——队列播放中拖进度条 → 退出队列转自由预览（速率归 1）；
 * 5. 选段退出——队列播放中点选另一段 → 段首 @1x 自由预览起播（F2-AC2）。
 *
 * 徽标文案契约（editor renderFrame）：队列态「队列 · 第 {n}/{N} 项 · {rate}x」；
 * 非队列态「预览 · 1x」。
 */

import { test, expect } from '@playwright/test';

type NodeBufferFactory = { from(input: string, encoding?: string): object };
const nodeBuffer = (globalThis as { Buffer?: NodeBufferFactory }).Buffer;
if (!nodeBuffer) throw new Error('E2E 需要运行在带全局 Buffer 的 Node 环境');

const FIXTURE = new URL('./fixtures/fixture-vp8-opus-10s.webm', import.meta.url).pathname;

interface TestSegment {
  id: string;
  start: number;
  end: number;
  rate: number;
  label: string;
  inQueue: boolean;
}

/** 两段配置：seg1 0-5 @2x（真实耗时 2.5s），seg2 5-10 @1.5x */
function twoSegConfig(): Record<string, unknown> {
  const segments: TestSegment[] = [
    { id: 'aaa000', start: 0, end: 5, rate: 2, label: '快节奏', inQueue: true },
    { id: 'bbb111', start: 5, end: 10, rate: 1.5, label: '标准', inQueue: true },
  ];
  return {
    v: 1,
    video: { type: 'local', filename: 'fixture-vp8-opus-10s.webm', duration: 10 },
    segments,
    sequence: segments.map((s) => s.id),
    loop: { mode: 'off' },
  };
}

/** 单段整段配置（指定速率；0.75x → 真实耗时 13.3s，为暂停/续播用例留足窗口） */
function oneSegConfig(rate: number): Record<string, unknown> {
  const segments: TestSegment[] = [
    { id: 'aaa000', start: 0, end: 10, rate, label: '整段', inQueue: true },
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

test('项7 · 停止归 1x：队列 2x 播放中停止，徽标回预览、速率归 1', async ({ page }) => {
  await seedAndLoad(page, twoSegConfig());
  await page.getByTestId('play-queue').click();
  await expect(page.getByTestId('play-mode-badge')).toHaveText('队列 · 第 1/2 项 · 2x');
  expect(await playbackRate(page)).toBe(2);
  await page.getByTestId('stop-queue').click();
  await expect(page.getByTestId('play-mode-badge')).toHaveText('预览 · 1x');
  expect(await playbackRate(page)).toBe(1);
});

test('项7 · 改速后预览 1x：段值 2 的配置下自由播放，速率不携带段值', async ({ page }) => {
  await seedAndLoad(page, oneSegConfig(2));
  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('play-mode-badge')).toHaveText('预览 · 1x');
  expect(await playbackRate(page)).toBe(1);
});

test('项7 · 队列暂停续播：暂停/继续保段值速率与徽标', async ({ page }) => {
  await seedAndLoad(page, oneSegConfig(1.25));
  await page.getByTestId('play-queue').click();
  await expect(page.getByTestId('play-mode-badge')).toHaveText('队列 · 第 1/1 项 · 1.25x');
  expect(await playbackRate(page)).toBe(1.25);
  // 暂停
  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('play-toggle')).toHaveText('▶ 播放');
  // 续播：速率仍为段值
  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('play-mode-badge')).toHaveText('队列 · 第 1/1 项 · 1.25x');
  expect(await playbackRate(page)).toBe(1.25);
});

test('项7 · scrub 退出：队列播放中拖进度条 → 退出队列转自由预览', async ({ page }) => {
  await seedAndLoad(page, oneSegConfig(1.5));
  await page.getByTestId('play-queue').click();
  await expect(page.getByTestId('play-mode-badge')).toHaveText('队列 · 第 1/1 项 · 1.5x');
  // 水平拖动进度条（超过 MOVE_SLOP）→ onSeek → seekPreview 守卫退出队列
  const tl = page.getByTestId('timeline');
  const box = await tl.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.3, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.6, box!.y + box!.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId('play-mode-badge')).toHaveText('预览 · 1x');
  expect(await playbackRate(page)).toBe(1);
});

test('项7 · 选段退出：队列播放中点选另一段 → 段首 @1x 自由预览起播', async ({ page }) => {
  await seedAndLoad(page, twoSegConfig());
  await page.getByTestId('play-queue').click();
  await expect(page.getByTestId('play-mode-badge')).toHaveText('队列 · 第 1/2 项 · 2x');
  await page.getByTestId('segment-item-bbb111').click();
  await expect(page.getByTestId('play-mode-badge')).toHaveText('预览 · 1x');
  expect(await playbackRate(page)).toBe(1);
  // F2-AC2：跳段首（允许播放推进的少量偏移）
  const t = await page.evaluate(() => document.querySelector('video')!.currentTime);
  expect(t).toBeGreaterThanOrEqual(4.9);
  expect(t).toBeLessThan(7);
});
