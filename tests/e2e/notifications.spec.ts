/**
 * v0.3.2 · 项1 E2E：通知 sticky 吸顶 + info 5s 自动消失 + 并发挤位 + hover 暂停。
 *
 * 冻结通道说明（实现偏差，详见 playwright.config.ts 头注与验证记录）：
 * 方案 v1.1 原定 auto-use fixture 注入通道②（window.__GYMPLAY_TEST_FREEZE_NOTICES__），
 * 但 Playwright 1.64.1 Config 不支持 fixture 定义，改依方案 D-9 通道优先级：
 *   · 默认冻结走通道③ navigator.webdriver === true（本 spec 首用例显式守卫断言其有效性）；
 *   · 计时行为用例（加速消失 / 挤位 / hover 暂停）以通道① ?fvpNoticeTtl=<ms> 显式覆盖。
 */

import { test, expect } from '@playwright/test';

/**
 * E2E 跑在 Node 上，但依赖白名单无 @types/node：经 globalThis 取原生 Buffer 构造
 * setInputFiles 的 buffer 载荷（playwright 需要 buffer.toString('base64') 序列化）。
 */
type NodeBufferFactory = { from(input: string, encoding?: string): object };
const nodeBuffer = (globalThis as { Buffer?: NodeBufferFactory }).Buffer;
if (!nodeBuffer) throw new Error('E2E 需要运行在带全局 Buffer 的 Node 环境');
function jsonBuffer(text: string): object {
  return (nodeBuffer as NodeBufferFactory).from(text, 'utf-8');
}

interface TestSegment {
  id: string;
  start: number;
  end: number;
  rate: number;
  label: string;
  inQueue: boolean;
}

/** 3 段小配置（种子 / 一致性回导）；50 段大配置（差异草稿）。 */
function buildConfig(count = 3): Record<string, unknown> {
  const words = ['热身', '深蹲', '硬拉', '卧推', '划船', '肩推', '弓步', '平板', '拉伸', '开合跳', '波比', '卷腹', '俯卧撑', '高抬腿'];
  const pace = ['慢速', '标准', '快节奏', '冲刺'];
  const step = 10 / count;
  const segments: TestSegment[] = Array.from({ length: count }, (_, i) => ({
    id: i.toString(36).padStart(6, '0'),
    start: i * step,
    end: (i + 1) * step,
    rate: [0.5, 1, 1.5, 2][i % 4],
    label: `${words[i % 14]}第${Math.floor(i / 14) + 1}组·${pace[i % 4]}`,
    inQueue: true,
  }));
  return {
    v: 1,
    video: { type: 'local', filename: 'fixture-vp8-opus-10s.webm', duration: 10 },
    segments,
    sequence: segments.map((s) => s.id),
    loop: { mode: 'queue', count: 3 },
  };
}

const SMALL = buildConfig(3);
// 60 段：密钥实测约 1564 字符 > 1500 判定线 → share-confirm 走 P10 降级出 share-export
// （「超过 1500 字符上限」为 warn，不参与 info 挤位）
const LARGE = buildConfig(60);

async function seedConfig(page: import('@playwright/test').Page, json: string): Promise<void> {
  await page.addInitScript((payload) => {
    window.localStorage.setItem('fvp:config', payload);
  }, json);
}

test('v0.3.2 · 项1：冻结完全静止（通道③ webdriver 守卫）——info 不计时、不挤位', async ({ page }) => {
  await seedConfig(page, JSON.stringify(SMALL));
  await page.goto('/');
  // 守卫：本套件依赖通道③（navigator.webdriver === true）冻结默认通知；
  // 若未来 Playwright/Chromium 改变该默认，此断言失败以提示重估冻结主通道。
  expect(await page.evaluate(() => navigator.webdriver)).toBe(true);

  // 连续 4 次回导同一配置 → 4 条 info（不同文件名确保 change 事件每次触发）
  for (const name of ['a.json', 'b.json', 'c.json', 'd.json']) {
    await page.getByTestId('config-file-input').setInputFiles({
      name,
      mimeType: 'application/json',
      buffer: jsonBuffer(JSON.stringify(SMALL)),
    });
  }
  const infos = page.locator('[data-testid="notice"][data-kind="info"]');
  await expect(infos).toHaveCount(4);

  // 超过默认 TTL（5s）仍全部在列：不计时（无自动消失）+ 不挤位（cap=3 未生效）
  await page.waitForTimeout(5500);
  await expect(infos).toHaveCount(4);
  await expect(infos.filter({ hasText: '这份配置与当前内容一致' })).toHaveCount(4);
});

