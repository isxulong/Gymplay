# EXP-001 · 双树对照：基线树的身份必须自证

- 状态：现行｜起始 v0.3.3（2026-11-06）

## 背景

跑 `node scripts/gate-decode.mjs <已打过补丁的树>`，三行全报「❌ 旧树已有该闸（对照组不成立）」、`exit=1`。

直觉是「补丁把闸口挪错了」，真相是基线传错了对象：那棵树自己已经打过补丁，两树行为相同，脚本把「结果相同」判成了「旧树本来就有这闸」。这是主 AD 本人执行时犯的错，不是复核人的错——复核二当时报的是另一个问题：「5 次交付都写 `/tmp/base2`，却从没说过它是怎么来的」。

根因在脚本：`gate-decode.mjs:21` 只检查基线路径下 `src/core/config/codec.ts` 是否存在，**不校验基线树的身份**；`:118` 才是那句「对照组不成立」的判定文案。基线来历不写清，迟早有人传错。

## 做法

1. **用 commit 指认基线，不用目录名**：

   ```bash
   git worktree add --detach /tmp/base_a5 a5abbdf
   grep '"version"' /tmp/base_a5/package.json      # 应为 "0.3.2"
   git -C /tmp/base_a5 status --porcelain | wc -l  # 应为 0
   ```

   本文书写的 `a5abbdf` 就是 v0.3.2 的基线（2026-11-04）。目录名 `/tmp/base2` 这类写法不可交接——`/tmp` 会被清空，名字也不携带身份。

2. **跑对照前先做负向自检**：把**当前树自己**当基线传进去，必须得到 `exit=1` 且「对照组不成立」。

   ```bash
   node scripts/gate-decode.mjs .   # 期望 exit=1
   ```

   它若 `exit=0`，说明这门禁根本没在验身份，那么它对任何基线的 `exit=0` 也不能证明对照成立。

3. **不需要给基线树装依赖**：`gate-decode.mjs:35-36`（第 35 行为说明注释、第 36 行为实现） 写明「基线树没有 node_modules：pako 统一从当前树解析（两树 lockfile 均锁 1.0.11）」。

4. **不用别人的工作树当基线**。某成员报「345 条用例」，与实测差 4 条——差异不是漏测，是他那棵树含 09/10 号补丁、不含 11 号。树不同，比什么都没意义。

## 后果

- **假失败**：正确补丁被判「闸口挪错」，白返工一轮；再拿脏基线重验，结论继续假。
- **假成立更危险**：脏树当基线、补丁只改一处时两树一起通过，`exit=0` 被当成「对照成立」，「新增 N 条」随之失去参照。这比假失败更难发现，因为它长得像好消息。

## 证据出处

| 项 | 位置 | 复现 |
| --- | --- | --- |
| 传错基线 → 假失败 | 验证日志 §21.4 | `node scripts/gate-decode.mjs <已打补丁的树>` → `exit=1`，三行「❌ 旧树已有该闸」（对照组不成立） |
| 传对基线 → 通过 | 验证日志 §21.4 | `node scripts/gate-decode.mjs /tmp/base_a5` → `exit=0`，四行全部「旧树红 → 新树绿」 |
| 脚本不校验基线身份 | `scripts/gate-decode.mjs:21` | `sed -n '21p' scripts/gate-decode.mjs` → 只有 `existsSync(join(BASELINE, 'src/core/config/codec.ts'))` |
| 基线树无需依赖 | `scripts/gate-decode.mjs:35-36` | 基线树无 `node_modules`，对照仍 `exit=0` |

## 边界

- shallow clone 下基线 commit 可能不在本地，须先 `git fetch --unshallow` 或指定深度。
- 「无需装依赖」只对 `gate-decode` 成立；其它脚本可能不这么解析模块。
- 本条不是 `gate-decode` 的使用说明（命令速查归 `README` 与脚本头注）。它只讲一件事：**任何双树对照，前提是证明两棵树身份不同**。这条换到别的对照脚本、别的项目同样成立。
