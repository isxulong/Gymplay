# ADR-007 · import type 类型级引用豁免（终版）

- 状态：已定稿（M1，2026-11-02，P2-2 收口）
- 依据：M0 独立质检 P2-2；TypeScript 类型擦除语义；《工程蓝图》六层结构「依赖只许向下」

## 背景

分层纪律要求依赖只许向下（L5→L4→L3→L2→L1→L0）。M0 存在两处**类型级**反向引用：

1. `platform/sources.ts`（L0）`import type { VideoSource }` ← `core/player/engine.ts`（L1）；
2. `core/scheduler/plan.ts`（L2）`import type { PlayerConfig }` ← `core/config/schema.ts`（L3）。

## 决策

**显式豁免 `import type` 类型级引用**，不迁移类型归属。约束条件：

- 仅限 `import type` / `import { type X }` 形式；编译产物中零引用（tsc 类型擦除可证），
  不构成运行时依赖、不产生模块加载环；
- 值的反向引用（函数、常量、类）不在豁免范围内，发现即违规；
- CI 由 ESLint `@typescript-eslint/consistent-type-imports` 类规则或 code review 把关
  （当前以 review 人工把关，规则接入留作 M3 打磨项）。

## 不选「契约类型下沉」的理由

- `PlayerConfig` 的所有权天然属于 L3 schema（校验、迁移、编解码全部围绕它）；
  下沉到 L2 以下会让 schema 反向依赖下层，破坏更核心的数据流方向；
- `VideoSource` 是引擎的输入契约，由 L1 定义、L0 适配是「上层契约、下层实现」的正常方向；
- 类型擦除后两者在产物中完全不存在，分层纪律要防的是运行时耦合，类型级引用不构成该风险。
