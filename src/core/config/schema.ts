/**
 * L3 · 配置 Schema v1（字段级冻结，见 docs/adr/0004-schema-v1.md）
 *
 * 字段定义以《综合方案修订定稿 v2》§2.4 为唯一权威口径：
 * - v 恒为 1；video.type 仅 "local"；
 * - segments[].inQueue 缺省 true（false = 取消勾选，配置保留、不进播放队列）；
 * - sequence 为队列顺序定义、可重复引用；空数组或全部 inQueue=false = 队列空 = 播放禁用
 *   （原「空数组 = 按定义顺序全播」缺省已废除）；
 * - loop.mode 三态 "off" | "queue" | "segment"；loop.count 仅 mode="queue" 有效，缺省或 0 = 无限循环。
 * 所有时间单位为秒（number，毫秒精度）。
 */

export const SCHEMA_VERSION = 1 as const;

export const RATE_MIN = 0.5;
export const RATE_MAX = 4;
export const LABEL_MAX_LENGTH = 30;
/** 段标识：配置内唯一，6 位 base36 */
export const SEGMENT_ID_PATTERN = /^[0-9a-z]{6}$/;

export type LoopMode = 'off' | 'queue' | 'segment';

export interface Segment {
  id: string;
  start: number;
  end: number;
  rate: number;
  label: string;
  inQueue: boolean;
}

export interface PlayerConfig {
  v: typeof SCHEMA_VERSION;
  video: {
    type: 'local';
    /** 仅作「请重新选择 xxx.mp4」提示，不做文件匹配依据 */
    filename: string;
    /** 视频总时长（秒），> 0 */
    duration: number;
  };
  segments: Segment[];
  /** 段 id 的有序引用，可重复；播放队列 = sequence 中过滤 inQueue=true 的项 */
  sequence: string[];
  loop: {
    mode: LoopMode;
    /** 仅 mode="queue" 有效；缺省或 0 = 无限循环 */
    count?: number;
  };
  meta?: {
    createdAt?: string;
    appVersion?: string;
  };
}

export interface SchemaError {
  code:
    | 'NOT_AN_OBJECT'
    | 'BAD_VERSION'
    | 'FUTURE_VERSION'
    | 'BAD_VIDEO'
    | 'BAD_SEGMENTS'
    | 'BAD_SEQUENCE'
    | 'BAD_LOOP'
    | 'BAD_META';
  message: string;
}

export type Result<T, E = SchemaError> =
  | { ok: true; value: T; warnings: string[] }
  | { ok: false; error: E };

