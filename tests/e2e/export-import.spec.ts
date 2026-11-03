/**
 * E2E · 载体二降级路径（M3 接线，终审报告步骤 2 门禁）：
 * - >50 段配置生成分享链接超 1500 判定线 → 不生成链接，UI 引导走「导出配置」（非静默截断）；
 * - 导出 .json 文件 → 全新上下文「导入配置」→ 60 段配置完整还原（分段/速度/勾选/顺序/循环）；
 * - 导入同一视频 → 配对装载成功、无时长不一致告警（状态一致）；
 * - 粘贴 .json 文本装入与非法文件报错路径。
 */

import { test, expect } from '@playwright/test';

// 注：不引入 node:fs（依赖白名单无 @types/node）；导出文件经 download.path() 拿到真实路径后
// 直接作为 setInputFiles 的输入回读，内容断言走「同页回导 → 与当前内容一致」的 round-trip。

const FIXTURE = new URL('./fixtures/fixture-vp8-opus-10s.webm', import.meta.url).pathname;

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

/**
 * 60 段配置（>50 段判定线）：视频口径对齐 e2e fixture（10s），密钥实测约 1564 字符 > 1500 判定线，
 * 接收方导入后可用同一 fixture 视频真实配对（无时长钳制，验证状态一致）。
 */
function buildLargeConfig(count = 60) {
  const words = ['热身', '深蹲', '硬拉', '卧推', '划船', '肩推', '弓步', '平板', '拉伸', '开合跳', '波比', '卷腹', '俯卧撑', '高抬腿'];
  const pace = ['慢速', '标准', '快节奏', '冲刺'];
  const step = 10 / count;
  const segments: TestSegment[] = Array.from({ length: count }, (_, i) => ({
    id: i.toString(36).padStart(6, '0'),
    start: i * step,
    end: (i + 1) * step,
    rate: [0.5, 1, 1.5, 2][i % 4],
    label: `${words[i % 14]}第${Math.floor(i / 14) + 1}组·${pace[i % 4]}`,
    inQueue: i !== count - 1,
  }));
  return {
    v: 1,
    video: { type: 'local', filename: 'fixture-vp8-opus-10s.webm', duration: 10 },
    segments,
    sequence: [...segments.map((s) => s.id), segments[0].id, segments[1].id],
    loop: { mode: 'queue', count: 3 },
  };
}

test('M3 门禁：>50 段超链接上限引导导出，导出→导入后 60 段完整还原并配对视频', async ({ page, browser }) => {
  // —— 发送方：本地恢复一份 60 段配置（localStorage 种子） ——
  await page.addInitScript((json) => {
    window.localStorage.setItem('fvp:config', json);
  }, JSON.stringify(buildLargeConfig()));
  await page.goto('/');
  const segs = page.getByTestId('segment-list').getByRole('button');
  await expect(segs).toHaveCount(60);

  // —— 超 1500 判定线：不生成链接，引导导出（验收 b） ——
  await page.getByTestId('share-open').click();
  await page.getByTestId('share-confirm').click();
  await expect(page.getByTestId('share-too-long')).toBeVisible();
  await expect(page.getByTestId('share-too-long')).toContainText('导出配置');
  await expect(page.getByTestId('notice').filter({ hasText: '超过 1500 字符上限' })).toBeVisible();
  // 不出现长链接（非静默截断、也不给一条不可用的链接）
  await expect(page.getByTestId('share-link')).toHaveCount(0);

  // —— 导出 .json 文件（下载事件） ——
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('share-export').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^gymplay-config-.*\.json$/);
  const exportedPath = await download.path();
  expect(exportedPath).toBeTruthy();

  // —— 同页回导导出的文件：与当前 60 段配置 canonicalize 完全一致（round-trip 内容完整性） ——
  await page.getByTestId('config-file-input').setInputFiles(exportedPath as string);
  await expect(page.getByTestId('notice').filter({ hasText: '与当前内容一致' })).toBeVisible();

  // —— 接收方：全新上下文（无本地配置）导入 .json 文件 ——
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  try {
    await page2.goto('/');
    await page2.getByTestId('config-file-input').setInputFiles(exportedPath as string);

    // 直接生效 → 待配对视频引导；60 段完整还原（验收 a）
    await expect(page2.getByTestId('needs-video')).toBeVisible();
    await expect(page2.getByTestId('needs-video-text')).toContainText('fixture-vp8-opus-10s.webm');
    const segs2 = page2.getByTestId('segment-list').getByRole('button');
    await expect(segs2).toHaveCount(60);
    // 抽查辨识点：段名/速度/取消勾选
    await expect(segs2.nth(0)).toContainText('热身');
    await expect(segs2.nth(0)).toContainText('0.5x');
    await expect(segs2.nth(1)).toContainText('1x');
    await expect(segs2.nth(3)).toContainText('2x');
    await expect(segs2.nth(59)).toContainText('未勾选');
    // 队列与循环语义（62 引用全渲染，未勾选段置灰不进播放队列）
    await expect(page2.getByTestId('queue-list').getByRole('listitem')).toHaveCount(62);
    await expect(page2.getByTestId('loop-queue')).toBeChecked();
    await expect(page2.getByTestId('loop-count')).toHaveValue('3');

    // —— 导入同一视频（时长与配置一致）→ 配对装载成功、无时长不一致告警（状态一致） ——
    await page2.getByTestId('file-input').setInputFiles(FIXTURE);
    await expect(page2.getByTestId('time-label')).toContainText('0:10');
    await expect(page2.getByTestId('needs-video')).toBeHidden();
    await expect(page2.getByTestId('notice').filter({ hasText: '可能不是同一份视频' })).toHaveCount(0);
    // 配对后 60 段仍完整在列（未被钳制丢弃）
    await expect(page2.getByTestId('segment-list').getByRole('button')).toHaveCount(60);
  } finally {
    await ctx2.close();
  }
});

