/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages 以 /Gymplay/ 子路径托管，全部资源走相对路径
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // M0 门禁：core 覆盖率 ≥90%。
      // native-engine.ts 是 DOM/<video> 绑定层——按定稿 §2.5，L1 契约一致性
      // 用例在 Playwright 真实浏览器层执行（M1 起），Node 侧只测纯函数，
      // 故从此处覆盖率统计中排除。
      include: ['src/core/**'],
      exclude: ['src/core/player/native-engine.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 90,
      },
    },
  },
});
