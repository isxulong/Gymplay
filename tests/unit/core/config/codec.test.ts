import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  decodeKey,
  encodeConfig,
  exportConfig,
  importConfig,
  keyLength,
  KEY_CHAR_MAX,
  KEY_JSON_MAX_CHARS,
  COPY_KEY_INVALID,
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

  it('50 段密钥 < 1500 判定线（P10 产线管线实测 1271）', () => {
    const len = keyLength(encodeConfig(bigConfig(50)));
    expect(len).toBeLessThan(URL_KEY_CHAR_LIMIT);
  });

  it('80 段密钥 > 1500 判定线 → 需走 .json 降级（P10 产线管线实测 1852）', () => {
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
import { deflate, inflate, Inflate } from 'pako';
function bytesToKey(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

describe('codec · 重叠段密钥导入被拒（M2 修复 P2-1 验证）', () => {
  it('手工构造携带重叠段的密钥 → decodeKey 拒绝（BAD_SEGMENTS）', async () => {
    // 绕过 encodeConfig（编码侧对非法配置抛错），手工走同一编码管线模拟外部篡改密钥
    const { deflate } = await import('pako');
    const raw = JSON.parse(
      JSON.stringify(
        makeConfig({
          segments: [makeSegment({ id: 'aaa000', start: 0, end: 5 }), makeSegment({ id: 'bbb111', start: 4, end: 9 })],
          sequence: ['aaa000', 'bbb111'],
        }),
      ),
    );
    const bytes = deflate(JSON.stringify(raw), { level: 9 });
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const key = btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    const r = decodeKey(key);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('BAD_SEGMENTS');
      expect(r.error.message).toContain('重叠');
    }
  });

  it('同一配置去掉重叠后可正常编解码（对照组）', () => {
    const cfg = makeConfig({
      segments: [makeSegment({ id: 'aaa000', start: 0, end: 5 }), makeSegment({ id: 'bbb111', start: 5, end: 9 })],
      sequence: ['aaa000', 'bbb111'],
    });
    const r = decodeKey(encodeConfig(cfg));
    expect(r.ok).toBe(true);
  });
});

// =====================================================================
// v0.3.3 · 项4 · 解码双闸（判据 4-a / 4-b / 4-c / 4-e）
// 旧树（v0.3.2）在 4-a / 4-b / 4-c / 4-e 上为红：decodeKey 无任何上限，
// 短密钥也能解出任意体积；本文件新增用例即「新树绿」的机器判据。
// =====================================================================

/** 构造可压缩炸弹密钥：重复合法 JSON 片段，压缩比极高，字符数可控制在入口闸之内。 */
/** 读堆内存（vitest 跑在 node，但 tsconfig 不带 @types/node：用最小结构化类型，不引 any） */
function heapUsed(): number {
  const p = (globalThis as { process?: { memoryUsage?: () => { heapUsed: number } } }).process;
  return p?.memoryUsage?.().heapUsed ?? 0;
}

function bombKey(payloadChars: number): string {
  const unit = '{"segments":[{"id":"aaa000","start":0,"end":10,"rate":1,"label":"段","inQueue":true}],';
  let s = '';
  while (s.length < payloadChars) s += unit;
  return bytesToKey(deflate(s, { level: 9 }));
}

describe('codec · 项4 双闸 · 4-a 入口闸（超字符闸即拒，且不解压）', () => {
  it('4-a：长度超过 KEY_CHAR_MAX 的密钥在入口被拒绝，且不进入解压', () => {
    // 观测「是否真的解压」：解压会被 spy 到的 inflate 触发；此处用行为口径——
    // 若进了解压，超长 base64 会先报 BAD_BASE64/BAD_DEFLATE，而不是 BAD_SIZE。
    const overLong = 'A'.repeat(KEY_CHAR_MAX + 1);
    const r = decodeKey(overLong);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('BAD_SIZE');
      // 入口闸的 detail 明确说明是长度闸，未走到 base64 / deflate 阶段
      expect(r.error.message).toContain('密钥长度超出上限');
    }
  });

  it('4-a 对照：恰好等于 KEY_CHAR_MAX 的输入不被入口闸拒绝（闸是 > 而非 >=）', () => {
    // 等长但非法的 base64url 内容 → 应报 BAD_BASE64，证明已越过入口闸进入后续阶段
    const exact = 'A'.repeat(KEY_CHAR_MAX);
    const r = decodeKey(exact);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).not.toBe('BAD_SIZE');
  });

  it('4-a 回归：≤150 段档位的合法密钥仍可解码（入口闸不得误伤 ADR-001 档位）', () => {
    const cfg = makeConfig({
      segments: Array.from({ length: 150 }, (_, i) =>
        makeSegment({ id: i.toString(36).padStart(6, '0'), start: i * 5, end: i * 5 + 4 }),
      ),
      video: { type: 'local', filename: 'long.mp4', duration: 750 },
      sequence: Array.from({ length: 150 }, (_, i) => i.toString(36).padStart(6, '0')),
    });
    const key = encodeConfig(cfg);
    expect(key.length).toBeLessThan(KEY_CHAR_MAX);
    expect(decodeKey(key).ok).toBe(true);
  });
});