test('M3：空态导入入口可用；粘贴 .json 配置文本装入并走草稿态（F7 AC3）', async ({ page }) => {
  await page.goto('/');
  // —— 冷启动空态：接收方经「导入编排配置」入口装入 .json ——
  await page.getByTestId('empty-import').click();
  await page.getByTestId('config-file-input').setInputFiles({
    name: 'gymplay-config.json',
    mimeType: 'application/json',
    buffer: jsonBuffer(JSON.stringify(buildLargeConfig())),
  });
  await expect(page.getByTestId('needs-video')).toBeVisible();
  await expect(page.getByTestId('segment-list').getByRole('button')).toHaveCount(60);
  await expect(page.getByTestId('notice').filter({ hasText: '配置已导入' })).toBeVisible();

  // —— 编辑器密钥框粘贴另一份配置 JSON（50 段）→ 草稿态挂起 ——
  await page.getByTestId('key-input').fill(JSON.stringify(buildLargeConfig(50)));
  await page.getByTestId('key-import').click();
  await expect(page.getByTestId('conflict-banner')).toBeVisible();
  await expect(page.getByTestId('segment-list').getByRole('button')).toHaveCount(50); // 草稿预览
  // —— 应用草稿 → 转正为生效配置 ——
  await page.getByTestId('conflict-apply').click();
  await expect(page.getByTestId('conflict-banner')).toHaveCount(0);
  await expect(page.getByTestId('segment-list').getByRole('button')).toHaveCount(50);
  await expect(page.getByTestId('notice').filter({ hasText: '已应用分享编排' })).toBeVisible();
});

test('M3：损坏的配置文件报错且不进入半配置状态', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('config-file-input').setInputFiles({
    name: 'broken.json',
    mimeType: 'application/json',
    buffer: jsonBuffer('{oops not json'),
  });
  await expect(page.getByTestId('notice').filter({ hasText: '不是合法 JSON' })).toBeVisible();
  // 不落配置：回到初始空态（F8 AC4 纪律）
  await expect(page.getByTestId('empty-state')).toBeVisible();
});

test('M3：本地已有配置时导入 .json 走草稿态（F7 AC3），应用后转正', async ({ page }) => {
  // 种子本地配置（3 段）
  const small = buildLargeConfig(3);
  await page.addInitScript((json) => {
    window.localStorage.setItem('fvp:config', json);
  }, JSON.stringify(small));
  await page.goto('/');
  await expect(page.getByTestId('segment-list').getByRole('button')).toHaveCount(3);

  // 导入大配置 → 草稿挂起
  const big = buildLargeConfig();
  await page.getByTestId('config-file-input').setInputFiles({
    name: 'gymplay-config.json',
    mimeType: 'application/json',
    buffer: jsonBuffer(JSON.stringify(big)),
  });
  await expect(page.getByTestId('conflict-banner')).toBeVisible();
  await expect(page.getByTestId('segment-list').getByRole('button')).toHaveCount(60); // 草稿预览
  // 应用草稿 → 转正为生效配置
  await page.getByTestId('conflict-apply').click();
  await expect(page.getByTestId('conflict-banner')).toHaveCount(0);
  await expect(page.getByTestId('segment-list').getByRole('button')).toHaveCount(60);
  await expect(page.getByTestId('save-state')).toContainText('已自动保存');
});
