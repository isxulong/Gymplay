# ADR-001 · 语言与框架：TypeScript strict + 无框架原生 DOM（终版）

- 状态：已定稿（M0，2026-11-02）
- 依据：《综合方案修订定稿 v2》§2.1；《工程蓝图》§2.1；M-1 探针结论

## 决策

- **TypeScript strict**：配置 Schema 有版本演进需求、调度引擎有大量数值边界，类型系统是防回归的第一道闸。淘汰纯 JS。
- **无框架，原生 DOM + 函数式视图组件**：UI 只有编辑器 / 驾驶舱两种模式，状态规模小（一个配置对象 + 播放状态机），虚拟 DOM 是负资产。淘汰 React / Vue；淘汰 Web Components 全量方案（仅借鉴生命周期命名）。
- **记录备选：Svelte**：唯一被认真考虑的框架候选。若 M1 编辑器开发中 UI 复杂度失控（状态联动超过约 10 处），按 ADR 流程重估切换，core 层不受影响（分层依赖只许向下）。

## M-1 探针结论（2026-11-02 iPhone 真机，全部成立，入档为实现约束）

| 探针 | 结论 | 落入实现 |
| --- | --- | --- |
| P1 rVFC 变速联动 | 通过（动态阈值实测达标） | 原生 `<video>` + rVFC 路线成立（L1） |
| P2 seek/换源冻结 | 通过（20 连无冻结、正常续播） | 分段跳段技术前提成立（L1/L2） |
| P3 循环精度 | rVFC 主线 P95=0.024s、setInterval(50ms) 对照 P95=0.037s，均 ≤0.300s | **调度主线 = rVFC，50ms 轮询兜底**；两种模式都在调度器实现、运行时可降级（L1 clock / L2 scheduler） |
| P7-A 无手势 play() | 被拒（预期） | 所有交互以用户点击起手（L0 gesture） |
| P7-B 切后台音频中断 | 复现 | **回前台 currentTime 校准续播**进 persistence/播放恢复设计（`scheduler.resync()` + `fvp:playback` 快照） |
| P8 playsinline | 生效 | 页内播放成立，`playsInline` 防御性写入 NativeEngine |
| P9 HEVC | 可直读（hev1 / hvc1 双样本出画面出声） | M1 的 HEVC 不需转码引导，仅做提示；R9 fallback 文案保留给不支持平台 |
| P10 URL 容量 | 80 段密钥 1911 字符 > 1500 判定线 | URL 密钥适用 ≤50 段（1359 字符）；>50 段走 .json 导出/导入降级（M3 接线）；pako 锁定 1.0.11（探针实测版本） |
| P11 Wake Lock | 有效（实测 5 分钟不锁屏） | wake-lock handler 按「可用」路径实现，保留 API 缺失/被拒的静默降级（L0） |

## P4 听感结论（产品口径）

保调开启时 0.5x=3 分、2x=3 分（能听清口令及格线）、3x/4x=1 分 → **0.5~2x 为听感跟练区、3x~4x 为跳过区**（M1 编辑器速度档位 UI 需标注）；**preservesPitch 默认开启**（NativeEngine.setRate 内固化）。
