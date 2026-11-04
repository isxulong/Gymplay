/**
 * E2E · Gymplay v0.3.1 三项需求验收（R1 时间轴拖动寻址 / R2 音量控制 / R3 mm:ss.s 起止输入）。
 *
 * 验收标准来源：产品需求文档《Gymplay v0.3.1 迭代需求梳理》R1 AC1-AC6、R2 AC1-AC3/AC5、
 * R3 AC1-AC6/AC8；交互模型按《时间轴精确打点交互方案 v1.1》（垂直距离灵敏度档位）。
 * R2 AC4 / R3 AC7（密钥字节一致）由 scripts/key-compat.mjs 双跑对照脚本（基线 vs 当前树
 * encodeConfig 字节比对）与单测覆盖，不在本文件。
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const FIXTURE = new URL('./fixtures/fixture-vp8-opus-10s.webm', import.meta.url).pathname;
const LONG_CONFIG = new URL('./fixtures/config-v031-long.json', import.meta.url).pathname;

async function importFixture(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('time-label')).toContainText('0:10');
}

async function seekVideo(page: Page, t: number): Promise<void> {
  await page.evaluate((sec) => {
    const v = document.querySelector('video');
    if (v) v.currentTime = sec;
  }, t);
}

async function currentTime(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('video')?.currentTime ?? -1);
}

async function isPaused(page: Page): Promise<boolean> {
  return page.evaluate(() => document.querySelector('video')?.paused ?? true);
}

async function volume(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('video')?.volume ?? -1);
}

async function isMuted(page: Page): Promise<boolean> {
  return page.evaluate(() => document.querySelector('video')?.muted ?? true);
}

/** 在轨道上做一次按下 → 水平拖动 → 松开；返回轨道盒。 */
async function dragOnTrack(
  page: Page,
  fromRatioX: number,
  toRatioX: number,
  offsetY = 0,
): Promise<void> {
  const box = (await page.getByTestId('timeline').boundingBox())!;
  const cy = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * fromRatioX, cy);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * toRatioX, cy + offsetY, { steps: 12 });
  await page.waitForTimeout(80); // 等 rAF 落实最后一帧
  await page.mouse.up();
}

