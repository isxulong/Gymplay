/**
 * v0.3.2 · 项8 E2E（Phase 3 布局终态）：详情 sheet 化 + 960px 桌面断点。
 *
 * 1. sheet 开合（@m375 双跑）：选中段 → sheet 开 + scrim 现身；关闭三通道
 *    （sheet-close 按钮 / scrim 点击 / sheet 头部下滑手势）各自生效；
 * 2. 选中态联动 + 详情编辑（@m375 双跑）：A→B 切换 sheet 内容跟随；sheet 内
 *    rename 编辑生效（detail-* 输入类 testid 不受 sheet 化影响）；
 * 3. 桌面断点形态（本用例自带 viewport 切换，不参与 @m375 双跑）：≥960 时
 *    detailSheet 挂在 aside.editor-aside（grid 第二列）、scrim 常隐；缩到 <960
 *    时节点移回主文档流、scrim 随开合现身（applyLayout 双宿主移动）。
 *
 * 真机项（不在 E2E 范围）：iOS Safari translateY / safe-area、sheet 手势触摸跟手、
 * 低端安卓 WebView 帧率（退化开关 .fvp--sheet-static）。
 */

import { test, expect } from '@playwright/test';

const FIXTURE = new URL('./fixtures/fixture-vp8-opus-10s.webm', import.meta.url).pathname;

const CFG = {
  v: 1,
  video: { type: 'local', filename: 'fixture-vp8-opus-10s.webm', duration: 10 },
  segments: [
    { id: 'aaa000', start: 0, end: 5, rate: 1, label: '热身', inQueue: true },
    { id: 'bbb111', start: 5, end: 10, rate: 1.5, label: '冲刺', inQueue: true },
  ],
  sequence: ['aaa000', 'bbb111'],
  loop: { mode: 'off' },
};

async function loadEditor(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript((payload) => {
    window.localStorage.setItem('fvp:config', payload);
  }, JSON.stringify(CFG));
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('play-queue')).toBeVisible();
}

async function sheetParentClass(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const sheet = document.querySelector('[data-testid="detail-sheet"]');
    return sheet && sheet.parentElement ? sheet.parentElement.className : '';
  });
}

test('项8 · sheet 开合：选中即开，关闭三通道（按钮 / scrim / 下滑）各自生效 @m375', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await loadEditor(page);

  // 初始未选中：sheet 与 scrim 均隐藏，段列表底部出现引导 hint（不占 testid）
  await expect(page.getByTestId('detail-sheet')).toBeHidden();
  await expect(page.getByTestId('sheet-scrim')).toBeHidden();
  await expect(page.locator('.segments__hint')).toContainText('点选段落条上的段');

  // 选中 → sheet 开 + scrim 现身（移动端底部弹层）
  await page.getByTestId('segment-item-aaa000').click();
  await expect(page.getByTestId('detail-sheet')).toBeVisible();
  await expect(page.getByTestId('detail-sheet')).toContainText('编辑：热身');
  await expect(page.getByTestId('sheet-scrim')).toBeVisible();

  // 关闭通道一：sheet-close 按钮
  await page.getByTestId('sheet-close').click();
  await expect(page.getByTestId('detail-sheet')).toBeHidden();
  await expect(page.getByTestId('sheet-scrim')).toBeHidden();

  // 关闭通道二：点击 scrim 关闭（点 scrim 顶部区域——中心被 sheet 覆盖，
  // 移动端 sheet 为模态弹层属预期形态）
  await page.getByTestId('segment-item-aaa000').click();
  await expect(page.getByTestId('detail-sheet')).toBeVisible();
  await page.getByTestId('sheet-scrim').click({ position: { x: 10, y: 10 } });
  await expect(page.getByTestId('detail-sheet')).toBeHidden();

  // 关闭通道三：sheet 头部下滑手势（>48px 松手即关；鼠标驱动 pointer 事件）
  await page.getByTestId('segment-item-bbb111').click();
  await expect(page.getByTestId('detail-sheet')).toContainText('编辑：冲刺');
  const headBox = await page.locator('.detail-sheet__head').boundingBox();
  expect(headBox).not.toBeNull();
  await page.mouse.move(headBox!.x + headBox!.width / 2, headBox!.y + headBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(headBox!.x + headBox!.width / 2, headBox!.y + headBox!.height / 2 + 80, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId('detail-sheet')).toBeHidden();
  await expect(page.getByTestId('sheet-scrim')).toBeHidden();
});

