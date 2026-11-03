# Gymplay · 健身视频分段变速播放器

在手机浏览器里对本地健身视频打点分段、分段变速保调、循环跟练，并通过分享链接交换编排配置——纯静态、无后端、本地文件一等公民。

## 当前阶段：M3 收口（v0.3.0）

**在线使用（GitHub Pages）：https://isxulong.github.io/Gymplay/**

### 编辑器功能使用说明

1. **导入视频**：打开页面点「选择本地视频」，从本机选取健身视频（MP4/WebM 等浏览器可解码格式；iPhone 拍的 HEVC 视频在支持的浏览器上直接装载，无需转码）。视频只在你设备本地读取，不上传任何服务器。
2. **打点分段**：播放中在要切开的位置点「✚ 打点」，视频即被切成独立段落；点时间刻度条空白处可跳转预览，点段落色块跳到该段起点播放。
3. **段落编辑**：点选段落条上的段，可重命名（≤30 字）、修改起止秒数、删除（删除不影响其他段的边界）；速度档位 0.5x~2x 为「听感跟练区」（变速保调默认开启，人声不变尖），3x/4x 标注为「跳过区·听感失真」，适合快速略过不练的片段。
4. **播放队列**：段落默认全部进队列；取消勾选只移出队列、配置保留（重新勾选恢复原位）；拖拽或 ▲▼ 调整顺序；「重复」让同一段练多遍；循环支持不循环 / 整列循环（可设次数，0=无限）/ 单段循环。
5. **自动保存**：所有编辑即时保存在本机浏览器，刷新或关闭重开后自动恢复（本地文件无法跨会话保留，按提示重新选择同一视频文件即可接着练）。
6. **分享编排**：点「生成分享链接」确认版权提示后生成自包含链接，复制发给练友；对方打开链接即还原全部分段/速度/勾选/顺序，导入同一视频即可开练。若你本地已有编排时打开别人的链接，对方的编排会以「草稿预览」呈现，显式点「应用」才会覆盖本地配置。配置密钥超过 1500 字符上限（段数较多时）时不再生成可能在部分渠道被截断的长链，页面改为给出引导并提供「导出配置」导出 .json 文件；练友用「导入配置」装入后选择同一视频即可开练。
7. **导入密钥**：在「分享与导入」区粘贴收到的链接或密钥即可载入。

### 练时驾驶舱使用说明（M2 · v0.2.0 新增）

1. **进入驾驶舱**：编辑器内开始播放队列即进入练时模式，首屏只呈现当前段名、超大倒计时（含倍速折算）与三大按钮（上一段 / 暂停继续 / 下一段），无编辑入口；非按钮区触点被吞掉，退出驾驶舱需两步确认。
2. **耳机线控**：Media Session 播放 / 暂停 / 下一曲 / 上一曲随驾驶舱进入绑定，退出即解绑；平台不支持时给一次性降级提示，跳段改用大按钮。
3. **练时常亮**：播放期间持有 Screen Wake Lock（暂停 / 停止 / 退出释放，回前台自动重取）；API 缺失或被拒时顶部一次性文案提示，不阻塞训练。
4. **循环**：驾驶舱下滑手势区可切换循环三态（不循环 / 整列循环 / 单段循环），热切换不打断当前段；该面板还显示队列清单、当前项与循环圈数。

### 本里程碑不做

iOS 适配收口、错误文案映射全量上线、release 管线双站部署（GitHub Pages / Cloudflare 发布动作另行安排）属后续里程碑，当前版本不含这些功能；分享降级导出（>50 段配置走 .json 文件）与 PWA 离线收口（SW 全量预缓存 + 版本共存懒删 + 刷新即更新）已随 v0.3.0 入本版。真机门禁项（60min 导入、静置不锁屏、线控双击等）尚未完成真机走查，当前版本对外表述为「候选可用版」。

### 工程入口

- 本地开发：`npm ci && npm run dev`；质量门禁：`npm run lint && npm run typecheck && npm run test:coverage && npm run build && npm run gate:size && npm run gate:pwa`；E2E：`npm run test:e2e`（fixtures 已入仓，重建用 `tests/e2e/fixtures/gen-fixtures.sh`）。
- 分层与契约：见 `docs/adr/`（ADR-001~009）与《综合方案修订定稿 v2》。
- 部署：tag `v*` 触发 release.yml 构建并发布到 gh-pages 分支。GitHub Pages 源需指向 gh-pages（一次性人工设置：Settings → Pages → Source 选 gh-pages 分支 /(root)；该设置无法由 GITHUB_TOKEN 自动变更）。