test.describe('R1 时间轴可拖动播放头', () => {
  test('AC1/AC2：色块上拖动=寻址不选中，落点 ±0.2s，暂停状态不变', async ({ page }) => {
    await importFixture(page);
    // 制造色块：t=2 打点 → [0,2] [2,10]
    await seekVideo(page, 2);
    await page.getByTestId('mark-button').click();
    await expect(page.getByTestId('segment-list').getByRole('button')).toHaveCount(2);
    expect(await isPaused(page)).toBe(true); // 打点即暂停，拖动前为暂停态

    // 从轨道 50%（色块上）拖到 80%：t 应落在 8s 附近
    await dragOnTrack(page, 0.5, 0.8);
    const t = await currentTime(page);
    expect(Math.abs(t - 8)).toBeLessThanOrEqual(0.2);
    // 未发生段选中
    await expect(page.getByTestId('detail-sheet')).toBeHidden(); // 项8 迁移：空态断言改 sheet 隐藏
    // 播放状态与拖动前一致（仍暂停）
    expect(await isPaused(page)).toBe(true);
    // 松手后气泡隐藏
    await expect(page.getByTestId('scrub-bubble')).toBeHidden();
  });

  test('AC6 + v1.1 §7.3：拖动全程气泡显示时刻与档位，垂直距离驱动 1x→1/4→1/8', async ({ page }) => {
    await importFixture(page);
    const box = (await page.getByTestId('timeline').boundingBox())!;
    const cy = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.3, cy);
    await page.mouse.down();
    // 水平拖动进入 scrub（d=0 → 1x）
    await page.mouse.move(box.x + box.width * 0.45, cy, { steps: 10 });
    await page.waitForTimeout(80);
    await expect(page.getByTestId('scrub-bubble')).toBeVisible();
    await expect(page.getByTestId('scrub-time')).toContainText(/^\d+:\d{2}\.\d$/);
    await expect(page.getByTestId('scrub-gear')).toHaveText('1x');
    // 时间码实时刷新为 m:ss.s
    await expect(page.getByTestId('time-label')).toContainText(/\d+:\d{2}\.\d \//);
    // 下压 50px（32<d≤96 → 精调 1/4，黄色徽标）
    await page.mouse.move(box.x + box.width * 0.5, cy + 50, { steps: 6 });
    await page.waitForTimeout(80);
    await expect(page.getByTestId('scrub-gear')).toHaveText('精调 1/4');
    await expect(page.getByTestId('scrub-gear')).toHaveClass(/tl__gear--q/);
    // 继续下压到 120px（d>96 → 精调 1/8，橙色徽标）
    await page.mouse.move(box.x + box.width * 0.55, cy + 120, { steps: 6 });
    await page.waitForTimeout(80);
    await expect(page.getByTestId('scrub-gear')).toHaveText('精调 1/8');
    await expect(page.getByTestId('scrub-gear')).toHaveClass(/tl__gear--e/);
    await page.mouse.up();
    await expect(page.getByTestId('scrub-bubble')).toBeHidden();
  });

  test('AC3：单击色块（位移<5px）保留 v0.3.0 语义——选中并跳段首播放 @m375', async ({ page }) => {
    await importFixture(page);
    await seekVideo(page, 2);
    await page.getByTestId('mark-button').click();
    await expect(page.getByTestId('segment-list').getByRole('button')).toHaveCount(2);

    await page.locator('.tl__seg[data-seg-id]').first().click();
    // 选中该段（详情出现）且跳段首自动播放（F2 AC2 不破）
    await expect(page.getByTestId('detail-sheet')).toContainText('编辑：'); // 项8 迁移：机械替换选择器串
    await expect.poll(() => isPaused(page)).toBe(false);
    expect((await currentTime(page)) - 0).toBeLessThanOrEqual(0.5);
  });

  test('AC4/AC5：空白点击 seek；向左/向右拖出界钳制在 0 与 duration', async ({ page }) => {
    await importFixture(page);
    const box = (await page.getByTestId('timeline').boundingBox())!;
    // 空白点击：色块下方刻度条区域（色块 bottom:14px，轨道高 56px）
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height - 4);
    await expect.poll(() => currentTime(page)).toBeGreaterThan(4.5);
    expect(await currentTime(page)).toBeLessThanOrEqual(5.5);
    await expect(page.getByTestId('detail-sheet')).toBeHidden(); // 项8 迁移：空态断言改 sheet 隐藏

    // 向左拖出界 → 钳制 0
    const cy = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.3, cy);
    await page.mouse.down();
    await page.mouse.move(box.x - 80, cy, { steps: 12 });
    await page.waitForTimeout(80);
    await page.mouse.up();
    expect(await currentTime(page)).toBe(0);

    // 向右拖出界 → 钳制 duration（10s）
    await page.mouse.move(box.x + box.width * 0.3, cy);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 80, cy, { steps: 12 });
    await page.waitForTimeout(80);
    await page.mouse.up();
    const dur = await page.evaluate(() => document.querySelector('video')?.duration ?? 0);
    expect(await currentTime(page)).toBeGreaterThanOrEqual(dur - 0.2);
    expect(await currentTime(page)).toBeLessThanOrEqual(dur);
  });

  test('T3：拖动前在播放，松手后继续播放（不自动暂停）', async ({ page }) => {
    await importFixture(page);
    await page.getByTestId('play-toggle').click();
    await expect.poll(() => isPaused(page)).toBe(false);
    await dragOnTrack(page, 0.2, 0.5);
    expect(await isPaused(page)).toBe(false);
  });

  test('v1.1 §7.2：步进按钮暂停时显示、单击步进、播放中隐藏', async ({ page }) => {
    await importFixture(page);
    await seekVideo(page, 5);
    await page.getByTestId('play-toggle').click(); // 播放
    await expect.poll(() => isPaused(page)).toBe(false);
    await expect(page.getByTestId('step-buttons')).toBeHidden();
    await page.getByTestId('play-toggle').click(); // 暂停
    await expect(page.getByTestId('step-buttons')).toBeVisible();

    const t0 = await currentTime(page);
    await page.getByTestId('step-plus-1s').click();
    expect((await currentTime(page)) - t0).toBeGreaterThan(0.9);
    const t1 = await currentTime(page);
    await page.getByTestId('step-minus-0.1s').click();
    expect(t1 - (await currentTime(page))).toBeGreaterThan(0.05);
    // 长按连发：按住 +0.1s 约 700ms，应步进多档（1 + 连发若干次）
    const t2 = await currentTime(page);
    const btn = await page.getByTestId('step-plus-0.1s').boundingBox();
    await page.mouse.move(btn!.x + 5, btn!.y + 5);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    expect((await currentTime(page)) - t2).toBeGreaterThan(0.15);
    // 越界钳制：从 0 再 −1s 不产生负值
    await seekVideo(page, 0.2);
    await page.waitForTimeout(100);
    await page.getByTestId('step-minus-1s').click();
    expect(await currentTime(page)).toBe(0);
  });
});

