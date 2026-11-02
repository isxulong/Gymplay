/** 测试公共构造器：合法的 Schema v1 配置与变体。 */

import type { PlayerConfig, Segment } from '../../src/core/config/schema';

let idCounter = 0;

export function makeId(): string {
  // 6 位 base36
  return (idCounter++).toString(36).padStart(6, '0').slice(-6);
}

export function makeSegment(partial: Partial<Segment> = {}): Segment {
  return {
    id: partial.id ?? makeId(),
    start: partial.start ?? 0,
    end: partial.end ?? 10,
    rate: partial.rate ?? 1,
    label: partial.label ?? '',
    inQueue: partial.inQueue ?? true,
  };
}

export function makeConfig(overrides: Partial<PlayerConfig> = {}): PlayerConfig {
  const segments = overrides.segments ?? [makeSegment({ id: 'aaa000', start: 0, end: 10 })];
  return {
    v: 1,
    video: overrides.video ?? { type: 'local', filename: 'workout.mp4', duration: 60 },
    segments,
    sequence: overrides.sequence ?? segments.map((s) => s.id),
    loop: overrides.loop ?? { mode: 'off' },
    ...(overrides.meta ? { meta: overrides.meta } : {}),
  };
}

/** 结构化克隆为未知输入（模拟 JSON 反序列化产物） */
export function asRaw(cfg: unknown): unknown {
  return JSON.parse(JSON.stringify(cfg));
}