test('v0.3.2 · 项1：加速消失——?fvpNoticeTtl=500（通道①）覆盖冻结，info 到期自动消失 @m375', async ({ page }) => {
  await seedConfig(page, JSON.stringify(SMALL));
  await page.goto('/?fvpNoticeTtl=500');
  await page.getByTestId('config-file-input').setInputFiles({
    name: 'same.json',
    mimeType: 'application/json',
    buffer: jsonBuffer(JSON.stringify(SMALL)),
  });
  const notice = page.getByTestId('notice').filter({ hasText: '这份配置与当前内容一致' });
  await expect(notice).toBeVisible();
  // 500ms TTL 到期后自动消失（expect 自动重试等待消失）
  await expect(notice).toHaveCount(0);
});

test('v0.3.2 · 项1：并发挤位——info 上限 3 条，第 4 条到达时最旧被移除 @m375', async ({ page }) => {
  await seedConfig(page, JSON.stringify(SMALL));
  // 通道① 给足长 TTL：本用例只验证挤位，不让到期行为混入
  await page.goto('/?fvpNoticeTtl=60000');

  // 4 条互异 info：一致回导 → 草稿载入 → 应用草稿 → 导出文件
  await page.getByTestId('config-file-input').setInputFiles({
    name: 'same.json',
    mimeType: 'application/json',
    buffer: jsonBuffer(JSON.stringify(SMALL)),
  });
  await expect(page.getByTestId('notice').filter({ hasText: '这份配置与当前内容一致' })).toBeVisible();

  await page.getByTestId('config-file-input').setInputFiles({
    name: 'large.json',
    mimeType: 'application/json',
    buffer: jsonBuffer(JSON.stringify(LARGE)),
  });
  await expect(page.getByTestId('notice').filter({ hasText: '已载入分享编排为草稿' })).toBeVisible();

  await page.getByTestId('conflict-apply').click();
  await expect(page.getByTestId('notice').filter({ hasText: '已应用分享编排' })).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('share-open').click();
  await page.getByTestId('share-confirm').click();
  await expect(page.getByTestId('share-too-long')).toBeVisible();
  await page.getByTestId('share-export').click();
  await downloadPromise;
  await expect(page.getByTestId('notice').filter({ hasText: '配置已导出为 .json 文件' })).toBeVisible();

  // 挤位：最旧（一致性回导）被移除，其余 3 条保留
  await expect(page.getByTestId('notice').filter({ hasText: '这份配置与当前内容一致' })).toHaveCount(0);
  await expect(page.getByTestId('notice').filter({ hasText: '已载入分享编排为草稿' })).toBeVisible();
  await expect(page.getByTestId('notice').filter({ hasText: '已应用分享编排' })).toBeVisible();
  await expect(page.getByTestId('notice').filter({ hasText: '配置已导出为 .json 文件' })).toBeVisible();
  await expect(page.locator('[data-testid="notice"][data-kind="info"]')).toHaveCount(3);
});

test('v0.3.2 · 项1：hover 暂停——悬停 info 冻结剩余计时，移开后顺延消失', async ({ page }) => {
  await seedConfig(page, JSON.stringify(SMALL));
  await page.goto('/?fvpNoticeTtl=2000');
  await page.getByTestId('config-file-input').setInputFiles({
    name: 'same.json',
    mimeType: 'application/json',
    buffer: jsonBuffer(JSON.stringify(SMALL)),
  });
  const notice = page.locator('[data-testid="notice"][data-kind="info"]').filter({ hasText: '这份配置与当前内容一致' });
  await expect(notice).toBeVisible();

  // 悬停：暂停冻结剩余时长；等待超过原 TTL（2000ms）仍存活
  await notice.hover();
  await page.waitForTimeout(2600);
  await expect(notice).toBeVisible();

  // 移开：恢复顺延，剩余时长耗尽后消失（expect 自动重试）
  await page.mouse.move(0, 0);
  await expect(notice).toHaveCount(0);
});
