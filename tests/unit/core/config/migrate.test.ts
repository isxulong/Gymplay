import { describe, expect, it } from 'vitest';
import { detectVersion, migrate } from '../../../../src/core/config/migrate';
import { asRaw, makeConfig } from '../../helpers';

describe('migrate · 版本演进五条', () => {
  it('v1 直接放行（迁移链空，当前即首版）', () => {
    const raw = asRaw(makeConfig());
    const r = migrate(raw, 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(raw);
  });

  it('v > 当前版 → 后向拒绝，明确文案（第 3 条）', () => {
    const r = migrate(asRaw(makeConfig()), 2);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('FUTURE_VERSION');
      expect(r.error.message).toBe('该密钥由更新版本生成，请升级应用');
    }
  });

  it('v < 1 → 无法识别', () => {
    const r = migrate(asRaw(makeConfig()), 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('BAD_VERSION');
  });

  it('非整数版本 → 无法识别', () => {
    const r = migrate(asRaw(makeConfig()), 1.5);
    expect(r.ok).toBe(false);
  });
});

describe('detectVersion', () => {
  it('从原始数据读出版本号', () => {
    expect(detectVersion({ v: 1 })).toBe(1);
  });
  it('无 v / 非对象 → null', () => {
    expect(detectVersion({})).toBeNull();
    expect(detectVersion('x')).toBeNull();
    expect(detectVersion(null)).toBeNull();
    expect(detectVersion([1])).toBeNull();
  });
});
