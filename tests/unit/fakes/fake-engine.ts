/**
 * FakeEngine（测试设施，蓝图 §6.2）：记录收到的全部指令
 * （load / play / pause / seek / setRate），测试断言「指令序列正确」
 * 而非「视频真的在播」。媒体时间由测试脚本推进。
 */

import type { EngineEvent, PlayerEngine, VideoSource } from '../../../src/core/player/engine';

export type EngineOp =
  | { type: 'load'; source: VideoSource }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; seconds: number }
  | { type: 'setRate'; rate: number };

export class FakeEngine implements PlayerEngine {
  readonly ops: EngineOp[] = [];
  playing = false;
  /** 媒体时间（秒），测试脚本直接改 */
  time = 0;
  /** play() 是否表现为被拒绝（模拟 P7-A 无手势场景） */
  rejectPlay = false;

  private tickCbs = new Set<(now: number) => void>();
  private eventCbs = new Set<(e: EngineEvent) => void>();

  async load(source: VideoSource): Promise<void> {
    this.ops.push({ type: 'load', source });
  }

  async play(): Promise<void> {
    this.ops.push({ type: 'play' });
    if (this.rejectPlay) {
      this.emit({ type: 'gesture-required' });
      return;
    }
    this.playing = true;
  }

  pause(): void {
    this.ops.push({ type: 'pause' });
    this.playing = false;
  }

  seek(seconds: number): void {
    this.ops.push({ type: 'seek', seconds });
    this.time = seconds;
  }

  setRate(rate: number): void {
    this.ops.push({ type: 'setRate', rate });
  }

  getTime(): number {
    return this.time;
  }

  onTick(cb: (now: number) => void): void {
    this.tickCbs.add(cb);
  }

  onEvent(cb: (e: EngineEvent) => void): void {
    this.eventCbs.add(cb);
  }

  destroy(): void {
    this.tickCbs.clear();
    this.eventCbs.clear();
  }

  // ---- 测试脚本接口 ----------

  /** 推进媒体时间并触发一次 onTick（模拟引擎时间通道出帧）。 */
  fireTick(now: number): void {
    this.time = now;
    for (const cb of this.tickCbs) cb(now);
  }

  emit(e: EngineEvent): void {
    for (const cb of this.eventCbs) cb(e);
  }

  /** 指令序列的紧凑视图，便于断言。 */
  opSummary(): string[] {
    return this.ops.map((op) =>
      op.type === 'seek' ? `seek(${op.seconds})`
      : op.type === 'setRate' ? `setRate(${op.rate})`
      : op.type === 'load' ? `load(${op.source.filename})`
      : op.type,
    );
  }
}
