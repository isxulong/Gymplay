# EXP-004 · push 到 main 就是上线

- 状态：现行｜起始 v0.3.3（2026-11-06）

## 背景

本仓库的 Cloudflare Pages 接了 Git 集成：**`main` 上的提交会自动触发生产部署**。

这件事曾被误判过一次——包括主 AD 本人，当时记录的判断是「push 到 main 只跑 CI、不打标签就不部署」。这个判断是错的，用实测推翻了。

本地全绿 + 工作流某步显示 `skipped`，极易被读成「还没上线，可以再改改」。实测不是：

| 提交 | 提交时刻（UTC） | 线上 `BUILD_ID` | 间隔 |
| --- | --- | --- | --- |
| `80d7d9a` | 2026-11-06 14:42:06 | `20261106144226-v0.3.3` | 20 秒 |
| `fd3da3b` | 2026-11-06 15:25:36 | `20261106152617-v0.3.3` | 41 秒 |

与此同时 `release.yml:44` 的 `if: ${{ vars.CLOUDFLARE_DEPLOY_ENABLED == 'true' }}` 让打标签发版时那一「部署 Cloudflare Pages 主站」步骤显示 `skipped`——**工作流跳过的是它自己那套部署动作，Git 集成照跑**。所以「某步 skipped」与「线上已更新」可以同时为真。

## 做法

### 1. 动手前先判断「这次 push 会不会上线」

```bash
grep -n "if:" .github/workflows/release.yml    # :44，看哪一步被条件跳过
git config --get remote.origin.url             # 确认推的是同一个仓库
```

若仓库已接 Git 集成，**推 main 就等于上线**，没有中间态。

### 2. push 后直接读线上产物，不看工作流结论

```bash
curl -sS -A "Mozilla/5.0 … Chrome/120.0" -o /tmp/sw.js -w "http=%{http_code}\n" https://play.isxl.cn/sw.js
echo "exit=$?"                                  # 先判 HTTP 结果，再解析内容
grep -o "BUILD_ID = '[^']*'" /tmp/sw.js         # 期望 <14位UTC>-v<版本>
```

**不要写成 `curl … | grep BUILD_ID`**：管道取到的是 `grep` 的退出码，`curl` 失败也会因为「grep 没找到」而给出另一种误导。先落盘、判退出码，再解析——理由见 EXP-005。

### 3. 下「已上线」结论时必须同时给三样

**提交 SHA + 线上 `BUILD_ID` + 关键产物 `cmp` 结果**。缺任一样就写「未核」。

```bash
cmp /tmp/sw.js dist/sw.js       # 或比对 assets 下同名文件的 sha256
```

### 4. 需要「先验证再上线」时，走分支预览或本地 `wrangler` 预览

不要靠给工作流加 `if:` 追求「先不上线」——那控制的只是工作流自己的步骤，控制不了 Git 集成。

## 后果

- **把上线当草稿**：以为没部署，继续往 `main` 叠提交，每一步都直接对外可见。本仓库无 LICENSE、不对内分发，但生产域名是公开的。
- **反向误判**：看到 `skipped` 就写「部署失败」并回滚——实际线上已是新版本，回滚动作反而制造真事故。
- **证据链断**：只贴工作流绿勾，事后无法回答「当时线上到底是哪个版本」。
- **回滚成本被低估**：撤回标签对已部署内容无效，要彻底回滚只能 revert 后再推一次提交。

## 证据出处

| 项 | 位置 | 复现 |
| --- | --- | --- |
| 提交到线上 20 秒 | 验证日志 §20.4 | `git show -s --format='%H %ci' 80d7d9a`（22:42:06 +0800 = 14:42:06 UTC）；线上 `BUILD_ID=20261106144226` |
| 第二次推送同样即上线 | 验证日志 §25.3 | `fd3da3b`（15:25:36 UTC）→ 线上 `BUILD_ID=20261106152617`，41 秒 |
| 跳过步的条件 | `.github/workflows/release.yml:44` | `sed -n '44p'` |
| `BUILD_ID` 定宽生成 | `scripts/build-sw.mjs:24-25` | `sed -n '24,25p'`，`stamp` 为 14 位 UTC + 版本号 |
| 线上与本地产物一致 | 验证日志 §25.3 | `cmp` 逐字节一致；`index-Bj0Lw0tf.js` 137,041 B、`index-nLkps7dJ.css` 17,367 B |

## 边界

- **Cloudflare 的 Git 集成配置不在仓库里**（`wrangler.jsonc` 只有 `assets.directory`，无部署字段）。本条是「提交后 20 / 41 秒线上产物变化 + 该步 `skipped`」的观测相关性，**不是读配置得到的机制证明**。
- 换托管平台、或该集成被关闭后，本条失效，须重新取证。
- 访问线上资产时，`urllib` 等默认 User-Agent 会被 Cloudflare 返回 403，需带浏览器 UA——这是观测手法，不是结论。
