/**
 * L2 · 段调度引擎：按时间轴计算「此刻应处于哪段、目标 rate 是多少」，
 * 向引擎下发 seek / setRate / play / pause 指令。
 *
 * 可测性（蓝图 §6.2）：构造即注入 PlayerEngine 与 Clock，调度逻辑不碰 DOM、
 * 不读真实时间，可全量单测（FakeEngine 断言指令序列 + FakeClock 脚本化时间线）。
 *
 * 调度主线（P3 实测结论）：
 * - 'rvfc' 模式：消费引擎 onTick（引擎内部 rVFC 主线 / timeupdate / 轮询三通道归一）；
 * - 'polling' 模式：注入 Clock 的 50ms 定时器主动轮询 engine.getTime()；
 * - 'auto'（默认）：按能力探测选择，rVFC 通道静默超过 RVFC_STALL_MS 自动降级轮询。
 *
 * P7-B 兜底（iOS 切后台音频中断）：resync() 回前台时读取引擎 currentTime
 * 重新定位段并校准续播；配合 persistence 的播放快照使用。
 */

import { chooseTickStrategy, POLL_INTERVAL_MS, RVFC_STALL_MS, type Clock } from '../player/clock';
import type { PlayerEngine } from '../player/engine';
import type { PlayPlan, PlannedItem } from './plan';

export type SchedulerDriver = 'rvfc' | 'polling';

export type SchedulerState = 'idle' | 'playing' | 'finished';

export interface SchedulerStatus {
  state: SchedulerState;
  /** 当前队列项下标（plan.items 内），无有效项时为 -1 */
  queueIndex: number;
  segmentId: string | null;
  rate: number;
  /** 当前段剩余毫秒（基于最近一次 tick 的媒体时间） */
  remainingMs: number;
  /** 已完成的整列循环遍数（loop.mode="queue" 时有意义） */
  loopsDone: number;
}

export interface SchedulerOptions {
  /** 调度驱动；缺省 'auto' 按 capabilities.rVFC 选择（P3）。 */
  driver?: 'auto' | SchedulerDriver;
  capabilities?: { rVFC: boolean };
  /** 队列播完（含循环次数耗尽）回调 */
  onFinish?: () => void;
  /** 驱动降级（rVFC → polling）回调 */
  onDegrade?: (driver: SchedulerDriver) => void;
}

const END_EPSILON = 1e-6;

export class SegmentScheduler {
  private readonly engine: PlayerEngine;
  private readonly clock: Clock;
  private readonly plan: PlayPlan;
  private readonly onFinish?: () => void;
  private readonly onDegrade?: (driver: SchedulerDriver) => void;

  private state: SchedulerState = 'idle';
  private queueIndex = -1;
  private loopsDone = 0;
  private lastTickAt: number | null = null; // 挂钟秒
  private lastMediaTime: number | null = null; // 媒体秒
  private driver: SchedulerDriver;
  private pollHandle: unknown = null;
  private watchdogHandle: unknown = null;
  private subscribed = false;

  constructor(engine: PlayerEngine, clock: Clock, plan: PlayPlan, opts: SchedulerOptions = {}) {
    this.engine = engine;
    this.clock = clock;
    this.plan = plan;
    this.onFinish = opts.onFinish;
    this.onDegrade = opts.onDegrade;
    const requested = opts.driver ?? 'auto';
    this.driver =
      requested === 'auto' ? chooseTickStrategy({ rVFC: opts.capabilities?.rVFC ?? false }) : requested;
  }

  /** 启动调度（须由用户手势触发链路调用——P7-A）。返回 false 表示队列空、播放禁用。 */
  start(): boolean {
    if (this.plan.items.length === 0) return false; // 队列空 = 播放禁用（定稿 §2.4）
    if (this.state === 'playing') return true;
    this.state = 'playing';
    this.queueIndex = 0;
    this.loopsDone = 0;
    this.applyItem(this.plan.items[0]);
    void this.engine.play();
    this.armDriver();
    return true;
  }

  stop(): void {
    this.state = 'idle';
    this.queueIndex = -1;
    this.disarmDriver();
  }

  current(): SchedulerStatus {
    const item = this.currentItem();
    const remainingSec =
      item !== null && this.lastMediaTime !== null
        ? Math.max(0, item.end - this.lastMediaTime) / item.rate
        : 0;
    return {
      state: this.state,
      queueIndex: this.queueIndex,
      segmentId: item?.segmentId ?? null,
      rate: item?.rate ?? 1,
      remainingMs: Math.round(remainingSec * 1000),
      loopsDone: this.loopsDone,
    };
  }

  /** 当前实际驱动（降级后变化，测试与 UI 提示用）。 */
  currentDriver(): SchedulerDriver {
    return this.driver;
  }