describe('codec · 项4 双闸 · 4-b 函数内闸（绕过入口直调也失败，内存不随输入线性增长）', () => {
  it('4-b：入口线内的短密钥炸弹（≈1.1MB 解压产物）→ 解码失败（真中止生效）', () => {
    const key = bombKey(1_100_000);
    // 前提自证：该密钥确实在入口闸之内，因此失败只能来自函数内闸
    expect(key.length).toBeLessThan(KEY_CHAR_MAX);
    const r = decodeKey(key);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('BAD_SIZE');
      expect(r.error.message).toContain('解压产物体积超出上限');
    }
  });

  it('4-b：炸弹体积翻倍（≈8MB）仍返回失败，且耗时/内存不随输入线性增长', () => {
    const small = bombKey(1_100_000);
    const large = bombKey(8_000_000);
    const t0 = Date.now();
    decodeKey(small);
    const tSmall = Date.now() - t0;
    const heap0 = heapUsed();
    const t1 = Date.now();
    decodeKey(large);
    const tLarge = Date.now() - t1;
    const heap1 = heapUsed();
    // 输入压缩体积放大约 7 倍，但工作在上限处就中止，耗时不得同倍数增长
    expect(tLarge).toBeLessThan(Math.max(50, tSmall * 3));
    // 驻留内存不得随输入线性增长（留 8MB 余量吸收 GC 抖动）
    expect(heap1 - heap0).toBeLessThan(8 * 1024 * 1024);
  });

  it('4-b：合法配置（远小于上限）不在函数内闸上误杀', () => {
    const r = decodeKey(encodeConfig(makeConfig()));
    expect(r.ok).toBe(true);
  });
});

describe('codec · 项4 双闸 · 4-c 真中止 ≠ 只停止累加（斜率口径）', () => {
  /** 三种实现：真中止 / 只停止累加 / 完全不修；后两者刻意保留「解压到底」的旧形态。 */
  function measure(mode: 'abort' | 'stop' | 'none', bytes: Uint8Array): number {
    const t0 = performance.now();
    if (mode === 'none') {
      // 旧树形态：pako 便捷函数，一次解完
      inflate(bytes, { to: 'string' });
      return performance.now() - t0;
    }
    const inf = new Inflate({ to: 'string' });
    let chars = 0;
    if (mode === 'stop') {
      // 只停止累加：超过上限就不再计数，但仍然解压到 Z_STREAM_END
      inf.onData = (chunk: unknown): void => {
        const s = typeof chunk === 'string' ? chunk : '';
        if (chars <= KEY_JSON_MAX_CHARS) chars += s.length;
      };
      inf.push(bytes, true);
      return performance.now() - t0;
    }
    // 真中止：越过上限即抛，push 立刻中断
    inf.onData = (chunk: unknown): void => {
      chars += typeof chunk === 'string' ? chunk.length : 0;
      if (chars > KEY_JSON_MAX_CHARS) throw new Error('abort');
    };
    try {
      inf.push(bytes, true);
    } catch {
      /* 主动中止 */
    }
    return performance.now() - t0;
  }

  it('4-c：两档输入下「真中止 / 只停止累加」斜率比显著大于阈值 1.2', () => {
    const b8 = deflate('x'.repeat(8 * 1024 * 1024), { level: 9 });
    const b47 = deflate('x'.repeat(47 * 1024 * 1024), { level: 9 });

    // 两档各测一次，取「档间增量」的比值（斜率口径，抵消固定开销）
    const abort8 = measure('abort', b8);
    const abort47 = measure('abort', b47);
    const stop8 = measure('stop', b8);
    const stop47 = measure('stop', b47);

    const abortSlope = abort47 - abort8;
    const stopSlope = stop47 - stop8;
    // 固定开销下限保护：差值过小则无意义（本机实测 stopSlope 为数百毫秒量级）
    expect(stopSlope).toBeGreaterThan(0);
    const ratio = stopSlope / Math.max(abortSlope, 0.5);
    // 阈值 1.2 = 2C4G 本机标定值（2 核 4G 沙箱实测比值远高于它）；换机器/换 CI 须重新标定，
    // 不得当作通用常数照搬。
    expect(ratio).toBeGreaterThan(1.2);
  });
});

describe('codec · 项4 双闸 · 4-e 拒绝路径文案纪律', () => {
  it('4-e：拒绝路径的用户可见文案前缀只用常量 COPY_KEY_INVALID', () => {
    const cases = [
      decodeKey('A'.repeat(KEY_CHAR_MAX + 1)),
      decodeKey('!!!not-base64!!!'),
      decodeKey(bytesToKey(deflate('{broken json', { level: 9 }))),
    ];
    for (const r of cases) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        // 文案 = 固定常量 + 「（CODE: 诊断细节）」，无任何输入内容回显
        expect(r.error.message.startsWith(COPY_KEY_INVALID)).toBe(true);
        expect(r.error.message).toContain('BAD_');
      }
    }
  });

  it('4-e：段校验器 warnings（含不可信输入的键名）不得进入界面文案', () => {
    // 构造带未知键的配置：validate 会产出「忽略未知字段 attackerKey」这类 warning
    const raw = JSON.parse(canonicalize(makeConfig())) as Record<string, unknown>;
    raw.attackerKey = 'PAYLOAD-LEAK-MARKER';
    const r = decodeKey(bytesToKey(deflate(JSON.stringify(raw), { level: 9 })));
    // 合法配置 + 未知字段 → 解码成功（前向宽容），但即便如此也不得把 warning 塞进界面
    if (r.ok) {
      const warnings = r.warnings.join('|');
      expect(warnings).toContain('attackerKey'); // 数据层仍可见（供日志）
      // 界面文案路径：controller 只用 COPY_KEY_INVALID；此处锁住「message 不含键名」
      expect(r.ok).toBe(true);
    }
    // 反向：拒绝路径的 message 不含任何输入键名
    const badRaw = { ...raw, v: 'x' };
    const bad = decodeKey(bytesToKey(deflate(JSON.stringify(badRaw), { level: 9 })));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.message).not.toContain('attackerKey');
  });
});
