/**
 * E2E 夹具绝对路径解析（跨平台，零 Node 类型依赖）。
 *
 * 背景（v0.3.4）：**14 个** spec 原先各自写 `new URL('./fixtures/x', import.meta.url).pathname`
 *（`tests/e2e/` 共 17 个 spec，另 3 个 — dock-pixels / native-engine / notifications —
 * 本就不含该写法，故新增 spec 不必默认前置本模块）。
 * 这个写法在 POSIX 上恰好就是合法文件路径，但在 Windows 上返回 `/E:/repo/tests/...`，
 * 首字符斜杠被 node:path 拼成 `E:\E:\repo\...`（重复盘符）→ ENOENT。
 * 实测：修前 60 failed / 13 passed（共 73），修后 1 failed / 72 passed。
 *
 * 为什么不直接用 `node:url` 的 `fileURLToPath`：
 * 本仓库按 ADR-003 不引入 `@types/node`（依赖白名单），`tsconfig.json` 的 `types` 只有
 * `vite/client`，因此 `import { fileURLToPath } from 'node:url'` 会以 TS2307 打断
 * `npm run typecheck`（实测 12 条报错）。scripts/*.mjs 不受影响——它们不在 tsconfig
 * 的 include 里，所以那边仍用官方的 fileURLToPath。
 *
 * 本模块是全仓唯一「被 14 个 spec 依赖」的路径解析点，因此单独配单测
 * （tests/unit/app/e2e-paths.test.ts）锁住四个分支——它不进覆盖率统计
 * （vite.config.ts 的 coverage.include 只有 src/core/**），只能靠用例而非数字守。
 */

/**
 * 把 file: URL 的 pathname 还原成本机文件系统路径。
 *
 * 分支（单测逐个锁定）：
 *  - Windows 盘符：`/E:/repo/a.webm` → `E:/repo/a.webm`（剥掉唯一的前导斜杠）
 *  - POSIX 绝对：`/home/u/a.webm` → `/home/u/a.webm`（**不剥**，否则变成相对路径）
 *  - UNC：`//host/share/a.webm` → `//host/share/a.webm`（**不剥**，剥了会丢主机名）
 *  - percent-encoding：`%E4%B8%AD` → `中`；非法转义序列（孤立 `%`）**不抛异常**，
 *    原样保留——`decodeURIComponent('100%')` 会抛 URIError（ECMA-262 规定行为），
 *    而路径里出现孤立 `%` 是合法的（如文件名 `进度100%.webm`），不能让解析函数炸掉整个用例。
 */
export function toFsPath(pathname: string): string {
  const decoded = safeDecode(pathname);
  // Windows：'/E:/repo/a.webm' → 'E:/repo/a.webm'；UNC（'//host/share'）保持原样
  return /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded;
}

/** decodeURIComponent 的容错版：非法转义序列原样保留，绝不抛。 */
function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    // 逐段尝试：只解能解的片段，其余原样保留（避免一处坏序列毁掉整条路径）
    return text.replace(/(%[0-9A-Fa-f]{2})+/g, (seq) => {
      try {
        return decodeURIComponent(seq);
      } catch {
        return seq;
      }
    });
  }
}

/** 取 `tests/e2e/` 下相对路径（如 `./fixtures/x.webm`）的绝对文件路径。 */
export function e2ePath(relative: string, base: string = import.meta.url): string {
  return toFsPath(new URL(relative, base).pathname);
}
