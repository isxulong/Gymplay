# ADR-003 · 依赖白名单（终版）

- 状态：已定稿（M0，2026-11-02）
- 依据：《工程蓝图》§2.6；《综合方案修订定稿 v2》§2.1、§2.4；P10 探针结论

## 运行时依赖（仅 1 个）

| 依赖 | 锁定版本 | 理由与边界 |
| --- | --- | --- |
| pako | **1.0.11（锁死，P10 探针实测版本）** | 配置密钥 deflate 压缩，自实现 DEFLATE 是荒谬的。P10 实测密钥长度对 pako 版本敏感（压缩产物字节流随版本变化），白名单按精确版本锁定。 |

平台 API 依赖（无包）：Screen Wake Lock、localStorage、Media Session，均由 L0 封装探测、缺失即静默降级。

## 移出项

- **hls.js 移出白名单**（定稿 §0.4：MVP 无 HLS、无直链；需求稿「不做清单」第 6 条已冻结配套话术）。原「动态 import 按需加载」设计技巧存档备用，见 ADR-006。

## 开发期依赖（不进产物）

Vite、TypeScript、Vitest（含 @vitest/coverage-v8）、Playwright、ESLint（含 typescript-eslint）。

> 补记（M1，P2-1 收口）：开发期依赖含已列主依赖的配套类型 / 配置包——@eslint/js（ESLint 推荐配置包）、@types/pako（pako 类型声明）。它们是白名单主依赖的构建期配套物，不进产物、不扩大运行时面。

## 纪律

新增任何依赖（运行时或开发期）都需先过一道「为什么不手写」的审查，并更新本 ADR。

## 补记 · 路径工具不引入 @types/node（v0.3.4）

`tests/e2e/e2e-paths.ts` 提供 `e2ePath()` / `toFsPath()` 两个纯函数，取代 **14 个** spec（共 17 个）里的
`new URL(..., import.meta.url).pathname`（该写法在 Windows 上产出 `/E:/…`，被 node:path
拼成 `E:\E:\…`，实测使 60/73 个 E2E 用例 ENOENT 失败）。

**判定：不引入 `@types/node`，改为手写 29 行纯函数。**

- 本 ADR 的纪律对象是 **npm 包**（运行时依赖 / 开发期依赖）。本补记**未改动任何
  devDependencies**——仍是 pako + 8 个开发期包，`package-lock.json` 的依赖树不变。
- 该句式本身即偏向「手写」：要装 `@types/node` 才能用 `node:url.fileURLToPath`，而
  `fileURLToPath` 对 file: URL 只做「percent-decode + 剥 Windows 盘符前导斜杠」两件事。
- **归到「执行纪律」而非「新增依赖」**：ADR-003 已有的同类先例是 `@types/pako`——被认定为
  「白名单主依赖的构建期配套物」。按同一口径，为 `fileURLToPath` 装 `@types/node` 才是需要
  修订本 ADR 的方向，因为它把 Node 全局类型引入一个 `lib` 只有 `ES2022 + DOM` 的前端工程。
- **代价与补偿**：手写意味着自行承担正确性。故 `tests/e2e/e2e-paths.ts` 配
  `tests/unit/app/e2e-paths.test.ts`（13 例，锁四个分支：Windows 盘符 / POSIX 绝对 /
  UNC / 非法 percent 序列不抛）。该模块**不在** `coverage.include` 内（只含 `src/core/**`），
  所以只能靠用例守，不得靠阈值守。
- **若日后要改回官方实现**：前置条件是本 ADR 修订 + `tsconfig.types` 扩容，且必须重跑
  `npm run gate:paths`（该闸禁止 `.pathname` 写法复现）。
