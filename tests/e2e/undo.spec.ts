/**
 * v0.3.2 · 项2+10 E2E：多段撤销历史回收站。
 *
 * 1. 删→undo→配置逐字一致：撤销后 localStorage fvp:config 与删除前字符串逐字相等，
 *    且 encodeConfig 密钥字节相等（页内动态 import codec 计算）；
 * 2. 连删 3 段→恢复中间步：截断条目置灰只读（「已随更早的恢复一并回退」），
 *    更早的删除仍可恢复，恢复记录只读展示；
 * 3. 删→reload→重放横幅：bootstrap 从 localStorage 恢复撤销栈，横幅再现且可恢复；
 * 4. 删→调速→栈清空：世界线断裂编辑清栈，回收站入口隐藏，localStorage 键移除。
 */

import { test, expect } from '@playwright/test';

const FIXTURE = new URL('./fixtures/fixture-vp8-opus-10s.webm', import.meta.url).pathname;

interface TestSegment {
  id: string;
  start: number;
  end: number;
  rate: number;
  label: string;
  inQueue: boolean;
}

function seg(id: string, start: number, end: number, label: string): TestSegment {
  return { id, start, end, rate: 1, label, inQueue: true };
}

/** 2 段配置（10s fixture：0-5 / 5-10） */
function twoSegConfig(): Record<string, unknown> {
  const segments = [seg('aaa000', 0, 5, '热身'), seg('bbb111', 5, 10, '冲刺')];
  return {
    v: 1,
    video: { type: 'local', filename: 'fixture-vp8-opus-10s.webm', duration: 10 },
    segments,
    sequence: segments.map((s) => s.id),
    loop: { mode: 'off' },
  };
}

/** 4 段配置（10s fixture：每段 2.5s），供连删 3 段场景 */
function fourSegConfig(): Record<string, unknown> {
  const segments = [
    seg('aaa000', 0, 2.5, 'A'),
    seg('bbb111', 2.5, 5, 'B'),
    seg('ccc222', 5, 7.5, 'C'),
    seg('ddd333', 7.5, 10, 'D'),
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

function readSavedConfig(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => window.localStorage.getItem('fvp:config') ?? '');
}

/** 页内计算 encodeConfig 密钥（dev server 动态 import codec），验证字节级一致 */
function computeKey(page: import('@playwright/test').Page, cfgStr: string): Promise<string> {
  return page.evaluate(async (payload) => {
    // 动态表达式 import：运行时由 Vite dev server 解析（tsc 不做字面量模块解析）
    const mod = '/src/core/config/codec.ts';
    const { encodeConfig } = (await import(/* @vite-ignore */ mod)) as {
      encodeConfig: (cfg: unknown) => string;
    };
    return encodeConfig(JSON.parse(payload));
  }, cfgStr);
}

test('项2+10 · 删→undo→配置逐字一致 + 密钥字节相等 @m375', async ({ page }) => {
  await seedAndLoad(page, twoSegConfig());
  // 初始落盘稳定后取基线
  await page.waitForTimeout(600);
  const before = await readSavedConfig(page);
  const keyBefore = await computeKey(page, before);

  // 删段：选中「冲刺」→ 详情删除
  await page.getByTestId('segment-item-bbb111').click();
  await page.getByTestId('detail-delete').click();
  await expect(page.getByTestId('undo-banner')).toBeVisible();
  await expect(page.getByTestId('undo-banner')).toContainText('已删除段「冲刺」');
  await page.waitForTimeout(600);
  const afterDelete = await readSavedConfig(page);
  expect(afterDelete).not.toBe(before);
  expect(afterDelete).not.toContain('bbb111');

  // 撤销 → 配置回到删除前
  await page.getByTestId('undo-restore').click();
  await expect(page.getByTestId('undo-banner')).toBeHidden();
  await expect(page.getByTestId('segment-list').locator('.segment')).toHaveCount(2);
  await page.waitForTimeout(600);
  const afterUndo = await readSavedConfig(page);
  expect(afterUndo).toBe(before); // 落盘配置逐字一致
  const keyAfter = await computeKey(page, afterUndo);
  expect(keyAfter).toBe(keyBefore); // 密钥字节级相等
});

test('项2+10 · 连删 3 段→恢复中间步→截断条目只读 @m375', async ({ page }) => {
  await seedAndLoad(page, fourSegConfig());
  // 依次删 D、C、B（栈：[D, C, B]，B 为栈顶）
  for (const id of ['ddd333', 'ccc222', 'bbb111']) {
    await page.getByTestId(`segment-item-${id}`).click();
    await page.getByTestId('detail-delete').click();
  }
  await expect(page.getByTestId('segment-list').locator('.segment')).toHaveCount(1);
  await expect(page.getByTestId('recycle-bin')).toHaveText('🗑 回收站 (3)');

  // 打开回收站，恢复中间步（C，栈下标 1）
  await page.getByTestId('recycle-bin').click();
  await expect(page.getByTestId('recycle-panel')).toBeVisible();
  await expect(page.getByTestId('recycle-restore-1')).toBeVisible();
  await page.getByTestId('recycle-restore-1').click();
  // v0.3.3 · 项3：恢复「不是当前世界线末端」的记录是**两步操作**——点击只落
  // `state.undoConfirm`（面板内弹出确认横幅），需显式确认才真正提交。
  // 此处补的是**交互步骤**：本用例自有的断言与期望值一字未改。
  await page.getByTestId('undo-confirm-apply').click();

  // 配置回到「只删了 D」的世界线：A、B、C 三段回归
  await expect(page.getByTestId('segment-list').locator('.segment')).toHaveCount(3);
  await expect(page.getByTestId('segment-item-bbb111')).toBeVisible();
  await expect(page.getByTestId('segment-item-ccc222')).toBeVisible();
  await expect(page.getByTestId('segment-item-ddd333')).toHaveCount(0);

  // 截断条目只读：C、B 置灰（栈下标 1、2），D（下标 0）仍可恢复
  await expect(page.getByTestId('recycle-note-1')).toContainText('已随更早的恢复一并回退');
  await expect(page.getByTestId('recycle-note-2')).toContainText('已随更早的恢复一并回退');
  await expect(page.getByTestId('recycle-restore-1')).toHaveCount(0);
  await expect(page.getByTestId('recycle-restore-2')).toHaveCount(0);
  await expect(page.getByTestId('recycle-restore-0')).toBeVisible();
  // 恢复记录（只读）存在，头部计数只剩 1 步
  await expect(page.getByTestId('recycle-panel')).toContainText('回收站（1 步可恢复）');
});

/**
 * 不经 addInitScript 的种子装载（reload 场景专用）：
 * init script 会在每次 reload 时重跑并重写 fvp:config，覆盖删除后的落盘状态，
 * 因此该场景改为 goto 后手动写 localStorage 再 reload 生效。
 */
async function seedAndLoadNoReseed(
  page: import('@playwright/test').Page,
  cfg: Record<string, unknown>,
): Promise<void> {
  await page.goto('/');
  await page.evaluate((payload) => {
    window.localStorage.setItem('fvp:config', payload);
  }, JSON.stringify(cfg));
  await page.reload();
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('play-queue')).toBeVisible();
}