function fail<T>(code: SchemaError['code'], message: string): Result<T> {
  return { ok: false, error: { code, message } };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * 校验并规范化一份未知输入为 PlayerConfig。
 * - 缺省补齐：label → ''、inQueue → true；
 * - 前向宽容：不认识的字段一律忽略并记入 warnings（版本演进五条 · 第 2 条）；
 * - 后向拒绝：v 大于当前支持版本时明确报错（第 3 条；FUTURE_VERSION 主要由 migrate 层产生，
 *   这里同样兜底）。
 */
export function validate(raw: unknown): Result<PlayerConfig> {
  const warnings: string[] = [];
  if (!isRecord(raw)) return fail('NOT_AN_OBJECT', '配置不是 JSON 对象');

  // v
  if (raw.v !== SCHEMA_VERSION) {
    if (typeof raw.v === 'number' && Number.isInteger(raw.v) && raw.v > SCHEMA_VERSION) {
      return fail('FUTURE_VERSION', '该密钥由更新版本生成，请升级应用');
    }
    return fail('BAD_VERSION', 'v 必须为整数 1');
  }

  // video
  if (!isRecord(raw.video)) return fail('BAD_VIDEO', 'video 缺失或不是对象');
  const videoRaw = raw.video;
  if (videoRaw.type !== 'local') return fail('BAD_VIDEO', 'video.type 仅支持 "local"');
  if (typeof videoRaw.filename !== 'string') return fail('BAD_VIDEO', 'video.filename 必须为字符串');
  if (!isFiniteNumber(videoRaw.duration) || videoRaw.duration <= 0) {
    return fail('BAD_VIDEO', 'video.duration 必须为 > 0 的秒数');
  }
  for (const k of Object.keys(videoRaw)) {
    if (!['type', 'filename', 'duration'].includes(k)) warnings.push(`忽略未知字段 video.${k}`);
  }

  // segments
  if (!Array.isArray(raw.segments) || raw.segments.length < 1) {
    return fail('BAD_SEGMENTS', 'segments 必须至少包含 1 段');
  }
  const duration = videoRaw.duration;
  const seenIds = new Set<string>();
  const segments: Segment[] = [];
  for (let i = 0; i < raw.segments.length; i++) {
    const s: unknown = raw.segments[i];
    if (!isRecord(s)) return fail('BAD_SEGMENTS', `segments[${i}] 不是对象`);
    if (typeof s.id !== 'string' || !SEGMENT_ID_PATTERN.test(s.id)) {
      return fail('BAD_SEGMENTS', `segments[${i}].id 必须为 6 位 base36 短串`);
    }
    if (seenIds.has(s.id)) return fail('BAD_SEGMENTS', `段 id 重复：${s.id}`);
    seenIds.add(s.id);
    if (!isFiniteNumber(s.start) || !isFiniteNumber(s.end)) {
      return fail('BAD_SEGMENTS', `segments[${i}].start/end 必须为数字`);
    }
    if (!(0 <= s.start && s.start < s.end && s.end <= duration)) {
      return fail('BAD_SEGMENTS', `segments[${i}] 需满足 0 ≤ start < end ≤ video.duration`);
    }
    if (!isFiniteNumber(s.rate) || s.rate < RATE_MIN || s.rate > RATE_MAX) {
      return fail('BAD_SEGMENTS', `segments[${i}].rate 需在 ${RATE_MIN}~${RATE_MAX} 之间`);
    }
    let label = '';
    if (s.label !== undefined) {
      if (typeof s.label !== 'string') return fail('BAD_SEGMENTS', `segments[${i}].label 必须为字符串`);
      if (s.label.length > LABEL_MAX_LENGTH) {
        return fail('BAD_SEGMENTS', `segments[${i}].label 超过 ${LABEL_MAX_LENGTH} 字`);
      }
      label = s.label;
    }
    let inQueue = true;
    if (s.inQueue !== undefined) {
      if (typeof s.inQueue !== 'boolean') {
        return fail('BAD_SEGMENTS', `segments[${i}].inQueue 必须为布尔值`);
      }
      inQueue = s.inQueue;
    }
    for (const k of Object.keys(s)) {
      if (!['id', 'start', 'end', 'rate', 'label', 'inQueue'].includes(k)) {
        warnings.push(`忽略未知字段 segments[${i}].${k}`);
      }
    }
    segments.push({ id: s.id, start: s.start, end: s.end, rate: s.rate, label, inQueue });
  }

  // sequence
  if (!Array.isArray(raw.sequence)) return fail('BAD_SEQUENCE', 'sequence 必须为数组');
  const sequence: string[] = [];
  for (const ref of raw.sequence) {
    if (typeof ref !== 'string' || !seenIds.has(ref)) {
      return fail('BAD_SEQUENCE', `sequence 引用了不存在的段 id：${String(ref)}`);
    }
    sequence.push(ref);
  }

  // loop
  if (!isRecord(raw.loop)) return fail('BAD_LOOP', 'loop 缺失或不是对象');
  const mode = raw.loop.mode;
  if (mode !== 'off' && mode !== 'queue' && mode !== 'segment') {
    return fail('BAD_LOOP', 'loop.mode 必须为 "off" | "queue" | "segment"');
  }
  let count: number | undefined;
  if (raw.loop.count !== undefined) {
    if (typeof raw.loop.count !== 'number' || !Number.isInteger(raw.loop.count) || raw.loop.count < 0) {
      return fail('BAD_LOOP', 'loop.count 必须为 ≥0 的整数');
    }
    if (mode !== 'queue') {
      warnings.push('loop.count 仅 mode="queue" 有效，已忽略');
    } else {
      count = raw.loop.count;
    }
  }
  for (const k of Object.keys(raw.loop)) {
    if (!['mode', 'count'].includes(k)) warnings.push(`忽略未知字段 loop.${k}`);
  }

  // meta（仅展示用途；未知子字段不影响校验）
  let meta: PlayerConfig['meta'];
  if (raw.meta !== undefined) {
    if (!isRecord(raw.meta)) return fail('BAD_META', 'meta 必须为对象');
    meta = {};
    if (raw.meta.createdAt !== undefined) {
      if (typeof raw.meta.createdAt !== 'string') return fail('BAD_META', 'meta.createdAt 必须为字符串');
      meta.createdAt = raw.meta.createdAt;
    }
    if (raw.meta.appVersion !== undefined) {
      if (typeof raw.meta.appVersion !== 'string') return fail('BAD_META', 'meta.appVersion 必须为字符串');
      meta.appVersion = raw.meta.appVersion;
    }
    for (const k of Object.keys(raw.meta)) {
      if (!['createdAt', 'appVersion'].includes(k)) warnings.push(`忽略未知字段 meta.${k}`);
    }
  }

  // 顶层未知字段
  for (const k of Object.keys(raw)) {
    if (!['v', 'video', 'segments', 'sequence', 'loop', 'meta'].includes(k)) {
      warnings.push(`忽略未知字段 ${k}`);
    }
  }

  const value: PlayerConfig = {
    v: SCHEMA_VERSION,
    video: { type: 'local', filename: videoRaw.filename, duration },
    segments,
    sequence,
    loop: count === undefined ? { mode } : { mode, count },
  };
  if (meta !== undefined) value.meta = meta;
  return { ok: true, value, warnings };
}
