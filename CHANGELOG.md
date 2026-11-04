# CHANGELOG

版本口径：App 版本 SemVer（feat 升 minor、fix 升 patch、协议破坏性变更升 major）；
配置协议版本（Schema v）独立演进，两边分开记录（蓝图版本演进五条 · 第 5 条）。

## [0.3.1] - 2026-11-04

v0.3.1 补强小补丁（App 版本 0.3.0 → 0.3.1；配置协议版本 Schema v1 不变；密钥编解码语义不动）：

### 时间轴交互补强（复核一 P2-1 / P2-2）

- 播放头可抓握手柄（v1.1 §3.1）：播放头顶部新增水滴形抓手 + 44×44px 隐形命中热区，按住播放头拖动以当前播放位置为锚点继续微调（不跳到按压点重锚定），与既有「轨道任意位置按下」共存；手柄上轻点 = 无操作（吞合成 click）；
- 段落边界吸附（v1.1 §3.2）：拖动落点距段边界 ±8px（1x 档）内吸附对齐，吸附窗口随精调档缩小（1/4 → ±4px、1/8 → ±2px，4px 为插值建议值），吸附瞬间与换档沿用 `navigator.vibrate(1)` 触感；
- 轻点时长口径落地（复核一 P3-3a）：`TAP_MAX_MS=300` 由死代码转为生效判定——按下→抬起 ≥300ms 且未过位移线判为非轻点，不触发选中 / seek。

### 编辑器细节修复（复核一 P3-1 / P3-3b）

- 音量拖到 0 时静音图标呈现 🔇 静音态（`muted || volume === 0` 任一成立即静音态），不再只跟随 muted 标志；
- 起止时间提交：单字段非法时只恢复该字段原值，另一字段的未提交有效编辑保留（setBounds 拒绝的组合非法路径仍整组恢复）。

### 密钥兼容证据（复核一 P2-3）

- 新增 `scripts/key-compat.mjs`：esbuild 双树打包 codec → 同一进程内对 4 组固定样例（minimal-1seg / typical-3seg-loop-queue / rich-hour-scale / boundary-50seg）双跑 `encodeConfig` 字节比对 + 交叉解码还原校验；对 GitHub main 74de1b2 基线实测 PASS（密钥长度 200/398/319/1115 全部逐字节一致）；
- `tests/e2e/v031.spec.ts` L6 注释同步更正为指向该双跑对照脚本。

### 版本与构建

- package.json 版本 bump 至 0.3.1（复核二 P2-1）；SW BUILD_ID 注入链路（`scripts/build-sw.mjs` 读 package.json 版本）实测产物含 `v0.3.1`，不受影响；
- 验证：214 单测全过（209 基线 + 5 新增吸附用例）、tsc / eslint 0 错、构建与体积 / PWA 门禁通过、SW 批次冒烟 a/b/c 全过、E2E 28 过（cockpit-path3 为沙箱已知环境失败，基线同挂）。

## [0.3.0] - 2026-11-03

M3 收口（App 版本 0.2.0 → 0.3.0；配置协议版本 Schema v1 不变）：

### 分享降级导出（M3-2）

- 编辑器新增「📤 导出配置」（下载 .json）与「📥 导入配置」（选文件，密钥框亦可直接粘贴 JSON 文本）入口，冷启动空态同样提供导入入口；
- 分享密钥超 1500 字符上限（`URL_KEY_CHAR_LIMIT`）时不再生成会被截断的长链，改为「share-too-long」引导面板（含一键导出按钮），文案说明截断风险并建议改用 .json 文件；本地配置仍自动保存；
- 导入纪律沿用既有 F7 AC3 / F8 AC4：本地已有配置时走草稿挂起、显式应用后落盘；解析失败给可诊断文案、不产生半配置状态；与当前内容一致时提示无需导入；
- 新增单测 `tests/unit/core/config/file-transfer.test.ts`（7 例）与 E2E `tests/e2e/export-import.spec.ts`（4 例）；注释口径修正为实测密钥 1711 字符（pako 锁定 1.0.11）。

### P10 管线统一与数值重跑（M3-1b）

- `probe/p10-url-length.html` 编码管线改为与产线 `src/core/config/codec.ts` 完全一致（canonicalize → pako deflate level 9 → 分块 base64url），六档密钥与产线管线输出逐字节一致；
- ADR-001 回填产线管线实测值：10 段 518 / 25 段 796 / 50 段 1271 / 80 段 1852 / 100 段 2235 / 150 段 3199 字符；旧 1359/1911 为旧探针管线数值，已作废（ADR-004、codec.ts 头注与 codec 单测标题同步对齐）；
- 新增 `tests/unit/core/config/p10-url-length.test.ts`（数值表 + 单调性 + 1271/1852 回归锁）。

