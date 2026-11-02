# CHANGELOG

版本口径：App 版本 SemVer（feat 升 minor、fix 升 patch、协议破坏性变更升 major）；
配置协议版本（Schema v）独立演进，两边分开记录（蓝图版本演进五条 · 第 5 条）。

## [0.0.0-m0] - 2026-11-02

M0 地基期：

- 仓库 + CI 骨架（ESLint → tsc → Vitest → 构建 → 体积门禁 → PWA 门禁；E2E job 骨架待 M1 spec）；
- L0~L3 接口与实现（platform 五模块 / player / scheduler / config 含 persistence）；
- FakeEngine / FakeClock 测试设施；
- ADR-001~006 终版（探针结论已入 ADR）；
- Schema v1 正式冻结（ADR-004）。