  /**
   * 边界 seek：跳转到视频时间轴任意点，调度器重新定位所属队列项。
   * 落在段外（缝隙 / 越界）时按方向归位；越过末尾按 loop 语义处理。
   */
  seek(seconds: number): void {
    if (this.state !== 'playing') return;
    const idx = this.locateItem(seconds);
    if (idx === null) {
      this.advancePastEnd();
      return;
    }
    this.queueIndex = idx;
    const item = this.plan.items[idx];
    this.engine.setRate(item.rate);
    this.engine.seek(Math.min(Math.max(seconds, item.start), item.end));
    this.lastMediaTime = seconds;
  }

  /**
   * P7-B 播放恢复：回前台 / 异常中断后校准。
   * 读取引擎 currentTime：漂移出当前段 → 重新定位并 seek；随后重申速率并续播。
   */
  resync(): void {
    if (this.state !== 'playing') return;
    const now = this.engine.getTime();
    const item = this.currentItem();
    if (item === null) return;
    if (!(item.start - END_EPSILON <= now && now < item.end)) {
      const idx = this.locateItem(now);
      if (idx === null) {
        this.advancePastEnd();
        return;
      }
      this.queueIndex = idx;
      const target = this.plan.items[idx];
      this.engine.seek(Math.min(Math.max(now, target.start), target.end));
    }
    this.engine.setRate(this.plan.items[this.queueIndex].rate);
    void this.engine.play();
  }

  /** 手动降级到轮询兜底（能力变化或 rVFC 异常时由上层调用）。 */
  degradeToPolling(): void {
    if (this.driver === 'polling') return;
    this.driver = 'polling';
    if (this.state === 'playing') this.armDriver();
    this.onDegrade?.(this.driver);
  }

  // ---------- 内部 ----------

  private currentItem(): PlannedItem | null {
    if (this.queueIndex < 0 || this.queueIndex >= this.plan.items.length) return null;
    return this.plan.items[this.queueIndex];
  }

  private applyItem(item: PlannedItem): void {
    this.engine.setRate(item.rate);
    this.engine.seek(item.start);
    this.lastMediaTime = item.start;
  }

  private armDriver(): void {
    this.disarmDriver();
    if (this.driver === 'rvfc') {
      if (!this.subscribed) {
        this.engine.onTick((now) => this.tick(now));
        this.subscribed = true;
      }
      this.lastTickAt = this.clock.now();
      // rVFC 静默看门狗：超过 RVFC_STALL_MS 无 tick → 降级轮询（P3 兜底语义）
      this.watchdogHandle = this.clock.setInterval(() => {
        if (this.lastTickAt !== null && this.clock.now() - this.lastTickAt > RVFC_STALL_MS / 1000) {
          this.degradeToPolling();
        }
      }, POLL_INTERVAL_MS);
    } else {
      this.pollHandle = this.clock.setInterval(() => {
        this.tick(this.engine.getTime());
      }, POLL_INTERVAL_MS);
    }
  }

  private disarmDriver(): void {
    if (this.pollHandle !== null) {
      this.clock.clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    if (this.watchdogHandle !== null) {
      this.clock.clearInterval(this.watchdogHandle);
      this.watchdogHandle = null;
    }
  }

  private tick(now: number): void {
    if (this.state !== 'playing') return;
    this.lastTickAt = this.clock.now();
    this.lastMediaTime = now;
    const item = this.currentItem();
    if (item === null) return;
    if (now + END_EPSILON >= item.end) this.advance();
  }

  private advance(): void {
    const item = this.currentItem();
    if (item === null) return;
    if (this.plan.loop.mode === 'segment') {
      // 单段循环：当前段播完自动重播（承接 F5 AC3）
      this.applyItem(item);
      return;
    }
    const next = this.queueIndex + 1;
    if (next < this.plan.items.length) {
      this.queueIndex = next;
      this.applyItem(this.plan.items[next]);
      return;
    }
    this.advancePastEnd();
  }

  private advancePastEnd(): void {
    if (this.plan.loop.mode === 'queue') {
      this.loopsDone += 1;
      const limit = this.plan.loop.count;
      if (limit <= 0 || this.loopsDone < limit) {
        this.queueIndex = 0;
        this.applyItem(this.plan.items[0]);
        return;
      }
    }
    this.state = 'finished';
    this.disarmDriver();
    this.engine.pause();
    this.onFinish?.();
  }

  /** 定位包含媒体时间 t 的队列项；从当前项起正向优先（重复段保持播放顺序）。 */
  private locateItem(t: number): number | null {
    const n = this.plan.items.length;
    if (n === 0) return null;
    for (let step = 0; step < n; step++) {
      const idx = (Math.max(this.queueIndex, 0) + step) % n;
      const item = this.plan.items[idx];
      if (item.start - END_EPSILON <= t && t < item.end) return idx;
    }
    // 缝隙：落到下一个尚未开始的段；全部已过 → null（越界）
    for (let i = 0; i < n; i++) {
      if (t < this.plan.items[i].start) return i;
    }
    return null;
  }
}
