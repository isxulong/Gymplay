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

## 纪律

新增任何依赖（运行时或开发期）都需先过一道「为什么不手写」的审查，并更新本 ADR。
