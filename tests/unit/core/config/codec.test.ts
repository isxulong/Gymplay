import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  decodeKey,
  encodeConfig,
  exportConfig,
  importConfig,
  keyLength,
  URL_KEY_CHAR_LIMIT,
} from '../../../../src/core/config/codec';
import type { PlayerConfig } from '../../../../src/core/config/schema';
import { makeConfig, makeSegment } from '../../helpers';

describe('codec · round-trip（M0 门禁 1）', () => {
  it('基础配置编解码恒等', () => {
    const cfg = makeConfig();
    const r = decodeKey(encodeConfig(cfg));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(cfg);
  });

  it('inQueue=false 与 loop.mode 三态各自恒等', () => {
    for (const mode of ['off', 'queue', 'segment'] as const) {
      const cfg = makeConfig({
        segments: [
          makeSegment({ id: 'aaa000', start: 0, end: 10, rate: 0.5, label: '热身', inQueue: true }),
          makeSegment({ id: 'bbb111', start: 10, end: 25, rate: 4, label: '冲刺', inQueue: false }),
        ],
        sequence: ['aaa000', 'bbb111', 'aaa000'],
        loop: mode === 'queue' ? { mode, count: 2 } : { mode },
        meta: { createdAt: '2026-11-02T20:00:00+08:00', appVersion: '0.0.0' },
      });
      const r = decodeKey(encodeConfig(cfg));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual(cfg);
    }
  });

  it('确定性：同一配置两次编码产出同一密钥（规范化 JSON）', () => {
    const cfg = makeConfig();
    expect(encodeConfig(cfg)).toBe(encodeConfig(cfg));
  });

  it('密钥只含 base64url 字符（可安全进 URL hash）', () => {
    const key = encodeConfig(makeConfig());
    expect(key).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('键序无关：字段顺序不同的等价配置产出同一密钥', () => {
    const a = makeConfig();
    const b = JSON.parse(JSON.stringify(a, ['meta', 'createdAt', 'appVersion', 'v', 'video', 'type', 'filename', 'duration', 'segments', 'id', 'start', 'end', 'rate', 'label', 'inQueue', 'sequence', 'loop', 'mode', 'count'].sort().reverse())) as PlayerConfig;
    expect(encodeConfig(b)).toBe(encodeConfig(a));
  });
});

describe('codec · 失败可诊断（F8 AC4）', () => {
  it('截断的密钥 → 明确失败', () => {
    const key = encodeConfig(makeConfig());
    const r = decodeKey(key.slice(0, Math.max(1, key.length - 8)));
    expect(r.ok).toBe(false);
  });

  it('非法字符 → BAD_BASE64', () => {
    const r = decodeKey('!!!not-base64!!!');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('BAD_BASE64');
  });

  it('字符集合法但 base64 非法（atob 抛错路径）→ BAD_BASE64', () => {
    const r = decodeKey('a'); // 长度 %4==1，补垫后 atob 拒绝
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('BAD_BASE64');
  });

  it('deflate 合法但缺版本字段 v → BAD_JSON', () => {
    const r = decodeKey(bytesToKey(deflate('{"segments":[]}', { level: 9 })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('BAD_JSON');
  });

  it('encodeConfig 收到非法配置 → 抛错（编码侧属编程错误）', () => {
    const bad = { v: 1 } as unknown as PlayerConfig;
    expect(() => encodeConfig(bad)).toThrow(/非法配置/);
  });

  it('exportConfig 收到非法配置 → 抛错', () => {
    const bad = { v: 1 } as unknown as PlayerConfig;
    expect(() => exportConfig(bad)).toThrow(/非法配置/);
  });

  it('空密钥 → 失败', () => {
    expect(decodeKey('').ok).toBe(false);
  });

  it('base64url 合法但非 deflate 数据 → BAD_DEFLATE', () => {
    const r = decodeKey(btoa('definitely not deflate data').replaceAll('+', '-').replaceAll('/', '_'));
    expect(r.ok).toBe(false);
  });

  it('deflate 合法但 JSON 损坏 → BAD_JSON', () => {
    const key = bytesToKey(deflate('{broken json', { level: 9 }));
    const r = decodeKey(key);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('BAD_JSON');
  });

  it('v=2 → 后向拒绝（版本演进五条 · 3）', () => {
    const raw = { ...JSON.parse(canonicalize(makeConfig())), v: 2 };
    const r = decodeKey(bytesToKey(deflate(JSON.stringify(raw), { level: 9 })));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('FUTURE_VERSION');
      expect(r.error.message).toContain('升级');
    }
  });
});

describe('codec · P10 容量结论回归锁', () => {
  function bigConfig(n: number): PlayerConfig {
    const segments = Array.from({ length: n }, (_, i) =>
      makeSegment({
        id: i.toString(36).padStart(6, '0').slice(-6),
        start: i * 10,
        end: i * 10 + 9,
        rate: 1.5,
        label: `第${i + 1}组`,
      }),
    );
    return makeConfig({
      video: { type: 'local', filename: 'long-workout.mp4', duration: n * 10 },
      segments,
      sequence: segments.map((s) => s.id),
    });
  }

  it('50 段密钥 < 1500 判定线（P10 实测 1359）', () => {
    const len = keyLength(encodeConfig(bigConfig(50)));
    expect(len).toBeLessThan(URL_KEY_CHAR_LIMIT);
  });

  it('80 段密钥 > 1500 判定线 → 需走 .json 降级（P10 实测 1911）', () => {
    const len = keyLength(encodeConfig(bigConfig(80)));
    expect(len).toBeGreaterThan(URL_KEY_CHAR_LIMIT);
  });
});

describe('codec · 载体二 .json 导出/导入（P10 降级，M3 接线 UI）', () => {
  it('exportConfig → importConfig 恒等（与 URL 密钥同一数据模型）', async () => {
    const cfg = makeConfig({
      segments: [makeSegment({ id: 'aaa000', inQueue: false })],
      loop: { mode: 'queue', count: 0 },
    });
    const blob = exportConfig(cfg);
    expect(blob.type).toBe('application/json');
    const r = await importConfig(blob);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(cfg);
  });

  it('损坏的 .json → 明确失败', async () => {
    const r = await importConfig(new Blob(['not json'], { type: 'application/json' }));
    expect(r.ok).toBe(false);
  });

  it('缺版本字段的 .json → 明确失败', async () => {
    const r = await importConfig(new Blob(['{}'], { type: 'application/json' }));
    expect(r.ok).toBe(false);
  });

  it('来自更新版本的 .json（v=2）→ 后向拒绝文案', async () => {
    const r = await importConfig(new Blob([JSON.stringify({ v: 2 })], { type: 'application/json' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('更新版本');
  });
});

// ---- 测试内小工具（与 codec 同管线，构造中间态样本） ----------
import { deflate } from 'pako';
function bytesToKey(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