### SW 缓存策略与「刷新即更新」（M3-3）

- SW 缓存策略收口（ADR-010）：app shell 全量预缓存（构建时生成清单）消除发版窗口离线白屏（终审 P1①）；版本化缓存共存 + 懒删（保留最新两代）；
- CACHE_VERSION 换名自动化（终审 P1③）：`npm run build` 链内 `scripts/build-sw.mjs` 从 package.json 版本 + 构建时间戳注入 BUILD_ID，release 链路无需人工改 sw.js；
- 「刷新即更新」提示接线（终审 P1②）：SW 升级 activate 后 postMessage 通知页面，`src/ui/sw-update.ts` 弹提示条（刷新 / 稍后），页面回前台即查 + 每 5 分钟轮询 reg.update()；
- 缺陷修复：SW message 监听器前移至 `setupSwUpdatePrompt()` 同步段（早于 `load` 事件与 `register()` 调用），消除 postMessage 早到导致提示条丢失的竞态；差分验证：基线产物 TOAST_LOST → 修复后产物 TOAST_SHOWN；
- 0.2.0「M3 必办登记」之 CACHE_VERSION 自动化事项随本批次闭合。

### 文档债批次（M3-1）

- README 阶段口径对齐 M2/v0.2.0；ADR-004 补段间重叠校验变更记录；ADR-001 补 P6 结论与设备矩阵；新增 ADR-008（native-engine.ts 覆盖率排除口径）、ADR-009（HEVC 直读口径演进变更登记）；新增 `docs/probe-archive-gap.md` 探针存档偏差登记（「结论在、记录缺」）。

## [0.2.0] - 2026-11-03

M2 驾驶舱期（Schema v1 不变）：

- 练时驾驶舱（F6 全量）：首屏只呈现当前段名 + 超大倒计时（含倍速折算，F6 AC4）+ 三大按钮（上一段 / 暂停继续 / 下一段），无编辑入口（AC1）；误触隔离（AC2：非按钮区触点吞掉、退出行两步确认、编辑 DOM 整树隐藏）；
- 线控映射（F6 AC3）：Media Session play / pause / nexttrack / previoustrack 随驾驶舱进入绑定、退出解绑；平台不支持时一次性降级提示（R13），跳段用大按钮；
- Wake Lock 练时常亮（F6 AC5，P11 结论落地）：播放期间持有、暂停/停止/退出释放、回前台自动重取；API 缺失/被拒 → 顶部一次性文案 D 提示，不阻塞训练；
- 循环接入：loop.mode 三态在驾驶舱下滑手势区可用，`setLoopLive` 热切换不打断当前段播放（L2 调度器新增 `setLoop`，配置落盘 + 调度器就地更新）；
- 队列进度：下滑手势区面板（不进首屏，F6 AC1 不变），含当前项高亮、第 i/N 项与循环圈数、队列清单；
- L2 调度器新增 `next()` / `prev()`（跳段）与单段循环圈数计数（loopsDone 在 segment 模式下记重播次数）；
- 修复 M1 遗留 P2-1：`schema.validate` 补段间重叠校验（F3 AC3 跨段约束），端点相接合法、区间相交拒绝（BAD_SEGMENTS）；edit.ts 头注「输出恒满足 schema.validate 约束」恢复为真；
- E2E 新增：路径 3（驾驶舱全流程）、单段循环 100 圈无泄漏实测（页面内回卷计数 + 精确堆读数，10→100 圈堆增长 0.046MB）；
- `sw.js` CACHE_VERSION 同步换名 v0.2.0（发版人工换名，M3 收口自动化，见 P2-3 登记）；
- 文档债批次补记（2026-11-03，终审报告步骤 1）：README 阶段口径对齐 M2/v0.2.0；ADR-004 补段间重叠校验变更记录；ADR-001 补 P6 结论与设备矩阵；新增 ADR-008（native-engine.ts 覆盖率排除口径）、ADR-009（HEVC 口径演进变更登记）；新增 `docs/probe-archive-gap.md` 探针存档偏差登记（「结论在、记录缺」）。

### M3 必办登记（不变）

- `public/sw.js` 的 `CACHE_VERSION` 换名自动化接进 release 链路（本次仍为人工同步）。

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
