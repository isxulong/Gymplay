/**
 * L2 · PlayPlan 编译：segments + sequence → 播放时间轴（纯函数）。
 *
 * 定稿 §2.4 sequence 语义（重定义）：
 * - 播放队列 = sequence 中过滤 inQueue=true 的项；
 * - 同一 id 可重复出现（同段练两遍），每次出现编译为独立队列项；
 * - 取消勾选（inQueue=false）不改动 sequence，「恢复原位」由翻转 inQueue 天然实现；
 * - sequence 为空或全部 inQueue=false → 队列空 → 播放禁用。
 * loop.count 仅 mode="queue" 有效；0 = 无限循环（schema 已归一）。
 */

import type { PlayerConfig } from '../config/schema';

export interface PlannedItem {
  segmentId: string;
  label: string;
  /** 段在视频时间轴上的区间（秒） */
  start: number;
  end: number;
  rate: number;
  /** 在 sequence 中的原始下标（重复段据此区分） */
  sequenceIndex: number;
}

export interface PlayPlan {
  items: PlannedItem[];
  loop: {
    mode: 'off' | 'queue' | 'segment';
    /** 队列循环次数；0 = 无限。segment/off 模式下恒为 0（不参与语义）。 */
    count: number;
  };
}

export function compilePlan(cfg: PlayerConfig): PlayPlan {
  const byId = new Map(cfg.segments.map((s) => [s.id, s]));
  const items: PlannedItem[] = [];
  cfg.sequence.forEach((id, sequenceIndex) => {
    const seg = byId.get(id);
    if (!seg) return; // schema 校验保证不发生；防御性跳过
    if (!seg.inQueue) return; // 勾选过滤
    items.push({
      segmentId: seg.id,
      label: seg.label,
      start: seg.start,
      end: seg.end,
      rate: seg.rate,
      sequenceIndex,
    });
  });
  return {
    items,
    loop: {
      mode: cfg.loop.mode,
      count: cfg.loop.mode === 'queue' ? (cfg.loop.count ?? 0) : 0,
    },
  };
}
