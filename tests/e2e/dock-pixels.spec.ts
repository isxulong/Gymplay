/**
 * v0.3.3 · 项1 / 项2 像素判据实跑（1-a / 1-b / 1-c / 1-d / 1-e / 2-f / 2-g）
 *
 * 为什么不另写裸脚本：本沙箱不允许 nohup / & 常驻后台进程，裸脚本无法稳定拉起
 * dev server。改用 Playwright 的 webServer 生命周期（配置在 playwright.config.ts），
 * 由它启动被测树、跑完即关——得到的是**真实样式加载顺序 + 真实装配 DOM + 真实命中测试**。
 *
 * 测量顺序（关键前提，不可调换）：
 *   贴底槽在**空态**时高度为 0（无横幅可渲染），此时 `top === 视口高`、命中的是
 *   `#app` 本身——这不代表缺陷，只是没有被测对象。方案 §2.1 的 1-c 基准
 *   564.6 / 564.6 / 548.9 对应的是「贴底槽高约 102.4px」的真实形态。因此必须
 *   先用真实交互造出撤销条（打开段详情 → 点「删除此段」），**之后**才量几何。
 *   首跑（空态）读数 667 / 667 / 667、hitsSelf 全 false，已作废并记录在验证记录中。
 *
 * 判据口径（方案 §2.1 / §2.2，v0.3.3 修订：贴底槽 sticky → fixed）：
 *   1-a 非满滚：贴底槽 top ≈ 视口高 − 槽高，容差 ±8px
 *   1-b 满滚：偏差 ≤8px（sticky 时代的 15.6px 假偏差随 fixed 归零，容差由 ±16 收到 ±8）
 *   1-c 三个滚动位置（0 / 900 / 1600，满滚时取 maxScroll）均落在视口内且命中自身
 *   1-d 面板滚到底：「删除此段」中心点命中按钮本身
 *   1-e 通知条（.fvp-sw-toast）与贴底槽纵向重叠 = 0（= 2-f）
 *   1-e-2 面板打开时通知条与面板纵向重叠 = 0（v0.3.3 修订：只避让槽不够，须 max(槽, 面板)）
 *   2-g 编辑态通知层级严格 >45 且 <60
 */

import { test, expect } from '@playwright/test';