test.describe('v0.3.1 补强（复核一 P2-1 / P2-2 / P3-1 / P3-3）', () => {
  test('v1.1 §3.1：播放头手柄 44px 热区可抓，按住微调不跳到按压点', async ({ page }) => {
    await importFixture(page);
    await seekVideo(page, 2);
    await page.getByTestId('mark-button').click(); // 段 [0,2] [2,10]，打点即暂停
    await seekVideo(page, 5); // 播放头位于 50%
    await page.waitForTimeout(100); // 等帧回调落实播放头位置
    const box = (await page.getByTestId('timeline').boundingBox())!;
    const gripX = box.x + box.width * 0.5;
    const gripY = box.y + 22; // 热区 44px 中心（轨道顶部）

    // §9 第 9 条口径：指尖偏手柄中心 20px 内仍可抓起（热区半宽 22px）
    await page.mouse.move(gripX + 20, gripY);
    await page.mouse.down();
    await page.mouse.move(gripX + 20 + box.width * 0.1, gripY, { steps: 12 });
    await page.waitForTimeout(80); // 等 rAF 落实最后一帧
    await page.mouse.up();
    // 从 5s 微调 +10% 轨道 = +1s（若误按「轨道任意位置」重锚定，落点会是 ≈5.2s+1s=6.2s 之外更远处；
    // 若未识别手柄则锚定按压点 ≈5+0.2s 附近再 +1s）——断言从当前播放位置起算
    const t = await currentTime(page);
    expect(Math.abs(t - 6)).toBeLessThanOrEqual(0.2);

    // 手柄上轻点（无位移）= 无操作：不 seek、不选中
    // 注意：拖动后播放头已移动到 ≈5.9s，须按手柄当前位置重取坐标
    const gripBox = (await page.getByTestId('timeline-playhead-grip').boundingBox())!;
    await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    expect(await currentTime(page)).toBeCloseTo(t, 1);
    await expect(page.getByTestId('detail-sheet')).toBeHidden(); // 项8 迁移：空态断言改 sheet 隐藏
  });

  test('v1.1 §3.2：拖动落点距段边界 ±8px 内吸附对齐，窗口外不吸附', async ({ page }) => {
    await importFixture(page);
    await seekVideo(page, 2);
    await page.getByTestId('mark-button').click(); // 边界集合 {0, 2, 10}
    const box = (await page.getByTestId('timeline').boundingBox())!;
    const cy = box.y + box.height / 2;
    const boundaryX = box.x + box.width * 0.2; // 2s 边界
    const startX = box.x + box.width * 0.5; // 从 5s 起拖（远离边界，避免起点即吸附）

    // 窗口内：落点 = 边界 +5px（< 8px）→ 吸附到精确 2.0s
    await page.mouse.move(startX, cy);
    await page.mouse.down();
    await page.mouse.move(boundaryX + 5, cy, { steps: 12 });
    await page.waitForTimeout(80);
    await page.mouse.up();
    expect(Math.abs((await currentTime(page)) - 2)).toBeLessThan(0.02);

    // 窗口外：落点 = 边界 +20px（> 8px）→ 不吸附，落在 ≈2+20px 对应时刻
    await page.mouse.move(startX, cy);
    await page.mouse.down();
    await page.mouse.move(boundaryX + 20, cy, { steps: 12 });
    await page.waitForTimeout(80);
    await page.mouse.up();
    expect(Math.abs((await currentTime(page)) - 2)).toBeGreaterThan(0.05);
  });

  test('v1.1 §2：长按（≥300ms）未达位移线不算轻点——不选中、不 seek（TAP_MAX_MS 生效）', async ({ page }) => {
    await importFixture(page);
    await seekVideo(page, 2);
    await page.getByTestId('mark-button').click();
    await seekVideo(page, 5);
    const box = (await page.getByTestId('timeline').boundingBox())!;
    // 长按色块（10% 处，属段 [0,2]）400ms 静止后抬起
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(400);
    await page.mouse.up();
    await expect(page.getByTestId('detail-sheet')).toBeHidden(); // 项8 迁移：空态断言改 sheet 隐藏 // 未触发选中
    expect(await currentTime(page)).toBeCloseTo(5, 1); // 未触发 seek
  });

  test('R2 AC5 补强：音量拖到 0 图标呈现静音态，拖回恢复（复核一 P3-1）', async ({ page }) => {
    await importFixture(page);
    const slider = page.getByTestId('volume-slider');
    const mute = page.getByTestId('volume-mute');
    await expect(mute).toHaveText('🔊');
    // 拖到 0：未按静音键，但界面呈现等价静音态
    await slider.evaluate((el: HTMLInputElement) => {
      el.value = '0';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(await volume(page)).toBe(0);
    expect(await isMuted(page)).toBe(false);
    await expect(mute).toHaveText('🔇');
    // 拖回 30：恢复有声图标
    await slider.evaluate((el: HTMLInputElement) => {
      el.value = '30';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect(mute).toHaveText('🔊');
    // volume=0 时切换静音键：图标保持静音态（muted 与 volume=0 任一成立即 🔇）
    await slider.evaluate((el: HTMLInputElement) => {
      el.value = '0';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await mute.click();
    await mute.click();
    expect(await isMuted(page)).toBe(false);
    await expect(mute).toHaveText('🔇');
  });

  test('R3 补强：单字段非法只恢复该字段，另一字段未提交编辑保留（复核一 P3-3b）', async ({ page }) => {
    await importFixture(page);
    await seekVideo(page, 2);
    await page.getByTestId('mark-button').click();
    await page.getByTestId('segment-list').getByRole('button').first().click();
    await expect(page.getByTestId('detail-start')).toHaveValue('0:00.0');
    await expect(page.getByTestId('detail-end')).toHaveValue('0:02.0');
    const startInput = page.getByTestId('detail-start');
    const endInput = page.getByTestId('detail-end');
    // 用 evaluate 直写 value：fill 会聚焦/失焦，失焦触发原生 change 提前提交另一字段
    await startInput.evaluate((el: HTMLInputElement) => {
      el.value = 'abc'; // 非法
    });
    await endInput.evaluate((el: HTMLInputElement) => {
      el.value = '0:01.5'; // 有效但未提交
    });
    await startInput.dispatchEvent('change');
    await expect(page.getByTestId('detail-bounds-error')).toBeVisible();
    await expect(startInput).toHaveValue('0:00.0'); // 非法字段恢复原值
    await expect(endInput).toHaveValue('0:01.5'); // 另一字段未提交编辑保留
  });
});

test.describe('R2 播放器音量控制', () => {
  test('AC1/AC2/AC5：滑杆生效、静音切换、极端值', async ({ page }) => {
    await importFixture(page);
    const slider = page.getByTestId('volume-slider');
    const mute = page.getByTestId('volume-mute');

    // AC1：滑杆 100 → 30
    await slider.evaluate((el: HTMLInputElement) => {
      el.value = '30';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(await volume(page)).toBeCloseTo(0.3, 5);

    // AC2：静音切换图标与状态；取消后音量保持
    await expect(mute).toHaveText('🔊');
    await mute.click();
    expect(await isMuted(page)).toBe(true);
    await expect(mute).toHaveText('🔇');
    await mute.click();
    expect(await isMuted(page)).toBe(false);
    expect(await volume(page)).toBeCloseTo(0.3, 5);

    // AC5：拖到 0；拖到 100 后静音再取消恢复 100%
    await slider.evaluate((el: HTMLInputElement) => {
      el.value = '0';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(await volume(page)).toBe(0);
    await slider.evaluate((el: HTMLInputElement) => {
      el.value = '100';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await mute.click();
    await mute.click();
    expect(await volume(page)).toBe(1);
    expect(await isMuted(page)).toBe(false);
  });

  test('AC3：按设备记忆——刷新并重导入后恢复 0.3', async ({ page }) => {
    await importFixture(page);
    await page.getByTestId('volume-slider').evaluate((el: HTMLInputElement) => {
      el.value = '30';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(await volume(page)).toBeCloseTo(0.3, 5);

    // 刷新后本地配置自动恢复（needs-video 态），重新导入同一视频
    await page.reload();
    await page.getByTestId('file-input').setInputFiles(FIXTURE);
    await expect(page.getByTestId('time-label')).toContainText('0:10');
    expect(await volume(page)).toBeCloseTo(0.3, 5);
    await expect(page.getByTestId('volume-slider')).toHaveValue('30');
  });
});

test.describe('R3 起止时间 mm:ss.s', () => {
  test('AC1/AC2/AC5/AC6/AC8：显示换算、输入生效、非法/越界拒绝、精度', async ({ page }) => {
    await importFixture(page);
    await seekVideo(page, 2);
    await page.getByTestId('mark-button').click();
    await page.getByTestId('segment-list').getByRole('button').first().click();
    // AC1：显示为 mm:ss.s
    await expect(page.getByTestId('detail-start')).toHaveValue('0:00.0');
    await expect(page.getByTestId('detail-end')).toHaveValue('0:02.0');

    // AC2：输入 mm:ss.s 生效（[0,2] → [0,1.5]，不越邻居 2s 边界）
    const endInput = page.getByTestId('detail-end');
    await endInput.fill('0:01.5');
    await endInput.dispatchEvent('change');
    await expect(page.getByTestId('detail-end')).toHaveValue('0:01.5');
    await expect(page.getByTestId('segment-list').getByRole('button').first()).toContainText('0:01.5');

    // AC8：12:34.56 式多位小数四舍五入到 0.1s
    await endInput.fill('0:01.56');
    await endInput.dispatchEvent('change');
    await expect(page.getByTestId('detail-end')).toHaveValue('0:01.6');

    // AC5：非法输入 → 提示 + 恢复原值 + 不变更
    await endInput.fill('abc');
    await endInput.dispatchEvent('change');
    await expect(page.getByTestId('detail-bounds-error')).toBeVisible();
    await expect(page.getByTestId('detail-end')).toHaveValue('0:01.6');
    await endInput.fill('12:99');
    await endInput.dispatchEvent('change');
    await expect(page.getByTestId('detail-end')).toHaveValue('0:01.6');

    // AC6：与后段重叠（>2s）→ 拒绝（既有 warn 通知通道）+ 恢复原值
    await endInput.fill('0:09.9');
    await endInput.dispatchEvent('change');
    await expect(page.getByTestId('detail-end')).toHaveValue('0:01.6');
    await expect(page.locator('[data-testid="notice"][data-kind="warn"]').first()).toBeVisible();

    // AC4：纯秒与无小数位写法兼容
    await endInput.fill('1.5');
    await endInput.dispatchEvent('change');
    await expect(page.getByTestId('detail-end')).toHaveValue('0:01.5');
    await endInput.fill('0:02');
    await endInput.dispatchEvent('change');
    await expect(page.getByTestId('detail-end')).toHaveValue('0:02.0');
  });

  test('AC3：视频满 1 小时显示并接受 h:mm:ss.s', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('config-file-input').setInputFiles(LONG_CONFIG);
    await page.getByTestId('segment-list').getByRole('button').nth(1).click();
    // 3723.4s → 1:02:03.4
    await expect(page.getByTestId('detail-start')).toHaveValue('1:02:03.4');
    // 输入 h:mm:ss.s 解析回秒并提交
    const startInput = page.getByTestId('detail-start');
    await startInput.fill('1:02:03.5');
    await startInput.dispatchEvent('change');
    await expect(page.getByTestId('detail-start')).toHaveValue('1:02:03.5');
  });
});
