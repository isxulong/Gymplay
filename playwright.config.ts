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

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
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
