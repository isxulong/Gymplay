/**
 * L3 · 配置编辑操作（M1 编辑器的纯函数内核）。
 *
 * 全部操作：输入 PlayerConfig、输出新的 PlayerConfig（不可变更新），
 * 非法操作返回带码错误、绝不抛出；输出恒满足 schema.validate 约束
 * （segments ≥ 1、0 ≤ start < end ≤ duration、不重叠、id 唯一）。
 *
 * 口径来源：
 * - F3 AC1：播放中打点 → 以播放头位置为边界「切出」新段（split）；
 * - F3 AC2（v2 改写）：删除段后其余各段起止不变、播放队列移除其所有引用，不自动首尾相接；
 * - F3 AC3：任意操作序列后段区间不重叠、不超出视频总长（split/bounds 内强制）；
 * - F5 AC1：取消勾选不改 sequence（原位由 inQueue 翻转承载）；
 * - F8 AC5：装载视频时长与配置偏差时的钳制（clampConfigToDuration），不做比例缩放。
 */

import {
  LABEL_MAX_LENGTH,
  RATE_MAX,
  RATE_MIN,
  SCHEMA_VERSION,
  type PlayerConfig,
  type Segment,
} from './schema';

/** 段最短时长（秒）：短于此的段在打点/编辑时不可产出（避免误触碎段） */
export const MIN_SEGMENT_DURATION = 0.1;

export interface EditError {
  code:
    | 'NOT_FOUND'
    | 'TOO_SHORT'
    | 'AT_BOUNDARY'
    | 'OVERLAP'
    | 'OUT_OF_RANGE'
    | 'LAST_SEGMENT'
    | 'BAD_INDEX';
  message: string;
}

export type EditResult =
  | { ok: true; value: PlayerConfig }
  | { ok: false; error: EditError };

function fail(code: EditError['code'], message: string): EditResult {
  return { ok: false, error: { code, message } };
}

function clone(cfg: PlayerConfig): PlayerConfig {
  return structuredClone(cfg);
}

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

/** 生成配置内唯一的 6 位 base36 段 id（schema SEGMENT_ID_PATTERN）。 */
export function newSegmentId(taken: ReadonlySet<string>, rand: () => number = Math.random): string {
  for (;;) {
    let id = '';
    for (let i = 0; i < 6; i++) id += BASE36[Math.floor(rand() * 36) % 36];
    if (!taken.has(id)) return id;
  }
}

/** 导入视频后的初始配置：单个覆盖全片的段（打点即从此段切分）。 */
export function createInitialConfig(
  video: { filename: string; duration: number },
  meta?: { createdAt?: string; appVersion?: string },
  rand?: () => number,
): PlayerConfig {
  const id = newSegmentId(new Set(), rand);
  return {
    v: SCHEMA_VERSION,
    video: { type: 'local', filename: video.filename, duration: video.duration },
    segments: [{ id, start: 0, end: video.duration, rate: 1, label: '', inQueue: true }],
    sequence: [id],
    loop: { mode: 'off' },
    ...(meta ? { meta } : {}),
  };
}

function findSegment(cfg: PlayerConfig, id: string): Segment | undefined {
  return cfg.segments.find((s) => s.id === id);
}

/**
 * F3 AC1 打点：以 time 为边界把包含它的段切成左右两段。
 * 左段保留原 id / label / rate；右段新 id、继承 rate、label 置空。
 * sequence 中该段的每处引用原位替换为 [左, 右]（重复段每处都展开）。
 */
export function splitSegmentAt(cfg: PlayerConfig, time: number, rand?: () => number): EditResult {
  const seg = cfg.segments.find((s) => s.start < time && time < s.end);
  if (!seg) {
    if (cfg.segments.some((s) => s.start === time || s.end === time)) {
      return fail('AT_BOUNDARY', '该位置已是段边界');
    }
    return fail('OUT_OF_RANGE', '打点位置不在任何段内');
  }
  if (time - seg.start < MIN_SEGMENT_DURATION || seg.end - time < MIN_SEGMENT_DURATION) {
    return fail('TOO_SHORT', `距段边界不足 ${MIN_SEGMENT_DURATION}s，无法切分`);
  }
  const next = clone(cfg);
  const taken = new Set(next.segments.map((s) => s.id));
  const rightId = newSegmentId(taken, rand);
  const idx = next.segments.findIndex((s) => s.id === seg.id);
  const left = next.segments[idx];
  const right: Segment = { id: rightId, start: time, end: left.end, rate: left.rate, label: '', inQueue: left.inQueue };
  left.end = time;
  next.segments.splice(idx + 1, 0, right);
  const seq: string[] = [];
  for (const ref of next.sequence) {
    if (ref === seg.id) seq.push(left.id, rightId);
    else seq.push(ref);
  }
  next.sequence = seq;
  return { ok: true, value: next };
}

/**
 * F3 AC2 修改起止：强制 0 ≤ start < end ≤ duration、段长 ≥ MIN、与其他段不重叠
 * （端点相接合法）。段的定义顺序不变。
 */
export function updateSegmentBounds(
  cfg: PlayerConfig,
  id: string,
  start: number,
  end: number,
): EditResult {
  const seg = findSegment(cfg, id);
  if (!seg) return fail('NOT_FOUND', `段不存在：${id}`);
  if (!(Number.isFinite(start) && Number.isFinite(end)) || !(0 <= start && start < end && end <= cfg.video.duration)) {
    return fail('OUT_OF_RANGE', `需满足 0 ≤ start < end ≤ ${cfg.video.duration}`);
  }
  if (end - start < MIN_SEGMENT_DURATION) {
    return fail('TOO_SHORT', `段长不足 ${MIN_SEGMENT_DURATION}s`);
  }
  for (const other of cfg.segments) {
    if (other.id === id) continue;
    if (other.start < end && start < other.end) {
      return fail('OVERLAP', `与段 ${other.id} 区间重叠`);
    }
  }
  const next = clone(cfg);
  const target = findSegment(next, id)!;
  target.start = start;
  target.end = end;
  return { ok: true, value: next };
}

