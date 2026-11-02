/**
 * L3 · 版本迁移链注册表（版本演进五条，见 docs/adr/0004-schema-v1.md）
 *
 * 1. v 单调递增：解码器按 v 查迁移链，旧版本逐级升到当前版后再校验；
 * 2. 前向宽容：未知字段忽略（在 schema.validate 内落实）；
 * 3. 后向拒绝：v 大于当前支持版本 → 明确报错，绝不静默猜解析；
 * 4. 升版纪律：改变语义 / 删字段 / 改类型 / 收紧失效性约束才升 v，并在此登记迁移函数；
 * 5. 与应用 SemVer 解耦。
 *
 * v1 是当前首个版本，迁移链为空；fromV === 1 直接放行。
 */

import { SCHEMA_VERSION, type Result, type SchemaError } from './schema';

export type Migration = (raw: unknown) => unknown;

/** fromV → fromV+1 的迁移函数注册表。当前为空（v1 为首个版本）。 */
const MIGRATIONS: Readonly<Record<number, Migration>> = {};

export function migrate(raw: unknown, fromV: number): Result<unknown, SchemaError> {
  if (!Number.isInteger(fromV) || fromV < 1) {
    return { ok: false, error: { code: 'BAD_VERSION', message: `无法识别的配置版本：${String(fromV)}` } };
  }
  if (fromV > SCHEMA_VERSION) {
    return {
      ok: false,
      error: { code: 'FUTURE_VERSION', message: '该密钥由更新版本生成，请升级应用' },
    };
  }
  let current = raw;
  /* v8 ignore next 9 -- v1 为首个版本，迁移链为空，循环体休眠；升 v2 登记迁移后此路径才可达 */
  for (let v = fromV; v < SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) {
      return {
        ok: false,
        error: { code: 'BAD_VERSION', message: `缺少 v${v} → v${v + 1} 的迁移函数` },
      };
    }
    current = step(current);
  }
  return { ok: true, value: current, warnings: [] };
}

/** 读取原始数据的版本号；非对象或无 v 字段时返回 null。 */
export function detectVersion(raw: unknown): number | null {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const v = (raw as Record<string, unknown>).v;
    if (typeof v === 'number' && Number.isInteger(v)) return v;
  }
  return null;
}