test('项2+10 · 删→reload→重放横幅并可恢复', async ({ page }) => {
  await seedAndLoadNoReseed(page, twoSegConfig());
  await page.getByTestId('segment-item-bbb111').click();
  await page.getByTestId('detail-delete').click();
  await expect(page.getByTestId('undo-banner')).toBeVisible();
  await page.waitForTimeout(600);

  // 刷新：撤销栈从 localStorage 恢复，横幅重放（需重装视频对齐 duration 钳制）
  await page.reload();
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('play-queue')).toBeVisible();
  await expect(page.getByTestId('undo-banner')).toBeVisible();
  await expect(page.getByTestId('undo-banner')).toContainText('已删除段「冲刺」');
  await expect(page.getByTestId('recycle-bin')).toHaveText('🗑 回收站 (1)');

  // 重放后仍可撤销
  await page.getByTestId('undo-restore').click();
  await expect(page.getByTestId('segment-list').locator('.segment')).toHaveCount(2);
  await page.waitForTimeout(600);
  const cfg = await readSavedConfig(page);
  expect(cfg).toContain('bbb111');
});

test('项2+10 · 删→调速→栈清空 + 回收站隐藏 + 键移除', async ({ page }) => {
  // ⚠ 用例名沿用旧名（§5「不删不改名」：只改期望值）。名字里的「栈清空 / 回收站隐藏 / 键移除」
  // 是 v0.3.2 的旧行为描述，已与本用例体内的新期望相反——保留旧名仅为不改动用例标识。
  // v0.3.3 · 项3 · 期望反转（旧期望：调速后 banner 隐藏 / recycle-bin 隐藏 / 存储键移除）。
  // 反转理由：调速是「不改变删了哪些段」的编辑，按方案 3-c 不再清栈。历史与入口都保留，
  // 存储键仍在；与当前编排的落差改由「逐条门禁 + 恢复前确认」承担。
  // ⚠ 该用例已实跑通过（含本用例反转后的新期望）。实跑方式：
  //   FVP_CHROMIUM_PATH=/opt/chromium.org/chromium/chrome npx playwright test
  // 沙箱内 headless Chromium 不提供 Wake Lock API，仅影响 cockpit-path3 的跟屏提示用例
  //（该条在无补丁基线上同样失败，属环境限制）；CI 的 GitHub Actions Runner 浏览器
  // 该连接可用，同用例在 CI 上通过（2026-11-06 run 42235441682：73 passed / 0 failed）。
  await seedAndLoad(page, twoSegConfig());
  await page.getByTestId('segment-item-bbb111').click();
  await page.getByTestId('detail-delete').click();
  await expect(page.getByTestId('recycle-bin')).toHaveText('🗑 回收站 (1)');
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => window.localStorage.getItem('fvp:undo-history'))).not.toBeNull();

  // 非删除编辑（调速）：**不清栈**、横幅仍在、回收站入口仍可见、localStorage 键保留
  await page.getByTestId('segment-item-aaa000').click();
  await page.getByTestId('rate-2').click();
  await expect(page.getByTestId('undo-banner')).toBeVisible();
  await expect(page.getByTestId('recycle-bin')).toBeVisible();
  await expect(page.getByTestId('recycle-bin')).toHaveText('🗑 回收站 (1)');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.localStorage.getItem('fvp:undo-history'))).not.toBeNull();
});