test('项8 · 选中态联动：sheet 内编辑生效，删除段随选中态消失自动收起 @m375', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await loadEditor(page);

  await page.getByTestId('segment-item-aaa000').click();
  await expect(page.getByTestId('detail-sheet')).toContainText('编辑：热身');
  await expect(page.getByTestId('detail-start')).toHaveValue('0:00.0');
  await expect(page.getByTestId('detail-end')).toHaveValue('0:05.0');

  // sheet 内 rename 编辑生效（detail-* 输入类 testid 零改动守卫）
  const label = page.getByTestId('detail-label');
  await label.fill('波比跳');
  await label.press('Enter');
  await expect(page.getByTestId('detail-sheet')).toContainText('编辑：波比跳');
  await expect(page.getByTestId('segment-item-aaa000')).toContainText('波比跳');

  // 移动端 sheet 为模态弹层：切换段先收起（scrim 挡住列表属预期形态），再选 B
  await page.getByTestId('sheet-close').click();
  await expect(page.getByTestId('detail-sheet')).toBeHidden();
  await page.getByTestId('segment-item-bbb111').click();
  await expect(page.getByTestId('detail-sheet')).toContainText('编辑：冲刺');
  await expect(page.getByTestId('detail-start')).toHaveValue('0:05.0');
  await expect(page.getByTestId('detail-end')).toHaveValue('0:10.0');

  // 删除段（sheet 内动作）→ sheet 随选中态消失自动收起
  await page.getByTestId('detail-delete').click();
  await expect(page.getByTestId('detail-sheet')).toBeHidden();
  await expect(page.getByTestId('sheet-scrim')).toBeHidden();
});

test('项8 · 桌面断点形态：≥960 挂右栏 aside、scrim 常隐；缩回 <960 移回主文档流', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await loadEditor(page);

  // 桌面：选中 → sheet 在 aside.editor-aside（grid 第二列），scrim 由 CSS 常隐
  await page.getByTestId('segment-item-aaa000').click();
  await expect(page.getByTestId('detail-sheet')).toBeVisible();
  await expect.poll(() => sheetParentClass(page)).toContain('editor-aside');
  await expect(page.getByTestId('sheet-scrim')).toBeHidden();
  await expect(page.getByTestId('detail-sheet')).toContainText('编辑：热身');
  // grip（下滑手势抓手）在桌面隐藏
  await expect(page.locator('.detail-sheet__grip')).toBeHidden();

  // 缩到 <960：matchMedia change → applyLayout 把节点移回主文档流，scrim 随开合现身
  await page.setViewportSize({ width: 375, height: 667 });
  await expect.poll(() => sheetParentClass(page)).toContain('fvp-editor');
  await expect(page.getByTestId('detail-sheet')).toBeVisible();
  await expect(page.getByTestId('sheet-scrim')).toBeVisible();
  await page.getByTestId('sheet-close').click();
  await expect(page.getByTestId('detail-sheet')).toBeHidden();

  // 桌面无 scrim：段列表点 B 直接切换 sheet 内容（不关不重开，联动）
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect.poll(() => sheetParentClass(page)).toContain('editor-aside');
  await page.getByTestId('segment-item-bbb111').click();
  await expect(page.getByTestId('detail-sheet')).toContainText('编辑：冲刺');
  await expect(page.getByTestId('detail-sheet')).toBeVisible();
  await expect(page.getByTestId('sheet-scrim')).toBeHidden();
});
