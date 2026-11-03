# ADR-008 · native-engine.ts 覆盖率排除口径

- 状态：已定稿（2026-11-03 补记；口径自 M0 起已在 `vite.config.ts` 生效）
- 依据：《综合方案修订定稿 v2》§2.5「测试策略修订 · L1 契约测试迁移」；终审报告文档债批次（M3 收口步骤 1）
- 登记性质：既有实现口径的事后 ADR 登记（文档债批次补录），非新决策。

## 背景

core 覆盖率 ≥90% 是 M0 门禁（定稿 §四 M0 行）与 CI 门禁之一。`src/core/player/native-engine.ts` 是 L1 内唯一直接绑定 DOM / `<video>` 元素的模块——jsdom / happy-dom 的 HTMLMediaElement 是 stub（play() 不播、seek 无 seeked 事件），Node/Vitest 环境下无法对其行为做有意义的断言。

## 决策（现状口径的登记）

**`native-engine.ts` 从 Node/Vitest 覆盖率统计中排除，其行为验证由 Playwright 真实浏览器层承担。**

- `vite.config.ts` coverage 配置：`include: ['src/core/**']`、`exclude: ['src/core/player/native-engine.ts']`，阈值 lines/functions/statements/branches 均 ≥90%；
- 对应测试资产：`tests/e2e/native-engine.spec.ts`（NativeEngine 契约测试，定稿 §2.5「契约一致性用例在 Playwright 真实浏览器层执行」）——输入序列 load → setRate → play → tick → seek → pause → 播至 ended → destroy，断言时间回流、速率钳制、preservesPitch 默认开启、ended 事件、destroy 后静默；
- Node 侧 L1 只测从引擎中抽出的纯函数（rate 钳制、时间源择优决策）。

## 边界与纪律

- 排除范围**仅限 `native-engine.ts` 一个文件**；`src/core/**` 其余文件全部计入覆盖率统计，≥90% 门禁口径不变。
- 「覆盖率排除」不等于「质量豁免」：native-engine 的行为契约由 E2E 契约测试守卫，任何人改动该文件必须跑 `npm run test:e2e`。
- 若日后 L1 再出现 DOM 绑定类文件，须先过本 ADR 的同套论证（jsdom stub 不可测 + Playwright 层已有对应契约测试）并更新本文件，不得默认顺带排除。
