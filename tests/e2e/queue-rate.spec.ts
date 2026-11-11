/**
 * v0.3.2 · 项5 E2E：队列内快捷调速。
 *
 * 1. 三处同步：queue-rate select 改速 → 队列项 label 速率 + 详情面板档位高亮同步；
 * 2. 同段联动提示：重复段（totalOccurrences>1）→ queue-rate-hint 常驻「同段 N 处一起变」；
 * 3. 调速即停队列 + 配置字节一致：队列播放中 select 调速 → 退出队列回预览；
 *    经队列调速与经详情调速到同值的落盘配置（规范化 JSON）字节相等。
 */

import { test, expect } from '@playwright/test';
import { e2ePath } from './e2e-paths';

type NodeBufferFactory = { from(input: string, encoding?: string): object };
const nodeBuffer = (globalThis as { Buffer?: NodeBufferFactory }).Buffer;
if (!nodeBuffer) throw new Error('E2E 需要运行在带全局 Buffer 的 Node 环境');

const FIXTURE = e2ePath('./fixtures/fixture-vp8-opus-10s.webm');

interface TestSegment {
  id: string;
  start: number;
  end: number;
  rate: number;
  label: string;
  inQueue: boolean;
}

/** 2 段配置（默认各 1x） */
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

async function readSavedConfig(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => window.localStorage.getItem('fvp:config') ?? '');
}

test('项5 · 三处同步：queue-rate 改速 → 队列 label 与详情档位高亮同步 @m375', async ({ page }) => {
  await seedAndLoad(page, twoSegConfig());
  // v0.3.2 · 项8 双跑适配：先调速后选中——移动端 sheet 为模态弹层（scrim 挡住
  // 页面其余区域），队列 select 须在 sheet 打开前操作；三处同步语义不变
  await page.getByTestId('queue-rate-0').selectOption('2');
  await expect(page.getByTestId('queue-entry-0')).toContainText('2x');
  // 选中段 1 打开详情（初始非 2x 的对照由 1x→2x 的档位高亮变化承担）
  await page.getByTestId('segment-item-aaa000').click();
  await expect(page.getByTestId('detail-label')).toBeVisible();
  await expect(page.getByTestId('rate-2')).toHaveClass(/rate--active/);
});

test('项5 · 同段联动提示：重复段后 hint 常驻「同段 2 处一起变」', async ({ page }) => {
  await seedAndLoad(page, twoSegConfig());
  await expect(page.getByTestId('queue-rate-hint-0')).toHaveCount(0);
  await page.getByTestId('queue-dup-0').click();
  await expect(page.getByTestId('queue-rate-hint-0')).toBeVisible();
  await expect(page.getByTestId('queue-rate-hint-0')).toHaveText('同段 2 处一起变');
  await expect(page.getByTestId('queue-rate-hint-1')).toBeVisible();
});

test('项5 · 调速即停队列 + 配置字节一致（队列调速 ≡ 详情调速） @m375', async ({ page }) => {
  await seedAndLoad(page, twoSegConfig());
  // 队列播放中调速 → 退出队列回预览（调速即停，B评A 坚持与 A 共识）
  await page.getByTestId('play-queue').click();
  await expect(page.getByTestId('play-mode-badge')).toHaveText('队列 · 第 1/2 项 · 1x');
  await page.getByTestId('queue-rate-0').selectOption('1.5');
  await expect(page.getByTestId('play-mode-badge')).toHaveText('预览 · 1x');
  // 防抖 300ms 落盘后读取（规范化 JSON）
  await page.waitForTimeout(600);
  const viaQueue = await readSavedConfig(page);
  expect(viaQueue).toContain('"rate":1.5');
  // 经详情调速到同值：刷新恢复配置后重新装载视频（对齐 duration 钳制）再走详情链路
  await page.reload();
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('play-queue')).toBeVisible();
  await page.getByTestId('segment-item-aaa000').click();
  await page.getByTestId('rate-1.5').click();
  await page.waitForTimeout(600);
  const viaDetail = await readSavedConfig(page);
  expect(viaDetail).toBe(viaQueue);
});
