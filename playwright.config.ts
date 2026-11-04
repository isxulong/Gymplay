/**
 * Playwright E2E 配置（定稿 §2.5：VP8/Opus WebM fixtures、不使用 channel: chrome）。
 *
 * - CI：使用 `playwright install chromium` 的 bundled Chromium；
 * - 沙箱/受限环境：设 FVP_CHROMIUM_PATH 指向系统 Chromium 可执行文件；
 * - dev server 承载被测页面（fixtures 经 dev server 静态服务，不进 dist）；
 * - 无手势 play() 在真机会被拒（P7-A），测试环境用 --autoplay-policy 放开以驱动播放路径。
 */
import { defineConfig } from '@playwright/test';

// 避免引入 @types/node（依赖白名单）：经 globalThis 读环境变量
const env = ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env) ?? {};
const chromiumPath = env.FVP_CHROMIUM_PATH;

// v0.3.2 · 项1：E2E 通知冻结说明（实现偏差，已记入验证记录上报主 AD）——
// 方案 v1.1 原定 playwright.config.ts 增加 auto-use fixture 注入通道②
// （window.__GYMPLAY_TEST_FREEZE_NOTICES__），但 Playwright 1.64.1 的
// Config/TestConfig 不支持 fixture 定义（fixture 只能经 spec 内 test.extend()），
// 按字面不可实现。依方案 D-9 通道优先级改用：
//   · 通道③ navigator.webdriver === true（Playwright 默认 true）→ 默认冻结全部
//     info 计时与挤位，保护 export-import / share-path2 / v031 既有 info 断言零改动；
//     有效性由 notifications.spec 守卫用例显式断言（webdriver===true + 冻结静止）。
//   · 通道① URL ?fvpNoticeTtl=500 → 计时行为用例（加速消失 / 挤位 / hover 暂停）显式覆盖。
// 产品代码 notice-center.ts 三通道（含通道②）照方案完整实现，通道②保留供
// 单测与手动调试注入使用。

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  // v0.3.2 · 项8（C2 裁决先决条件①）：mobile project 375×667 双跑核心用例。
  // 桌面档维持 Playwright 默认 1280×720 零配置（全量）；mobile 档仅跑标题带 @m375
  // 标记的核心用例（sheet 开合 / 详情编辑 / 回收站 / 通知堆叠 / 队列调速 / 试听徽标，
  // 10-12 条次；既有用例不补 viewport、不双跑——D-2 采纳）。mobile project 独立成档，
  // 双跑条次计入 Phase 3 门禁（实跑数字进验证记录）。
  projects: [
    { name: 'desktop' },
    { name: 'mobile-375', use: { viewport: { width: 375, height: 667 } }, grep: /@m375/ },
  ],
  use: {
    baseURL: 'http://127.0.0.1:5199',
    launchOptions: {
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
        // 单段循环 100 圈无泄漏实测（M2 门禁 2）：精确堆读数 + 暴露手动 GC
        '--enable-precise-memory-info',
        '--js-flags=--expose-gc',
      ],
      ...(chromiumPath ? { executablePath: chromiumPath } : {}),
    },
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5199 --strictPort',
    url: 'http://127.0.0.1:5199',
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