/** F3 AC2 / US-05 重命名：超过 30 字截断（schema LABEL_MAX_LENGTH）。 */
export function renameSegment(cfg: PlayerConfig, id: string, label: string): EditResult {
  if (!findSegment(cfg, id)) return fail('NOT_FOUND', `段不存在：${id}`);
  const next = clone(cfg);
  findSegment(next, id)!.label = label.slice(0, LABEL_MAX_LENGTH);
  return { ok: true, value: next };
}

/** F4 AC1 设速：钳制进协议区间 [0.5, 4]。 */
export function setSegmentRate(cfg: PlayerConfig, id: string, rate: number): EditResult {
  if (!findSegment(cfg, id)) return fail('NOT_FOUND', `段不存在：${id}`);
  const next = clone(cfg);
  findSegment(next, id)!.rate = Math.min(RATE_MAX, Math.max(RATE_MIN, rate));
  return { ok: true, value: next };
}

/**
 * F3 AC2（v2）删除段：其余段起止不变；sequence 中该段所有引用移除。
 * 最后一段不可删（segments ≥ 1 是 schema 硬约束）。
 */
export function deleteSegment(cfg: PlayerConfig, id: string): EditResult {
  if (!findSegment(cfg, id)) return fail('NOT_FOUND', `段不存在：${id}`);
  if (cfg.segments.length <= 1) return fail('LAST_SEGMENT', '至少保留一段');
  const next = clone(cfg);
  next.segments = next.segments.filter((s) => s.id !== id);
  next.sequence = next.sequence.filter((ref) => ref !== id);
  return { ok: true, value: next };
}

/** F5 AC1 勾选：只翻转 inQueue，sequence 不动（重新勾选即恢复原位）。 */
export function setInQueue(cfg: PlayerConfig, id: string, inQueue: boolean): EditResult {
  if (!findSegment(cfg, id)) return fail('NOT_FOUND', `段不存在：${id}`);
  const next = clone(cfg);
  findSegment(next, id)!.inQueue = inQueue;
  return { ok: true, value: next };
}

/** F5 AC2 拖拽排序：把 sequence[fromIndex] 移动到 toIndex。 */
export function moveSequenceEntry(cfg: PlayerConfig, fromIndex: number, toIndex: number): EditResult {
  const n = cfg.sequence.length;
  if (!(Number.isInteger(fromIndex) && Number.isInteger(toIndex)) || fromIndex < 0 || fromIndex >= n || toIndex < 0 || toIndex >= n) {
    return fail('BAD_INDEX', '队列下标越界');
  }
  const next = clone(cfg);
  const [moved] = next.sequence.splice(fromIndex, 1);
  next.sequence.splice(toIndex, 0, moved);
  return { ok: true, value: next };
}

/** 重复段：在 sequence 的 index 项后再插入一个同段引用（同段练两遍）。 */
export function duplicateSequenceEntry(cfg: PlayerConfig, index: number): EditResult {
  if (!Number.isInteger(index) || index < 0 || index >= cfg.sequence.length) {
    return fail('BAD_INDEX', '队列下标越界');
  }
  const next = clone(cfg);
  next.sequence.splice(index + 1, 0, next.sequence[index]);
  return { ok: true, value: next };
}

/** 移除单个队列项（段配置保留在段落条）。 */
export function removeSequenceEntry(cfg: PlayerConfig, index: number): EditResult {
  if (!Number.isInteger(index) || index < 0 || index >= cfg.sequence.length) {
    return fail('BAD_INDEX', '队列下标越界');
  }
  const next = clone(cfg);
  next.sequence.splice(index, 1);
  return { ok: true, value: next };
}

/** 循环设置：count 仅 mode="queue" 有效；0 / undefined = 无限循环（schema 口径）。 */
export function setLoop(cfg: PlayerConfig, mode: PlayerConfig['loop']['mode'], count?: number): EditResult {
  const next = clone(cfg);
  if (mode === 'queue' && count !== undefined && count > 0) {
    next.loop = { mode, count: Math.floor(count) };
  } else {
    next.loop = { mode };
  }
  return { ok: true, value: next };
}

export interface ClampResult {
  config: PlayerConfig;
  /** 端点被钳制的段数 */
  adjusted: number;
  /** 整段超出实际时长被移除的段数 */
  dropped: number;
}

/**
 * F8 AC5：把段边界钳制到实际视频时长（不做比例缩放——缩放会静默篡改全部打点）。
 * 整段越界的段被移除（其 sequence 引用一并移除）；全部越界时由调用方决定回退策略。
 */
export function clampConfigToDuration(cfg: PlayerConfig, actualDuration: number): ClampResult {
  const next = clone(cfg);
  let adjusted = 0;
  let dropped = 0;
  const kept: Segment[] = [];
  for (const s of next.segments) {
    if (s.start >= actualDuration) {
      dropped += 1;
      continue;
    }
    if (s.end > actualDuration) {
      s.end = actualDuration;
      adjusted += 1;
    }
    kept.push(s);
  }
  next.segments = kept;
  if (dropped > 0) {
    const alive = new Set(kept.map((s) => s.id));
    next.sequence = next.sequence.filter((ref) => alive.has(ref));
  }
  next.video = { ...next.video, duration: actualDuration };
  return { config: next, adjusted, dropped };
}
