/**
 * M2 出口门禁 2：单段循环 100 圈无泄漏（真实浏览器实测）。
 *
 * 任务口径「F4 AC5」：需求冻结稿 F4 仅 AC1~AC3，单段循环语义在 F5 AC3；
 * 本测试按任务语义执行——单段循环连跑 100 圈，断言：
 * ① 100 圈全部完成（页面内 10ms 采样检测播放头回卷计数）；
 * ② JS 堆在 10 圈 → 100 圈之间增长 < 8MB（--enable-precise-memory-info + 手动 GC）；
 * ③ 100 圈后播放仍在正常循环（状态未腐化）。
 * 结构性泄漏（订阅/定时器累积）另由单测「单段循环 100 圈无泄漏」确定性锁定。
 *
 * 段 [0,0.5] @4x → 每圈 0.125s，100 圈 ≈ 12.5s。
 */

import { test, expect } from '@playwright/test';

const FIXTURE = new URL('./fixtures/fixture-vp8-opus-10s.webm', import.meta.url).pathname;

declare global {
  interface Window {
    __loops?: number;
    gc?: () => void;
  }
}

test('单段循环 100 圈无泄漏（真实 <video> + VP8/Opus fixture）', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('time-label')).toContainText('0:10');

  // 打点 t=0.5 → [0,0.5] + [0.5,10]；段1 设 4x；开单段循环
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) v.currentTime = 0.5;
  });
  await page.getByTestId('mark-button').click();
  await expect(page.getByTestId('segment-list').getByRole('button')).toHaveCount(2);
  await page.getByTestId('segment-list').getByRole('button').nth(0).click();
  await page.getByTestId('rate-4').click();
  await page.getByTestId('loop-segment').click();

  await page.getByTestId('play-queue').click();
  await expect(page.getByTestId('queue-status')).toHaveAttribute('data-playing', 'true');

  // 页面内 10ms 采样：播放头回卷（currentTime 骤降）即一圈
  await page.evaluate(() => {
    const v = document.querySelector('video')!;
    window.__loops = 0;
    let prev = -1;
    setInterval(() => {
      const t = v.currentTime;
      if (prev >= 0 && t < prev - 0.03) window.__loops! += 1;
      prev = t;
    }, 10);
  });

  const readLoops = (): Promise<number> => page.evaluate(() => window.__loops ?? 0);
  const readHeap = (): Promise<number> =>
    page.evaluate(() => {
      window.gc?.();
      return (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize;
    });

  // 热身后取基线（第 10 圈），排除首次播放的一次性分配
  await expect.poll(readLoops, { timeout: 20000 }).toBeGreaterThanOrEqual(10);
  const heapAt10 = await readHeap();

  // 跑满 100 圈
  await expect.poll(readLoops, { timeout: 60000, intervals: [500] }).toBeGreaterThanOrEqual(100);
  const heapAt100 = await readHeap();

  const growthMB = (heapAt100 - heapAt10) / 1048576;
  console.log(`单段循环堆增长：${growthMB.toFixed(3)}MB（10 圈 ${(heapAt10 / 1048576).toFixed(2)}MB → 100 圈 ${(heapAt100 / 1048576).toFixed(2)}MB）`);
  expect(growthMB).toBeLessThan(8);

  // 100 圈后仍在正常循环（未 finished、未暂停）
  const st = await page.evaluate(() => {
    const v = document.querySelector('video')!;
    return { paused: v.paused, t: v.currentTime, rate: v.playbackRate };
  });
  expect(st.paused).toBe(false);
  expect(st.rate).toBe(4);
  expect(st.t).toBeLessThan(0.6);
});