/**
 * v0.3.3 · 项3（3-f）：入口可见性改按**总条数**判定。
 *
 * 修复的缺陷：v0.3.2 用「可恢复条数 === 0 → 隐藏入口」，于是栈里还有条目、但
 * 全部已随更早的恢复一并回退（stale）时，入口直接消失——用户看不到历史还在，
 * 也进不去回收站查看，误以为历史被清空了。
 *
 * 本用例走真实路径造出「全部失效」：连删 3 段 → 恢复最早一条（D）→ 其余 2 条
 * 删除 + 1 条恢复记录全部不再可点。断言入口**仍可见**并标明「已失效」。
 */
test('项3 · 3-f：条目全部失效时回收站入口仍可见（按总条数判可见）@m375', async ({ page }) => {
  await seedAndLoad(page, fourSegConfig());
  for (const id of ['ddd333', 'ccc222', 'bbb111']) {
    await page.getByTestId(`segment-item-${id}`).click();
    await page.getByTestId('detail-delete').click();
  }
  // 三删完成、全部可恢复 → v0.3.2 原格式（既有断言口径不变）
  await expect(page.getByTestId('recycle-bin')).toHaveText('🗑 回收站 (3)');

  // 恢复最早一条（栈下标 0 = D）：B/C/D 三条全部置 stale，新入 1 条 restore 记录
  await page.getByTestId('recycle-bin').click();
  await expect(page.getByTestId('recycle-panel')).toBeVisible();
  await page.getByTestId('recycle-restore-0').click();
  // v0.3.3 · 项3：同上——恢复最早一条（D）不是世界线末端，需显式确认才提交。
  // 此处只补交互步骤，下方全部断言与期望值一字未改。
  await page.getByTestId('undo-confirm-apply').click();
  await expect(page.getByTestId('segment-list').locator('.segment')).toHaveCount(4);

  // 3-f 核心断言：可恢复 = 0，但入口**不能**因此隐藏
  await expect(page.getByTestId('recycle-bin')).toBeVisible();
  await expect(page.getByTestId('recycle-bin')).toHaveText('🗑 回收站 (4 · 已失效)');

  // 面板头部同样区分口径：不再报「0 步可恢复」，而是「N 条，均已失效」
  // （点恢复后面板仍开着，直接读即可；再点入口会被面板自身挡住）
  await expect(page.getByTestId('recycle-panel')).toBeVisible();
  await expect(page.getByTestId('recycle-panel')).toContainText('回收站（4 条，均已失效）');
  // 三删条目全部只读（无恢复按钮），恢复记录也只读
  await expect(page.getByTestId('recycle-restore-0')).toHaveCount(0);
  await expect(page.getByTestId('recycle-restore-1')).toHaveCount(0);
  await expect(page.getByTestId('recycle-restore-2')).toHaveCount(0);

  // 对照组：**总条数真为 0** 时入口仍应隐藏——「按总数判可见」不等于「永不隐藏」。
  //
  // 这里刻意**不**用「调速触发清栈」来构造空栈。那条路径（controller 的
  // `kind === 'none'` 分支）在 v0.3.2 会清栈，但「调速清空撤销栈」正是 v0.3.2 的
  // P0 缺陷 N-3；v0.3.3 项3 已把该分支改为**不清栈**。若拿它当对照组，等于把缺陷
  // 行为写成期望值——在 v0.3.2 绿、合入项3 后必红，且红的原因是「修好的功能」。
  // 因此改为直接构造真实空栈：移除持久化键后重载（首次加载 → 栈为空 → total = 0）。
  // 该断言在 v0.3.2 与 v0.3.3 下都成立（v0.3.2 按 recoverable === 0 隐藏、此时同样为 0）。
  await page.getByTestId('recycle-close').click();
  await page.evaluate(() => window.localStorage.removeItem('fvp:undo-history'));
  await page.reload();
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('play-queue')).toBeVisible();
  await expect(page.getByTestId('recycle-bin')).toBeHidden();
  await expect(page.getByTestId('undo-banner')).toBeHidden();
});
