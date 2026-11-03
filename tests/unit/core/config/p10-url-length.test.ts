import { describe, expect, it } from 'vitest';
import { deflate } from 'pako';
import {
  canonicalize,
  decodeKey,
  encodeConfig,
  keyLength,
  URL_KEY_CHAR_LIMIT,
} from '../../../../src/core/config/codec';
import type { PlayerConfig } from '../../../../src/core/config/schema';

/**
 * P10 · 配置 URL 密钥长度（产线管线实测，2026-11-03 重跑）
 *
 * 测量管线 = codec.ts 产线 encodeConfig（validate → canonicalize → deflate level 9 → base64url），
 * 与 probe/p10-url-length.html 已对齐的产线管线一致；档位与典型配置构造同探针页 buildConfig。
 * 本 spec 输出的数值即 ADR-001 P10 条目的「产线管线实测值」来源，重跑命令：npm test -- p10-url-length。
 * 纪律：数值必须来自真实运行输出，不得由旧（JSON.stringify＋默认级压缩）数值推算。
 */

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];
const SEG_LEN = 7.5; // 典型健身动作段落长度（秒），与探针页一致
const TIERS = [10, 25, 50, 80, 100, 150];

function b36id(n: number): string {
  return n.toString(36).padStart(6, '0');
}

/** 典型配置构造（与 probe/p10-url-length.html buildConfig 逐字段一致） */
function buildConfig(segCount: number): PlayerConfig {
  const segments = Array.from({ length: segCount }, (_, i) => ({
    id: b36id(i + 1),
    start: Math.round(i * SEG_LEN * 100) / 100,
    end: Math.round((i + 1) * SEG_LEN * 100) / 100,
    rate: RATES[i % RATES.length],
    label: `段${String(i + 1).padStart(2, '0')}`,
    inQueue: true,
  }));
  return {
    v: 1,
    video: {
      type: 'local',
      filename: '健身讲解视频.mp4',
      duration: Math.round(segCount * SEG_LEN * 100) / 100,
    },
    segments,
    sequence: segments.map((s) => s.id),
    loop: { mode: 'queue', count: 0 },
    meta: { createdAt: '2026-11-02T00:00:00+08:00', appVersion: '0.0.0' },
  };
}

interface Row {
  segments: number;
  canonicalJsonChars: number;
  deflateBytes: number;
  keyChars: number;
  passLine: boolean;
}

describe('P10 · URL 密钥长度 · 产线管线实测（canonicalize＋deflate level 9）', () => {
  it('各档位实测并输出数值表（ADR-001 P10 回填来源）', () => {
    const rows: Row[] = [];
    for (const n of TIERS) {
      const cfg = buildConfig(n);
      const canonical = canonicalize(cfg);
      const bytes = deflate(canonical, { level: 9 }); // 与 encodeConfig 内部同参数，仅用于报告字节数
      const key = encodeConfig(cfg);
      const decoded = decodeKey(key);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) expect(decoded.value).toEqual(cfg);
      expect(keyLength(key)).toBe(key.length);
      rows.push({
        segments: n,
        canonicalJsonChars: canonical.length,
        deflateBytes: bytes.length,
        keyChars: key.length,
        passLine: key.length <= URL_KEY_CHAR_LIMIT,
      });
    }
    console.log(
      [
        'P10 产线管线实测（pako 1.0.11，deflate level 9，canonical JSON）：',
        '档位(段) | canonical JSON 字符 | deflate 字节 | 密钥字符(base64url) | ≤1500',
        ...rows.map(
          (r) =>
            `${r.segments} | ${r.canonicalJsonChars} | ${r.deflateBytes} | ${r.keyChars} | ${r.passLine ? '是' : '否'}`,
        ),
      ].join('\n'),
    );
    expect(rows.length).toBe(TIERS.length);
  });

  it('密钥长度随段数单调不减（压缩管线行为 sanity）', () => {
    const lens = TIERS.map((n) => keyLength(encodeConfig(buildConfig(n))));
    for (let i = 1; i < lens.length; i++) {
      expect(lens[i]).toBeGreaterThanOrEqual(lens[i - 1]);
    }
  });

  it('ADR-001 P10 数值回归锁（产线管线实测 2026-11-03：50 段 1271、80 段 1852）', () => {
    // pako 按 ADR-003 锁死 1.0.11，压缩产物确定可复现；若此处断言失败，
    // 说明压缩管线或典型配置构造被改动，须同步重跑实测并回填 ADR-001。
    const len50 = keyLength(encodeConfig(buildConfig(50)));
    const len80 = keyLength(encodeConfig(buildConfig(80)));
    expect(len50).toBe(1271);
    expect(len50).toBeLessThanOrEqual(URL_KEY_CHAR_LIMIT);
    expect(len80).toBe(1852);
    expect(len80).toBeGreaterThan(URL_KEY_CHAR_LIMIT);
  });
});
