/**
 * 载体二（P10 降级路径，M3 接线）：.json 文件导出 / 导入。
 *
 * 门禁口径（终审报告步骤 2）：
 * - >50 段配置 URL 密钥必超 1500 判定线 → 必须可走导出/导入降级；
 * - 导出→导入 round-trip 内容一致（canonicalize 相等，含重复 sequence 与循环语义）；
 * - 导入失败路径给可诊断文案、不产生半配置状态（F8 AC4 纪律）。
 */

import { describe, it, expect } from 'vitest';
import {
  exportConfig,
  importConfig,
  encodeConfig,
  canonicalize,
  URL_KEY_CHAR_LIMIT,
} from '../../../../src/core/config/codec';
import type { PlayerConfig } from '../../../../src/core/config/schema';
import { makeSegment } from '../../helpers';

/**
 * 60 段（>50 段判定线）配置：时长 3.0~3.9s 轮换、速度轮换、标签带节奏词
 * （多样内容防 deflate 高压缩比，实测密钥 1711 字符 > 1500 判定线）、
 * 末段取消勾选、队首重复引用、整列循环 ×3。
 */
function makeLargeConfig(segmentCount = 60): PlayerConfig {
  const words = ['热身', '深蹲', '硬拉', '卧推', '划船', '肩推', '弓步', '平板', '拉伸', '开合跳', '波比', '卷腹', '俯卧撑', '高抬腿'];
  const pace = ['慢速', '标准', '快节奏', '冲刺'];
  let t = 0;
  const segments = Array.from({ length: segmentCount }, (_, i) => {
    const seg = makeSegment({
      id: i.toString(36).padStart(6, '0'),
      start: t,
      end: t + 3 + (i % 10) / 10, // 时长 3.0~3.9s 轮换
      rate: [0.5, 1, 1.5, 2][i % 4],
      label: `${words[i % 14]}第${Math.floor(i / 14) + 1}组·${pace[i % 4]}`,
      inQueue: i !== segmentCount - 1,
    });
    t = seg.end;
    return seg;
  });
  return {
    v: 1,
    video: { type: 'local', filename: 'upper-body-hiit-45min.mp4', duration: t },
    segments,
    sequence: [...segments.map((s) => s.id), segments[0].id, segments[1].id],
    loop: { mode: 'queue', count: 3 },
  };
}

describe('载体二：>50 段配置的导出 / 导入（P10 降级，M3）', () => {
  it('60 段配置的 URL 密钥超 1500 判定线（降级路径的触发前提）', () => {
    const cfg = makeLargeConfig();
    const key = encodeConfig(cfg);
    expect(key.length).toBeGreaterThan(URL_KEY_CHAR_LIMIT);
  });

  it('导出产出规范化 JSON 的 .json Blob', async () => {
    const cfg = makeLargeConfig();
    const blob = exportConfig(cfg);
    expect(blob.type).toBe('application/json');
    const text = await blob.text();
    expect(JSON.parse(text)).toBeTruthy();
    // 规范化：与 canonicalize 完全一致（同一配置必产出同一字符串）
    expect(text).toBe(canonicalize(cfg));
  });

  it('导出→导入 round-trip：60 段完整还原（分段/速度/勾选/顺序/循环）', async () => {
    const cfg = makeLargeConfig();
    const restored = await importConfig(exportConfig(cfg));
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(canonicalize(restored.value)).toBe(canonicalize(cfg));
    expect(restored.value.segments).toHaveLength(60);
    expect(restored.value.sequence).toHaveLength(62); // 60 段 + 2 个重复引用
    expect(restored.value.loop).toEqual({ mode: 'queue', count: 3 });
    expect(restored.value.segments[59].inQueue).toBe(false);
  });

  it('导入非法 JSON → 可诊断错误文案', async () => {
    const res = await importConfig(new Blob(['{oops not json'], { type: 'application/json' }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.message).toContain('不是合法 JSON');
  });

  it('导入缺少版本字段 v 的 JSON → 明确报错', async () => {
    const res = await importConfig(new Blob(['{"video":{}}'], { type: 'application/json' }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.message).toContain('版本字段 v');
  });

  it('导入段区间重叠的配置 → schema 校验拒绝、不产生半配置', async () => {
    const raw = makeLargeConfig(3);
    const broken = {
      ...raw,
      segments: [
        { ...raw.segments[0], start: 0, end: 2 },
        { ...raw.segments[1], start: 1, end: 3 }, // 与上一段 [0,2] 相交
      ],
      sequence: [raw.segments[0].id, raw.segments[1].id],
    };
    const res = await importConfig(new Blob([JSON.stringify(broken)], { type: 'application/json' }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('BAD_SEGMENTS');
  });

  it('导入未来版本配置 → 后向拒绝（不静默猜解析）', async () => {
    const raw = { ...makeLargeConfig(2), v: 99 };
    const res = await importConfig(new Blob([JSON.stringify(raw)], { type: 'application/json' }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('FUTURE_VERSION');
  });
});