/** 3 段配置：让 editorMain 展开（cfg !== null） */
function buildConfig() {
  const segments = Array.from({ length: 3 }, (_, i) => ({
    id: i.toString(36).padStart(6, '0'),
    start: i * 3,
    end: i * 3 + 3,
    rate: [1, 1.5, 2][i],
    label: `段${i + 1}`,
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

/** 方案 1-b/1-c 口径：视口 667、最大滚动约 1192（= 文档高 1859 − 667） */
const TARGET_SCROLL_HEIGHT = 1859;

test('v0.3.3 · 项1：贴底槽像素判据 1-a / 1-b / 1-c / 1-d / 1-e / 2-f / 2-g @m375', async ({ page }) => {
  // 判据 1-a/1-b/1-c 的基准（564.6 / 548.9）与 1-d 的「面板内容溢出、需滚到底」
  // 都基于 375×667 窄屏。mobile-375 project 已由此档位启动，但 desktop project
  // 也会按 testMatch 跑到本用例（grep 只过滤 mobile 档，不过滤 desktop），
  // 因此这里显式设视口——否则桌面 1280×720 下面板内容不溢出、1-d 无从成立。
  // （既有 @m375 用例同样各自 setViewportSize，属同一惯例。）
  await page.setViewportSize({ width: 375, height: 667 });
  await page.addInitScript((payload) => {
    window.localStorage.setItem('fvp:config', payload);
  }, JSON.stringify(buildConfig()));
  await page.goto('/');
  await expect(page.getByTestId('editor')).toBeVisible();

  // ---------- 1-d：打开段详情 → 滚到底 → 命中断言 → 真实点击删除（造撤销条） ----------
  await page.locator('[data-testid^="segment-item-"]').first().click();
  await expect(page.getByTestId('detail-sheet')).toBeVisible();
  await expect(page.getByTestId('detail-delete')).toBeVisible();

  const hit = await page.evaluate(() => {
    const sheet = document.querySelector('.detail-sheet') as HTMLElement;
    const btn = document.querySelector('[data-testid="detail-delete"]') as HTMLElement;
    sheet.scrollTop = sheet.scrollHeight;
    const br = btn.getBoundingClientRect();
    const cx = Math.round(br.left + br.width / 2);
    const cy = Math.round(br.top + br.height / 2);
    const el = document.elementFromPoint(cx, cy);
    const dock = document.querySelector('.fvp-banner-stack') as HTMLElement;
    return {
      btnTop: +br.top.toFixed(1),
      btnBottom: +br.bottom.toFixed(1),
      sheetScrollTop: Math.round(sheet.scrollTop),
      sheetScrollHeight: Math.round(sheet.scrollHeight),
      sheetPaddingBottom: getComputedStyle(sheet).paddingBottom,
      center: { x: cx, y: cy },
      hitTag: el ? `${el.tagName}.${String(el.className).split(' ')[0]}` : null,
      hitIsButton: el === btn || (!!el && btn.contains(el)),
      hitInsideDock: !!dock && !!el && dock.contains(el),
      dock: { top: +dock.getBoundingClientRect().top.toFixed(1), bottom: +dock.getBoundingClientRect().bottom.toFixed(1), height: +dock.getBoundingClientRect().height.toFixed(1) },
    };
  });
  console.log(
    `1-d 按钮矩形 top=${hit.btnTop} / bottom=${hit.btnBottom}；中心(${hit.center.x},${hit.center.y}) 命中=${hit.hitTag} 命中按钮=${hit.hitIsButton} 落在贴底槽=${hit.hitInsideDock}；面板 padding-bottom=${hit.sheetPaddingBottom}（scrollTop=${hit.sheetScrollTop}/${hit.sheetScrollHeight}）；空态贴底槽 ${hit.dock.top}–${hit.dock.bottom}（高 ${hit.dock.height}）`,
  );
  expect(hit.hitIsButton).toBe(true);

  // 真实点击（Playwright 自身做可点击性 + 命中目标校验）：若按钮被贴底槽压住，
  // 这一步会以「element intercepts pointer events」失败——即 1-d 红。
  await page.getByTestId('detail-delete').click();
  await expect(page.getByTestId('undo-banner')).toBeVisible();
  await expect(page.getByTestId('detail-sheet')).toBeHidden();

  // ---------- 补齐滚动高度到方案口径（文档高 1859 → 最大滚动 1192） ----------
  const pad = await page.evaluate((target) => {
    const main = document.querySelector('main.fvp-editor') as HTMLElement | null;
    const before = document.documentElement.scrollHeight;
    let fillerEl: HTMLElement | null = null;
    // 两次收敛：追加后布局高度可能因贴底槽吸底而多吸收一段，需按实测回差补差
    for (let i = 0; i < 2; i += 1) {
      const deficit = target - document.documentElement.scrollHeight;
      if (!main || Math.abs(deficit) <= 1) break;
      if (!fillerEl) {
        fillerEl = document.createElement('div');
        main.appendChild(fillerEl);
      }
      const cur = Number.parseFloat(fillerEl.style.height || '0');
      fillerEl.style.height = `${Math.max(0, cur + deficit)}px`;
    }
    return { before, after: document.documentElement.scrollHeight };
  }, TARGET_SCROLL_HEIGHT);
  console.log(`滚动高度补齐：原 ${pad.before} → ${pad.after}（目标 ${TARGET_SCROLL_HEIGHT}）`);

  // ---------- 1-a / 1-b / 1-c ----------
  const geo = await page.evaluate(() => {
    const dock = document.querySelector('.fvp-banner-stack') as HTMLElement;
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    const out: Array<Record<string, unknown>> = [];
    for (const want of [0, 900, 1600]) {
      const target = Math.min(want, maxScroll);
      window.scrollTo(0, target);
      const r = dock.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      const el = document.elementFromPoint(cx, cy);
      out.push({
        want,
        scrollY: Math.round(window.scrollY),
        top: +r.top.toFixed(1),
        bottom: +r.bottom.toFixed(1),
        height: +r.height.toFixed(1),
        inViewport: r.top >= 0 && r.bottom <= window.innerHeight + 0.5,
        hitsSelf: !!el && dock.contains(el),
        hitTag: el ? `${el.tagName}.${String(el.className).split(' ')[0]}` : null,
      });
    }
    return { vh: window.innerHeight, maxScroll, measurements: out };
  });

  type M = { scrollY: number; top: number; height: number; inViewport: boolean; hitsSelf: boolean; hitTag: string | null };
  const [at0, at900, atFull] = geo.measurements as unknown as M[];

  for (const [label, m] of [['scrollY=0', at0], ['scrollY=900', at900]] as const) {
    const expectTop = +(geo.vh - m.height).toFixed(1);
    const delta = +(m.top - expectTop).toFixed(1);
    console.log(`1-a ${label}: top=${m.top} 槽高=${m.height} 期望=${expectTop} 偏差=${delta}px（容差±8）`);
    expect(Math.abs(delta)).toBeLessThanOrEqual(8);
  }

  // 1-b 偏差口径（v0.3.3 修订）：贴底槽改 fixed 后不再受 #app { padding:16px }
  // 约束，满滚时顶部严格等于「视口高 − 槽高」，sticky 时代的 15.6px 假偏差归零，
  // 容差因此从 ±16 收紧到 ±8（与 1-a 同一口径）。
  const fullExpectTop = +(geo.vh - atFull.height).toFixed(1);
  const fullDelta = +(fullExpectTop - atFull.top).toFixed(1);
  console.log(`1-b 满滚: scrollY=${atFull.scrollY}（maxScroll=${geo.maxScroll}） top=${atFull.top} 期望=${fullExpectTop} 槽高=${atFull.height} 偏差=${fullDelta}px（容差≤8，fixed 后假偏差已归零）`);
  expect(Math.abs(fullDelta)).toBeLessThanOrEqual(8);

  const tops = [at0.top, at900.top, atFull.top];
  console.log(`1-c tops=${tops.join(' / ')}（方案基准 564.6 / 564.6 / 548.9） 命中自身=${at0.hitsSelf}/${at900.hitsSelf}/${atFull.hitsSelf}（命中元素 ${at0.hitTag} / ${at900.hitTag} / ${atFull.hitTag}）`);
  for (const m of [at0, at900, atFull]) {
    expect(m.inViewport).toBe(true);
    expect(m.hitsSelf).toBe(true);
  }
  for (let i = 1; i < tops.length; i += 1) expect(tops[i]).toBeLessThanOrEqual(tops[i - 1] + 0.5);

  // ---------- 1-e / 2-f：通知条与贴底槽纵向重叠 = 0 ----------
  const overlap = await page.evaluate(() => {
    let toast = document.querySelector('.fvp-sw-toast') as HTMLElement | null;
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'fvp-sw-toast';
      const span = document.createElement('span');
      span.className = 'fvp-sw-toast__text';
      span.textContent = '新版本已就绪，刷新即更新';
      toast.appendChild(span);
      // 真实路径：ui/sw-update.ts 把它直接 append 到 body（在 #app 之外），
      // 因此 --fvp-dock-height 必须写在 documentElement 上才能继承到它。
      document.body.appendChild(toast);
    }
    const dock = document.querySelector('.fvp-banner-stack') as HTMLElement;
    const d = dock.getBoundingClientRect();
    const t = toast.getBoundingClientRect();
    const vOverlap = Math.max(0, Math.min(d.bottom, t.bottom) - Math.max(d.top, t.top));
    const hOverlap = Math.max(0, Math.min(d.right, t.right) - Math.max(d.left, t.left));
    return {
      dock: { top: +d.top.toFixed(1), bottom: +d.bottom.toFixed(1) },
      toast: { top: +t.top.toFixed(1), bottom: +t.bottom.toFixed(1), height: +t.height.toFixed(1) },
      vOverlap: +vOverlap.toFixed(1),
      hOverlap: +hOverlap.toFixed(1),
      dockHeightVar: getComputedStyle(document.documentElement).getPropertyValue('--fvp-dock-height').trim(),
      toastBottom: getComputedStyle(toast).bottom,
    };
  });
  console.log(
    `1-e 贴底槽 ${overlap.dock.top}–${overlap.dock.bottom}；通知条 ${overlap.toast.top}–${overlap.toast.bottom}（高 ${overlap.toast.height}）；纵向重叠=${overlap.vOverlap}px 横向重叠=${overlap.hOverlap}px；--fvp-dock-height=${overlap.dockHeightVar || '(未设置)'}；toast bottom=${overlap.toastBottom}`,
  );
  expect(overlap.vOverlap).toBe(0);
  console.log(`2-f 同 1-e：纵向重叠=${overlap.vOverlap}px`);
  expect(overlap.vOverlap).toBe(0);

  // ---------- 1-e-2：面板打开时通知条仍不压面板（v0.3.3 修订新增） ----------
  // 把面板重新打开，再量通知条与**面板**的纵向重叠。v0.3.2 口径只避让贴底槽
  // （calc(16px + 槽高)），面板顶部会高过槽顶，通知条因此压进面板（实测重叠 54px、
  // 与「删除此段」重叠 43px，按钮中心点过去点到的是通知条）。修订后避让量取
  // max(槽高, 面板高度)，重叠必须为 0。
  // 回到顶部再点剩余段（首段已在上面被删除，剩余 000001 / 000002）
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByTestId('segment-item-000001').click();
  await expect(page.getByTestId('detail-sheet')).toBeVisible();
  const sheetOverlap = await page.evaluate(() => {
    let toast = document.querySelector('.fvp-sw-toast') as HTMLElement | null;
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'fvp-sw-toast';
      const span = document.createElement('span');
      span.className = 'fvp-sw-toast__text';
      span.textContent = '新版本已就绪，刷新即更新';
      toast.appendChild(span);
      document.body.appendChild(toast);
    }
    const sheet = document.querySelector('.detail-sheet') as HTMLElement;
    const s = sheet.getBoundingClientRect();
    const t = toast.getBoundingClientRect();
    const vOverlap = Math.max(0, Math.min(s.bottom, t.bottom) - Math.max(s.top, t.top));
    return {
      sheet: { top: +s.top.toFixed(1), bottom: +s.bottom.toFixed(1), height: +s.height.toFixed(1) },
      toast: { top: +t.top.toFixed(1), bottom: +t.bottom.toFixed(1) },
      vOverlap: +vOverlap.toFixed(1),
      sheetBand: getComputedStyle(document.documentElement).getPropertyValue('--fvp-sheet-band').trim(),
      toastBottom: getComputedStyle(toast).bottom,
    };
  });
  console.log(
    `1-e-2 面板 ${sheetOverlap.sheet.top}–${sheetOverlap.sheet.bottom}（高 ${sheetOverlap.sheet.height}）；通知条 ${sheetOverlap.toast.top}–${sheetOverlap.toast.bottom}；纵向重叠=${sheetOverlap.vOverlap}px；--fvp-sheet-band=${sheetOverlap.sheetBand || '(未设置)'}；toast bottom=${sheetOverlap.toastBottom}`,
  );
  expect(sheetOverlap.vOverlap).toBe(0);

  // ---------- 2-g：编辑态通知层 ∈ (面板 45, 回收站 60) ----------
  const z = await page.evaluate(() => {
    const s = document.querySelector('.fvp-notice-stack') as HTMLElement;
    const sheet = document.querySelector('.detail-sheet') as HTMLElement;
    const rec = document.querySelector('.recycle-root') as HTMLElement;
    return {
      stack: getComputedStyle(s).zIndex,
      sheet: getComputedStyle(sheet).zIndex,
      recycle: getComputedStyle(rec).zIndex,
    };
  });
  const zs = Number(z.stack);
  console.log(`2-g 计算层级：通知栈=${z.stack} 段详情面板=${z.sheet} 回收站=${z.recycle}（须 ${z.sheet} < ${z.stack} < ${z.recycle}）`);
  expect(zs).toBeGreaterThan(Number(z.sheet));
  expect(zs).toBeLessThan(Number(z.recycle));
});
