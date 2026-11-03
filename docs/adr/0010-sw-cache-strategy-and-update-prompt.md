# ADR-010 · SW 缓存策略收口：全量预缓存 + 版本共存懒删 + 构建注入 + 更新提示接线

- 状态：已定稿（M3 收口 SW 批次，2026-11-03）
- 依据：《综合方案修订定稿 v2》§2.7；红蓝对抗终审报告（2026-11-03）P1 风险①②与步骤 3；ADR-001「无框架原生 DOM」沿用
- 取代：`public/sw.js` M0 版缓存策略（activate 即删全部旧缓存 + 预缓存仅 3 文件 + CACHE_VERSION 人工同步）

## 背景（终审报告 P1 风险）

旧策略在发版窗口存在离线白屏风险，且更新提示未接线：

1. **白屏窗口**：新 SW activate 时立即删除旧缓存，而预缓存清单仅 `./`、`index.html`、`manifest.webmanifest` 3 项，不含 hash 产物（JS/CSS）。发版完成后断网，任何冷启动 / 刷新：index.html 从缓存命中，其引用的 hash JS/CSS 不在缓存 → 请求网络失败 → **白屏**。
2. **更新提示未接线**：sw.js 头注自认「M3 接线 UI」，src 内零实现，用户蹲守旧 tab 无法感知新版。
3. **CACHE_VERSION 人工同步**：发版靠人改 sw.js 换缓存名，漏改则新版本仍读旧缓存（陈旧 indefinitely）。

## 决策

### D1 · app shell 全量预缓存（构建时生成清单）

`scripts/build-sw.mjs`（挂在 `npm run build` 链内，vite build 之后）扫描 `dist/`，把入口 HTML、manifest、`assets/`、`icons/` 全量写入 `dist/sw.js` 的 `__PRECACHE_MANIFEST__` 占位符。`cache.addAll` 的原子性（任一项失败整体 reject）使 install 阶段成为「全量预缓存成功」的闸门。

### D2 · 版本化缓存共存 + 懒删（保留最新两代）

缓存名 `gymplay-shell-<BUILD_ID>`，`BUILD_ID = <UTC 时间戳 14 位>-v<package.json 版本>`（定宽时间戳保证字典序 == 时间序）。activate 时只删除第 2 代之前的缓存：当前代 + 上一代共存。

不采纳「activate 即删全部旧缓存」：旧 tab 仍由旧页面 JS 驱动，保留上一代可让发版后未刷新的旧 tab 断网继续可用；也不采纳「永不删」：无限累积存储。两代上限是对「发版窗口回退安全」与「存储增长」的折中（本项目全量 shell gzip 约 40KB，两代共占可忽略）。

**两级缓存匹配（共存的必要配套）**：fetch 处理必须先查当前代缓存、再以上一代兜底、最后网络——不能沿用全局 `caches.match()`（它会命中先建立的上一代缓存，导致升级后刷新仍拿到旧 shell，版本共存反而把更新「锁死」在旧版）。两级匹配下：升级后的刷新在当前代命中新版 shell；未刷新旧 tab 的懒请求在上一代兜底命中旧资产。

### D3 · CACHE_VERSION 构建注入（消灭人工同步）

`BUILD_ID` 由 `scripts/build-sw.mjs` 从 `package.json` 版本 + 构建时间戳生成，写入 `dist/sw.js`；`public/sw.js` 源文件只留占位符，**发版链路（release.yml 的 `npm run build`）无需任何人工改动即完成版本号更换**。注入器校验占位符存在且替换后无残留，缺失即 fail（防源文件与注入器漂移）。

### D4 · 「刷新即更新」提示接线（SW → 页面消息 → UI）

- SW 侧：activate 时若存在非当前代的旧缓存（= 升级而非首次安装），`postMessage({ type: 'GYMPLAY_SW_UPDATED', buildId })` 通知所有窗口（`includeUncontrolled: true`，覆盖仍由旧 SW 控制的旧 tab）。
- 页面侧（`src/ui/sw-update.ts`）：注册 SW；监听上述消息，弹底部提示条「新版本已就绪（vX.Y.Z），刷新即更新」，提供「刷新（location.reload）/ 稍后（关闭）」；另因浏览器默认只在导航或约 24h 后检查 SW 更新，页面在回前台时立即 `reg.update()`、之后每 5 分钟轮询，让蹲守中的旧 tab 及时感知发版。
- 首次安装（无旧缓存）不弹提示，避免打扰。

保留 M0 既有语义：install 成功（全量预缓存完成）后才 `skipWaiting()`，升级即激活；页面资产已加载在内存中，激活本身不打断旧 tab，刷新时机交给用户。

## 失效场景分析（为什么发版窗口不再白屏）

| # | 场景 | 旧策略结局 | 新策略结局 |
| --- | --- | --- | --- |
| 1 | 发版完成、用户在线升级（新 SW install 成功）后断网，冷启动 / 刷新 | 预缓存仅 3 项，hash JS/CSS 缺失 → **白屏** | 全量预缓存（含 hash 产物）→ index.html + JS/CSS 全部缓存命中 → **正常打开** |
| 2 | 发版瞬间用户断网，新 SW install 中预缓存失败 | install 失败不影响旧 SW，但 activate 即删旧缓存的语义在网络抖动重试成功后回到场景 1 | `cache.addAll` 原子失败 → install reject → 新 SW **不激活**，旧 SW + 旧缓存继续完整服务 → 不白屏；下一轮 install 重试 |
| 3 | 发版后旧 tab 未刷新即断网，继续使用 / 页内请求 | activate 已删旧缓存，旧 hash 资产缓存未命中 → 旧 tab 内后续加载失败 | 上一代缓存共存 + 两级匹配兜底 → 旧 tab 的资产请求仍从上一代命中 → 可用；刷新后在当前代命中新版本 |
| 4 | 服务器发版非原子（index.html 已新、hash 产物 404） | addAll 遇 404 整体 reject（旧策略 install 同样失败，此场景不恶化） | 同左：install 失败 → 旧 SW 继续服务 → 不白屏 |
| 5 | 服务器返回 200 但内容错乱 / 弱网半截 | 同上，非 `response.ok` 或流截断 → addAll reject | 同左 |
| 6 | 用户永不离线 | 一切正常 | 一切正常；升级时弹「刷新即更新」 |

残留边界（如实披露）：两代之后（连续两次发版都未刷新的极旧 tab）其缓存代被懒删，此时断网刷新会落到当前代新版本（正常打开，不是白屏）；「发版窗口」的白屏路径至此全部闭合。

## 连带影响

- `package.json` 的 `build` 脚本变为 `vite build && node scripts/build-sw.mjs`；CI / release.yml 无需改动（都走 `npm run build`）。
- `scripts/check-pwa.mjs`（gate:pwa）不受影响：dist/sw.js 仍存在、注册代码仍在产物中。
- `eslint.config.mjs` 既有 ignore（`public/sw.js`）继续覆盖占位符源文件；`scripts/*.mjs` 已在 Node globals 放开清单内。
- 冒烟脚本 `scripts/smoke-sw-update.mjs`（本地手动，非 CI 门禁）：两次构建模拟「新版部署后旧 tab 出现刷新即更新」+ 断网冷启动。
