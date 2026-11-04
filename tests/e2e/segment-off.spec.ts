/**
 * v0.3.2 · 项6 E2E：未选中段可预览（视觉语义守卫）。
 *
 * 1. 不选段直接拖进度条可预览（timeline scrub → preview，空洞斜纹轨道不挡手势）；
 * 2. 未勾选段色块带 tl__seg--off 类（视觉弱化），仍可点选打开详情（不禁交互）。
 */

import { test, expect } from '@playwright/test';

const FIXTURE = new URL('./fixtures/fixture-vp8-opus-10s.webm', import.meta.url).pathname;

test('项6 · 不选段拖进度条可预览 + 未勾选段弱化但仍可点选', async ({ page }) => {
  const cfg = {
    v: 1,
    video: { type: 'local', filename: 'fixture-vp8-opus-10s.webm', duration: 10 },
    segments: [
      { id: 'aaa000', start: 0, end: 5, rate: 1, label: '热身', inQueue: true },
      { id: 'bbb111', start: 5, end: 10, rate: 1, label: '冲刺', inQueue: false },
    ],
    sequence: ['aaa000'],
    loop: { mode: 'off' },
  };
  await page.addInitScript((payload) => {
    window.localStorage.setItem('fvp:config', payload);
  }, JSON.stringify(cfg));
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('play-queue')).toBeVisible();

  // 不选段直接拖进度条（timeline 手势 → 自由预览，空洞轨道不挡）
  const track = page.getByTestId('timeline');
  const box = await track.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.6, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.75, box!.y + box!.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId('play-mode-badge')).toContainText('预览');

  // 未勾选段色块弱化类（tl__seg--off，仅视觉），仍可点选打开详情
  const offSeg = page.getByTestId('timeline-seg-bbb111');
  await expect(offSeg).toHaveClass(/tl__seg--off/);
  await page.getByTestId('segment-item-bbb111').click();
  await expect(page.getByTestId('detail-label')).toBeVisible();
});
