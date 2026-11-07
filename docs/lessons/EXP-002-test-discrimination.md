# EXP-002 · 用例鉴别力：新用例必须能鉴别旧实现

- 状态：现行｜起始 v0.3.3（2026-11-06）

## 背景

一个真实发生的事故：`tests/unit/app/play-mode.test.ts:201` 的 `BA-F-12` 用例，标题写着「试听 PlayPlan 携带 sequence 真实下标（≥ 0，禁用 -1 哨兵）」，看起来正是 −1 哨兵缺陷的回归防护。

但它证明不了这件事。它用的 `auditConfig()`（同文件 `:179`）把两段都放进了 `sequence`，于是 `cfg.sequence.indexOf(seg.id)` 恒 ≥ 0——**带不带 −1 哨兵，这条都绿**。−1 只在「段存在、但不在队列」时才出现，而这个场景它根本没构造。

该用例已就地加了警示注释（`play-mode.test.ts:202-207`），写明「本条单独不足以证明 N-1」。这是正确的处置方式：不改名蒙混，就地标明它证明什么、不证明什么。

## 做法

### 1. 写完用例立刻做「退回旧实现」实验

不要问「新代码跑通了吗」，要问「把新代码退回旧的，这条会不会红」。退回后仍绿 = 这条用例没在测东西。

**必须写明被替换的**确切行**——行号 + 原文 + 替换文本，不能只写函数名。**

以 `src/app/undo-store.ts:272` 为例：

```bash
cp src/app/undo-store.ts /tmp/undo.bak
# 原文恰好 1 处：  return utf8Bytes(serializeUndoEntries([entry]));
# 替换为：        return serializeUndoEntries([entry]).length;
grep -c "return utf8Bytes(serializeUndoEntries(\[entry\]));" src/app/undo-store.ts   # 期望 1
npx vitest run tests/unit/app/undo-byte-guard-and-quota.test.ts
# 期望：2 failed | 2 passed (4)
cp /tmp/undo.bak src/app/undo-store.ts
md5sum src/app/undo-store.ts    # 还原后应为 6da4cb09…（实测核对过）
npx vitest run tests/unit/app/undo-byte-guard-and-quota.test.ts
# 期望：4 passed (4)
```

### 2. 红 → 绿**双向**都要实测

只有「新实现绿」不构成证明。绿可能因为它本来就没问题，也可能因为用例压根没约束到它。

### 3. 记录时写清变异深度

只写「把 `resolveAuditionSequenceIndex` 回退成 −1 哨兵」是**不够的**：同一个函数，两种变异深度给出相反结论。

**变异 A｜只替换 fallback 那一行**（`src/app/controller.ts:132`）：

```bash
# 原文：  return { sequenceIndex: segIdx >= 0 ? segIdx : 0, queued: false };
# 替换：  return { sequenceIndex: -1, queued: false };
npx vitest run tests/unit/app/play-mode.test.ts
# 实测：1 failed | 20 passed (21)
# 红的是 N-5 负向用例；BA-F-12 仍绿 ← 坐实 BA-F-12 是假判据
```

**变异 B｜整个函数体替换**（`src/app/controller.ts:128-132` 五行一并换成 `return { sequenceIndex: -1, queued: false };`）：

```bash
# 实测：3 failed | 18 passed (21)
# 红的是 BA-F-12 + N-5 负向 + N-5 正向
```

两组读数差 2 条，结论方向相反：变异 A 说 BA-F-12 没在测 −1 哨兵（假判据），变异 B 表面上说它在测（因为它红了）。变异 B 让 BA-F-12 变红的原因是**正向下标映射被一起砸掉了**——它红的理由不是「−1 哨兵」，所以不能拿它当 BA-F-12 有鉴别力的证据。**只有变异 A 这种只砸目标行为的深度，才回答得了「这条用例有没有鉴别力」。**

另需注意：**没有「整函数退回基线实现」这个选项**——`a5abbdf` 基线里根本没有 `resolveAuditionSequenceIndex`（`git show a5abbdf:src/app/controller.ts | grep -c resolveAuditionSequenceIndex` = 0），该函数是本次补丁新增的。写「退回基线」会让后来者去找一个不存在的代码。

### 4. 同时看「不该红的有没有红」

做 −1 变异时，`BA-F-12` 仍然绿——由此独立坐实它是假判据。一次变异能同时产出两个信息：目标用例红了（鉴别力成立），无关用例仍绿（变异精准）。

### 5. 单测全绿不能替代 E2E

单独退回 `src/ui/editor.ts`，`tsc --noEmit` 零错误、单测全绿（`npx vitest run`），但 E2E 双端变红。行为回归可以完全不被单测感知。所以「可整体回退」不等于「可按批次独立回退」。

## 后果

- **回归防护为零**：恒绿用例让覆盖率上升，缺陷复发时照样通过。−1 哨兵就是这样「通过验收」的——它甚至被写进了交付说明。
- **还会被后续改动当作「已有覆盖」引用**，从此没人再去补真正的用例。
- **论证会被自己推翻**：记录只写函数名，他人照做得到相反读数，「这是假判据」的结论当场站不住。

## 证据出处

| 项 | 位置 | 复现 |
| --- | --- | --- |
| 单行变异 → 变红 | `src/app/undo-store.ts:272` | 按做法 1 操作：`2 failed \| 2 passed (4)`；还原后 `4 passed (4)`，md5 `6da4cb09…` |
| 只替换 fallback 行 → `1 failed` | `src/app/controller.ts:132` | `1 failed \| 20 passed (21)`，红的是 N-5 负向，`BA-F-12` 绿 |
| 整个函数体换成 −1 哨兵 → `3 failed` | `src/app/controller.ts:128-132` | `3 failed \| 18 passed (21)`，`BA-F-12` 红（但红因非哨兵，不作鉴别力证据） |
| 假判据原文 | `tests/unit/app/play-mode.test.ts:201-207` | `sed -n '201,207p'`，作者已就地标注局限 |
| `auditConfig` 把两段都进队列 | `tests/unit/app/play-mode.test.ts:179` | `sed -n '179,190p'` |
| 单测绿而 E2E 红 | 验证日志 §19 | 退回 `editor.ts`：`tsc --noEmit` 0 错、单测全绿、E2E 双端变红 |

## 边界

- 「变红」可能来自**编译错误**而非断言失败。类型不兼容时先看到 `tsc` 报错，这不算鉴别力证据——必须确认是断言失败。
- 行号随重构漂移，所以每条都同时记原文与替换文本。
- 本条不覆盖「如何写新用例」，只讲**验收一条用例是否有效**的方法。