## M-1 探针期背景（历史存档，已闭合）

M-1 探针期（2026-11-02）验证了技术前提（rVFC 变速联动、seek/换源衔接、手势要求与内联播放、后台节流、循环精度、极端倍速听感、HEVC 解码、配置 URL 长度、Screen Wake Lock），结论已入 ADR-001，随后依次完成 M0 地基、M1 编辑器、M2 驾驶舱。探针判据以定稿与《开工前技术风险消解计划》为准，本仓库未放宽、未改写任何判据；探针原始记录存档缺口见 `docs/probe-archive-gap.md` 偏差登记。

- 权威依据一（探针规格与判据）：[综合方案修订定稿 v2（签发版）](https://xulongnow.feishu.cn/docx/VsWNdgo2Do6HpcxHtX6cFWopnwe)，重点看 §3.2「探针修订与新增」、§3.3「执行顺序（硬门禁）」。
- 权威依据二（探针原始设计）：[开工前技术风险消解计划](https://xulongnow.feishu.cn/docx/FyGMdnKYAoaFtrxIXaWcUPnonPg)，第二章「最小探针设计（P1~P10）」。

> P5（File System Access）、P6（蓝牙线控媒体键）已按定稿后置到 MVP 期间，本仓库不含这两项。

## 仓库结构

```
README.md / CHANGELOG.md / package.json
docs/adr/                 # ADR-001~009（决策记录）
probe/                    # M-1 探针页（历史存档）
├── day1-core.html        # Day1：P8→P7→P1→P2 合并单页（四区块，自上而下）
├── p3-loop-precision.html# P3 循环精度（rVFC 主线 + setInterval 对照）
├── p4-speed-listening.html# P4 极端倍速盲听听测（12 格矩阵）
├── p9-hevc.html          # P9 HEVC 静态探测 + 实际加载
├── p10-url-length.html   # P10 配置 URL 长度（pako 已内联，无需网络）
└── p11-wake-lock.html    # P11 Screen Wake Lock 5 分钟静置
src/                      # 工程源码（platform/player/scheduler/config/app/ui）
tests/                    # 单测（tests/unit）与 E2E（tests/e2e，Playwright）
scripts/                  # 体积门禁 check-size.mjs / PWA 门禁 check-pwa.mjs
public/                   # PWA 资产（manifest / sw.js / icons）
```

不含任何视频/二进制素材文件（E2E 合成夹具为程序化生成的测试图样，不受此限）。

## 在线访问（GitHub Pages）

以下链接可直接在手机浏览器打开：

- Day1 核心四项：https://isxulong.github.io/Gymplay/probe/day1-core.html
- P3 循环精度：https://isxulong.github.io/Gymplay/probe/p3-loop-precision.html
- P4 倍速听感：https://isxulong.github.io/Gymplay/probe/p4-speed-listening.html
- P9 HEVC 解码：https://isxulong.github.io/Gymplay/probe/p9-hevc.html
- P10 URL 长度：https://isxulong.github.io/Gymplay/probe/p10-url-length.html
- P11 Wake Lock：https://isxulong.github.io/Gymplay/probe/p11-wake-lock.html

若 Pages 未开启或链接打不开，用本机部署替代：仓库根目录执行 `python3 -m http.server 8000`，手机同一局域网访问 `http://<电脑IP>:8000/probe/xxx.html`（电脑防火墙放行 8000 端口）；或后续自行绑定 Cloudflare Pages。

## 素材准备

| 素材 | 要求 | 用途 |
| --- | --- | --- |
| 素材 A · 主视频 | 1~3 分钟真人讲解健身视频，H.264/AAC 编码 mp4，**有清晰口令语音** | P1 / P2场景A / P3 / P4 / P7 / P8 |
| 素材 B · 第二段视频 | 另一段**不同**的视频（建议同规格） | P2 场景 B（换源） |
| HEVC 视频 | iPhone 直出（相机「高效」格式，或文件 App 导出） | P9 |

- 所有页面一律用 `<input type="file" accept="video/*">` 从**真机本地**选入素材，不上传到任何服务器；**不得向仓库提交任何视频文件**（E2E 合成夹具 `tests/e2e/fixtures/*.webm` 为 ffmpeg 程序化生成的测试图样，不含真实拍摄内容，不受此限）。
- P3 素材时长必须 **大于 10.5 秒**（段 [5.0s, 10.0s] 循环需要）。

## 探针执行清单（按定稿节奏：Day1 半天 + Day2 一天）

### Day 1（半天）· `probe/day1-core.html` — 设备：iPhone（P2 需 iOS 18.4+；不可得时按定稿 §3.2 P2 设备预案执行）

页面四区块**自上而下按 P8→P7→P1→P2 顺序**执行，每完成一节截图一节：

1. **P8 · playsinline**：选素材 A，分别点播放「带 / 不带 playsinline」两个视频，观察是否页内播放 / 强制全屏，点记录按钮。设备：iPhone。
2. **P7-A · 无手势播放**：点「① 开始 P7-A」后 10 秒内**不要触碰屏幕**，页面自动尝试 play()，记录是否被拒（预期 NotAllowedError）。设备：iPhone。
3. **P7-B · 后台节流**：点「② 开始 P7-B」后**立刻切后台静置 60 秒**再切回，页面统计 setInterval(50) 实际触发次数与 currentTime 推进；补充人工观察后台是否仍有声音。设备：iPhone。
4. **P1 · rVFC 动态阈值**：点开始后页面自动先 1x 播放 10 秒实测帧率（阈值 = 实测帧率 × 10s × 0.8），再 2x 播放 10 秒对比 rVFC 计数；期间不要触碰屏幕。设备：iPhone（覆盖手头最低 iOS 版本）+ 桌面 Chrome 对照。
5. **P2 · seek/换源冻结**（最高优先级）：场景 A「同文件随机 seek ×20」；场景 B 需素材 A、B 都选好，「两文件交替换源 ×20」；每次 seek 3 秒超时判冻结；每场景结束后点「▶ 续播确认」并人工确认出声出画面后记录。判定：两场景各 20 次全部 ≤500ms 且能续播 → 通过。设备：iOS 18.4+ 真机（必须），另加一台较低 iOS 版本对照。
6. **P3 · 循环精度**（Day 1 下午）：打开 `probe/p3-loop-precision.html`，选素材，「跑主线（rVFC）」和「跑对照（setInterval 50ms）」**各跑一遍**，记录 min/median/P95/max。判定：P95 ≤ 0.300s → 假设成立。设备：iPhone + 桌面 Chrome。

### Day 2（一天，四项互相独立，可换序/并行）· 设备见各项

7. **P9 · HEVC 解码**：`probe/p9-hevc.html`。页面加载即输出 canPlayType 三条探测；再选入 HEVC 素材，观察 error/canplay 日志，点播放后人工确认出画面出声并记录。设备：桌面 Chrome（优先选无 HEVC 硬解的机器）、安卓 Chrome、iPhone 对照。
8. **P4 · 极端倍速盲听**：`probe/p4-speed-listening.html`。选素材后 12 个样本按钮已随机排列（盲听），同一副耳机、固定音量，每格听 10~20 秒打分 1~5（3=能听清口令）；全部打完点「揭晓映射」「复制汇总结果」。判定：目标区间内主观分 ≥3 → 通过。设备：桌面 + iOS + 安卓各一，使用者**本人**听测。
9. **P10 · 配置 URL 长度**：`probe/p10-url-length.html`。点「生成四档配置并计算长度」，记录 10/30/50/80 段 URL 总长；点「复制 80 档完整链接」并发到微信/系统分享面板验证是否截断。判定：80 段 URL ≤ **1500 字符** 且不截断 → 通过（判定线=降级线=1500，原 2000 作废）。设备：桌面 + 手机各一。pako 已内联进页面，离线可用。
10. **P11 · Screen Wake Lock**：`probe/p11-wake-lock.html`。选素材，点开始（自动请求 wakeLock + 播放 + 5:00 倒计时），**静置 5 分钟不触碰、不切后台**；结束后点记录按钮。判定：5 分钟未锁屏 → 通过；API 不存在/被拒 → 记录现象走文案 D fallback。设备：**iPhone + Android 各一**（iOS 16.4+ 支持性为待验断言）。

## 结果截图回传方式

- 每完成一节（Day1 四区块每节、P3 每种模式、P9/P4/P10/P11 各一档）截图：**必须包含页面的 log 输出区**（黑底绿色文字），涉及人工观察的（P8 全屏现象、P2 续播、P7-B 后台声音、P4 打分表、P9 出画面出声、P11 是否锁屏）请一并把人工结论截图记录按钮点掉后再截一张。
- 截图统一回传到本任务（Gymplay M-1 探针）的评论区，按「探针编号-设备-日期」命名备注（如「P2-iPhone18.4-1103」）。
- 全部探针回传后，结论将整理进 ADR，满足 M0 入口门禁（P1/P2/P7/P8 全过 + P3 确定调度主线）后开工 M0。
