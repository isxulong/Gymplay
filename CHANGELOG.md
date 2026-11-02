# CHANGELOG

版本口径：App 版本 SemVer（feat 升 minor、fix 升 patch、协议破坏性变更升 major）；
配置协议版本（Schema v）独立演进，两边分开记录（蓝图版本演进五条 · 第 5 条）。

## [0.1.0] - 2026-11-02

M1 编辑器期（Schema v1 不变）：

- 编辑器全部交付物：本地文件装载（HEVC 直读提示，P9 结论）、时间刻度条打点、段落条（重命名/起止/删除）、速度档位（0.5~2x 听感跟练区；3x/4x 标注「跳过区·听感失真」，P4 结论）、队列视图（勾选/拖拽/重复段/循环设置）、密钥生成与导入（URL hash）、自动保存与恢复（F7 AC1）、hash 草稿态冲突 UI（F7 AC3）；
- L3 新增 `core/config/edit.ts` 编辑纯函数内核（打点切分/边界编辑钳制/队列操作/F8 AC5 时长钳制）；
- L4 新增 `app/controller.ts` 装配引擎、调度器与持久化（含 P7-B 播放快照与回前台 resync）；
- E2E 落地（Playwright 真实浏览器层）：路径 1/2、F7 AC1/AC2/AC3、F8 AC4、NativeEngine 契约测试（定稿 §2.5 迁移项）；fixtures 由 `gen-fixtures.sh` 程序化生成入仓（VP8/Opus WebM 10s）；
- M0 遗留收口：P2-1 ADR-003 补记配套开发依赖；P2-2 类型级反向 import 经 ADR-007 显式豁免。

### M3 必办登记（P2-3）

- `public/sw.js` 的 `CACHE_VERSION` 换名须接进 release 链路（发版自动换名清旧缓存），M3 收口时实现；当前发版需人工同步修改。

## [0.0.0-m0] - 2026-11-02

M0 地基期：

- 仓库 + CI 骨架（ESLint → tsc → Vitest → 构建 → 体积门禁 → PWA 门禁；E2E job 骨架待 M1 spec）；
- L0~L3 接口与实现（platform 五模块 / player / scheduler / config 含 persistence）；
- FakeEngine / FakeClock 测试设施；
- ADR-001~006 终版（探针结论已入 ADR）；
- Schema v1 正式冻结（ADR-004）。
