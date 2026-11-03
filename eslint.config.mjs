import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'coverage/', 'node_modules/', 'public/sw.js', 'playwright-report/', 'test-results/', 'smoke-tmp/'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // 门禁/冒烟脚本是 Node ESM，放开 Node/浏览器全局
    // （smoke-sw-update.mjs 的 page.evaluate 回调在浏览器上下文执行，用到浏览器全局）
    files: ['scripts/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        navigator: 'readonly',
        caches: 'readonly',
        document: 'readonly',
      },
    },
  },
);
