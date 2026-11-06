/**
 * L4 · 应用控制器（编辑器 + 驾驶舱共用）：store + persistence + engine + scheduler 的接线层。
 *
 * 职责：
 * - 视频装载（L0 sources 探测 → L1 NativeEngine 装载，F1/F9/F8 AC5 时长校验）；
 * - 编辑动作入口（全部经 L3 edit 纯函数产出新配置，再 commit）；
 * - 自动保存（任何生效配置变更 → 防抖保存；页面隐藏 → 立即保存 + 播放快照）；
 * - 队列播放（L2 SegmentScheduler，P7-B 回前台 resync 校准续播）；
 * - 密钥生成 / 导入 / 冲突裁决（F7 AC3、F8 AC1/AC4、P10 超限提示）；
 * - 驾驶舱（M2）：模式切换、三大按钮（上一段/暂停继续/下一段）、线控映射
 *   （Media Session play/pause/nexttrack/previoustrack，缺失时 R13 降级提示）、
 *   Wake Lock 练时常亮（P11，失败时文案 D 一次性提示）、循环热切换（setLoopLive）。
 *
 * 草稿态纪律（F7 AC3）：pendingKeyConfig 存在时，编辑作用于草稿、不写本地存储；
 * 「应用」后草稿转正并落盘，「保留我的」丢弃草稿。两态共用同一组编辑入口。
 */

import {
  encodeConfig,
  decodeKey,
  canonicalize,
  URL_KEY_CHAR_LIMIT,
  COPY_KEY_INVALID,
  exportConfig as buildConfigFileBlob,
  importConfig as parseConfigFile,
} from '../core/config/codec';
import { buildHashWithKey, extractKeyFromHash, writeKeyToLocation } from '../core/config/hash';
import type { Persistence } from '../core/config/persistence';
import {
  clampVolume,
  createVolumePrefsStore,
  type VolumePrefs,
} from '../core/config/volume';
import {
  clampConfigToDuration,
  createInitialConfig,
  deleteSegment,
  duplicateSequenceEntry,
  moveSequenceEntry,
  removeSequenceEntry,
  renameSegment,
  setInQueue,
  setLoop,
  setSegmentRate,
  splitSegmentAt,
  updateSegmentBounds,
  type EditResult,
} from '../core/config/edit';
import type { PlayerConfig } from '../core/config/schema';
import { validate } from '../core/config/schema';
import { systemClock } from '../core/player/clock';
import type { PlayerEngine } from '../core/player/engine';
import { createNativeEngine } from '../core/player/native-engine';
import { compilePlan, type PlayPlan } from '../core/scheduler/plan';
import { SegmentScheduler } from '../core/scheduler/scheduler';
import { createMediaSession, type MediaSessionController } from '../platform/media-session';
import {
  canPlayTypeProbe,
  loadLocalSource,
  COPY_LOAD_FAILED,
  type SourceLoadResult,
} from '../platform/sources';
import { createWakeLock, type WakeLockController } from '../platform/wake-lock';
import { makeNotice } from './bootstrap';
import {
  createNoticeCenter,
  pruneInfos,
  resolveNoticeTiming,
  NOTICE_INFO_CAP,
} from './notice-center';
import {
  isEntryApplicable,
  isEntryDamagedReason,
  isUndoEntryOversized,
  makeBreakRecord,
  markStaleFrom,
  pushUndoEntry,
  saveUndoStack,
  undoCounts,
  undoEntryBytes,
  undoGateFor,
  UNDO_STORAGE_KEY,
  type UndoBreakKind,
  type UndoBreakRecord,
  type UndoEntry,
  type UndoKind,
} from './undo-store';
import type { AppState, Notice, NoticeKind } from './state';
import type { Store } from './store';

/** 文案 E（定稿 §1.2 / F8 AC5，>1s 偏差） */
export const COPY_VIDEO_MISMATCH =
  '导入的视频与这份编排记录的长度不一致，可能不是同一份视频。段边界已按实际长度调整，请核对后再练。';
/** 文案 E 话术的信息级复用（F8 AC5，≤1s 钳制） */
export const COPY_BOUNDARY_CLAMPED = '段边界已按实际长度调整，请核对后再练。';
/** F1 AC3 确认语（v0.3.2 · D-4 补偿：追加「且无法撤销」——replace 清空不可复原） */
export const COPY_REPLACE_CONFIRM = '导入新视频将清空当前分段配置，且无法撤销';
/** P10 结论：URL 密钥超 1500 判定线（>50 段）→ M3 起引导走 .json 导出/导入降级，不生成不可用长链 */
export const COPY_KEY_TOO_LONG =
  '当前配置段数较多，生成的链接超过 1500 字符上限，在部分分享渠道可能被截断而无法还原。请改用「导出配置」生成 .json 文件发送给练友；配置已自动保存在本机。';
/** 接收方引导（需求稿文案 B2）：打开分享链接后、导入视频前 */
export const COPY_KEY_RECEIVER_GUIDE =
  '你收到的是一份「训练编排」，不包含视频。请从本机导入同一份视频文件——导入后，分段、速度和顺序会自动套好，直接开练。';
/** HEVC 直读提示（P9 结论：不引导转码，仅提示） */
export const COPY_HEVC_PASSTHROUGH = '检测到 HEVC 编码视频，当前浏览器可直读，已直接装载。';

const SNAPSHOT_INTERVAL_MS = 1000;

/**
 * v0.3.3 · 项3 · N-1：试听项在 sequence 中的原始下标（**禁止 −1 哨兵**）。
 *
 * 背景：`cfg.sequence.indexOf(seg.id)` 在「段已被移出队列」时返回 −1，而下游
 * （`PlannedItem.sequenceIndex`，plan.ts L22 契约「在 sequence 中的原始下标」）
 * 会把它当合法下标使用——试听一个已不勾选 / 已移出队列的段时出现非法值。
 *
 * 语义定案（方案 §2.3 第 7 条）：序号必须有定义，不得出现 −1。这里分两段：
 * ① 段在 sequence 中 → 取真实下标（≥0，重复段据此区分）；
 * ② 段不在 sequence 中（队列里没有它）→ 兜底取该段在 `cfg.segments` 中的下标（≥0，
 *    段必然存在，否则调用方已提前 return）；该值属于「段列表下标空间」，与 ① 的下标空间
 *    不同，调用方若需要区分语义请看 `queued` 标志，不要把两者当同一个坐标系比较。
 *
 * 纯函数、不抛异常：入参非法时也返回 ≥0 的值。
 */
export function resolveAuditionSequenceIndex(
  cfg: PlayerConfig,
  segId: string,
): { sequenceIndex: number; queued: boolean } {
  const seqIdx = cfg.sequence.indexOf(segId);
  if (seqIdx >= 0) return { sequenceIndex: seqIdx, queued: true };
  const segIdx = cfg.segments.findIndex((s) => s.id === segId);
  // 段不在 segments 中（调用方已校验过存在，这里只作防御）：落到 0（有定义，非 −1）
  return { sequenceIndex: segIdx >= 0 ? segIdx : 0, queued: false };
}

export interface QueueFrame {
  playing: boolean;
  /** 引擎暂停中（调度器仍在运行，驾驶舱大按钮据此切换图标） */
  paused: boolean;
  queueIndex: number;
  queueTotal: number;
  segmentId: string | null;
  rate: number;
  remainingMs: number;
  loopsDone: number;
  /**
   * v0.3.2 · 项9：试听态随帧下发（BA-F-4：queueFrame 恒读队列调度器，
   * 试听期不误读队列数据；audit 态由 emitFrame 单独填充）。
   */
  auditSegmentId: string | null;
  auditRate: number;
}

/**
 * v0.3.2 · 项7：播放模式（G-1 状态机）。
 * idle = 未播 / 已停；preview = 编辑器自由预览（恒 1x，F7′）；
 * queue = 队列有界播放（恒段值）；audit = 单段试听（Phase 4 落地）。
 */
export type PlayMode = 'idle' | 'preview' | 'queue' | 'audit';

/** v0.3.2 · 项9：transport ▶/⏸ 的模式感知决策结果（纯函数矩阵，play-mode.test 覆盖） */
export type ResolvedPlayAction = 'pause' | 'resume' | 'preview-play' | 'preview-pause';

/**
 * v0.3.2 · 项7+项9：transport ▶/⏸ 模式感知（矩阵 #1）。
 * queue / audit = 有界播放暂停续播（rate 保持段值，不退出）；
 * idle / preview = 自由预览起播（显式归 1x，F7′）或暂停。
 */
export function resolvePlayAction(mode: PlayMode, videoPaused: boolean): ResolvedPlayAction {
  if (mode === 'queue' || mode === 'audit') return videoPaused ? 'resume' : 'pause';
  return videoPaused ? 'preview-play' : 'preview-pause';
}

export interface EditorController {
  importFile(file: File): Promise<void>;
  confirmReplace(accept: boolean): Promise<void>;
  togglePlay(): void;
  seekPreview(seconds: number): void;
  /** v0.3.1 · R1：播放头步进（±1s / ±0.1s 步进按钮），钳制在 [0, duration]。 */
  nudgePreview(deltaSec: number): void;
  mark(): void;
  selectSegment(id: string): void;
  /** v0.3.2 · 项8：收起详情 sheet（仅清除 selectedSegmentId；不改播放状态与速率）。 */
  deselectSegment(): void;
  /** v0.3.2 · 项9：单段试听（幂等重建：同段再点回段首、速率刷新段值；与队列互斥） */
  startAudition(id: string): void;
  /** v0.3.2 · 项9：停止试听（速率归 1、模式回 idle；不 seek、不改选中态） */
  exitAudition(): void;
  setRate(id: string, rate: number): void;
  rename(id: string, label: string): void;
  /** v0.3.1 起返回是否提交成功（非法 / 越界 / 重叠 → false，供 UI 恢复原值）。 */
  setBounds(id: string, start: number, end: number): boolean;
  removeSegment(id: string): void;
  toggleQueue(id: string, inQueue: boolean): void;
  moveEntry(from: number, to: number): void;
  duplicateEntry(index: number): void;
  removeEntry(index: number): void;
  setLoopMode(mode: PlayerConfig['loop']['mode'], count?: number): void;
  /**
   * v0.3.2 · 项2+10 / v0.3.3 · 项3：恢复一次删除。
   * 门禁判定对象是**被点击的条目**（不再比栈顶）：该条指纹与当前一致 → 直接恢复；
   * 不一致 → 落到 `state.undoConfirm` 走恢复前显式确认，确认后把被覆盖的当前配置
   * 存成一条反向记录（可再撤回）。entryId = UndoEntry.id
   */
  undoDelete(entryId: number): void;
  /** v0.3.3 · 项3：确认「会一并回退其它改动」的恢复（消费 state.undoConfirm） */
  confirmUndo(): void;
  /** v0.3.3 · 项3：取消恢复前确认（不清栈、不改配置） */
  cancelUndo(): void;
  /** v0.3.2 · 项2+10：关闭撤销横幅（栈保留，回收站仍可恢复） */
  dismissUndo(): void;
  /** v0.3.2 · 项2+10：打开 / 关闭回收站弹层 */
  openRecycle(): void;
  closeRecycle(): void;
  playQueue(): void;
  stopQueue(): void;
  /** M2 驾驶舱：进入（自动从队列头开播；已在播则直接切入） */
  enterCockpit(): void;
  /** M2 驾驶舱：退出（停止队列播放，回编辑器） */
  exitCockpit(): void;
  /** 大按钮：暂停 / 继续（播完或未开播时从头开播） */
  cockpitToggle(): void;
  /** 大按钮 / 线控双击：下一段 */
  cockpitNext(): void;
  /** 大按钮 / 线控：上一段 */
  cockpitPrev(): void;
  /** 驾驶舱循环热切换：落盘 + 调度器就地更新，不打断当前段播放 */
  setLoopLive(mode: PlayerConfig['loop']['mode'], count?: number): void;
  /** 关闭驾驶舱一次性提示（文案 D / R13 降级） */
  dismissHint(kind: 'wakeLock' | 'lineControl'): void;
  openShare(): void;
  confirmShare(): void;
  closeShare(): void;
  copyShareLink(): Promise<boolean>;
  importKeyText(text: string): void;
  /** M3 · 载体二（P10 降级）：当前配置导出为 .json 文件下载 */
  exportConfigFile(): boolean;
  /** M3 · 载体二：从 .json 配置文件导入（与 URL 密钥共用校验链与草稿纪律） */
  importConfigFile(file: Blob): Promise<void>;
  applyDraft(): void;
  discardDraft(): void;
  notify(kind: NoticeKind, text: string): void;
  dismissNotice(id: number): void;
  /** v0.3.2 · 项1：通知 hover/focus 区域级暂停与恢复（编辑器事件委托调用） */
  pauseNoticeTimers(): void;
  resumeNoticeTimers(): void;
  /** v0.3.1 · R2：设置音量（0..1，钳制），按设备记忆（localStorage，不进分享密钥）。 */
  setVolume(volume: number): void;
  /** v0.3.1 · R2：静音切换；取消静音后音量保持原值。 */
  setMuted(muted: boolean): void;
  /** v0.3.1 · R2：当前音量偏好（UI 初始化滑杆 / 图标）。 */
  getVolumePrefs(): VolumePrefs;
  /** 播放头 / 队列状态帧回调（驱动播放头与状态行，不经 store） */
  onFrame(cb: (timeSec: number, queue: QueueFrame) => void): void;
  destroy(): void;
}

export function createEditorController(opts: {
  store: Store<AppState>;
  persistence: Persistence;
  video: HTMLVideoElement;
  /** v0.3.2 · 项7：测试注入引擎（单测 FakeEngine 指令序列断言）；缺省创建 NativeEngine。 */
  engine?: PlayerEngine;
}): EditorController {
  const { store, persistence, video } = opts;
  const caps = store.get().capabilities;
  const engine: PlayerEngine = opts.engine ?? createNativeEngine(video, {
    rVFC: caps?.rVFC ?? false,
    rateRange: caps?.rateRange,
  });

  // v0.3.1 · R2 音量偏好：按设备记忆（localStorage 键 gymplay:volume），
  // 不进分享密钥 / .json 导出；存储降级时静默回退会话内生效（R2 AC6）。
  const volumeStore = createVolumePrefsStore();
  let volumePrefs: VolumePrefs = volumeStore.load();
  engine.setVolume(volumePrefs.volume);
  engine.setMuted(volumePrefs.muted);

  let scheduler: SegmentScheduler | null = null;
  // v0.3.2 · 项7：播放模式（G-1）——与 scheduler 同生命周期维护，驱动 togglePlay 模式感知
  let playMode: PlayMode = 'idle';
  // v0.3.2 · 项9：试听调度器与单段 plan（audit 态运行时，不进配置/密钥/播放快照）。
  // plan 引用被 scheduler 持有，矩阵 #6 热更新即就地改 items[0].rate（current()/resync 读 item.rate）
  let auditScheduler: SegmentScheduler | null = null;
  let auditPlan: PlayPlan | null = null;
  let objectUrlRevoke: (() => void) | null = null;
  let pendingReplaceFile: File | null = null;
  let lastSnapshotAt = 0;
  const frameCbs = new Set<(timeSec: number, queue: QueueFrame) => void>();

  // ---------- M2 驾驶舱：Wake Lock + Media Session（线控） ----------

  // Wake Lock（P11）：实例常驻，锁随驾驶舱播放状态请求/释放；
  // API 缺失或请求被拒 → 静默降级 + 一次性文案 D（定稿 §1.2，驾驶舱顶部）
  const wakeLock: WakeLockController = createWakeLock();
  // Media Session（线控）：随驾驶舱进入创建、退出销毁（避免劫持编辑器播放）
  let mediaSession: MediaSessionController | null = null;
  // 一次性提示的会话级去重（「顶部一次性提示」，定稿 §1.1 F6 AC5）
  const hintShown = { wakeLock: false, lineControl: false };
  let lastMetaSegmentId: string | null = null;

  wakeLock.onUnavailable(() => {
    if (!hintShown.wakeLock) {
      hintShown.wakeLock = true;
      store.update({ wakeLockHint: true });
    }
  });

  /** 驾驶舱播放中持有常亮锁；暂停/停止/退出即释放（F6 AC5「播放期间」口径）。 */
  function syncWakeLock(): void {
    const st = store.get();
    if (st.mode === 'cockpit' && st.queuePlaying && video.paused === false) {
      void wakeLock.request();
    } else {
      void wakeLock.release();
    }
  }

  function bindMediaSession(): void {
    mediaSession = createMediaSession({
      onPlay: () => resumeCockpit(),
      onPause: () => pauseCockpit(),
      onNext: () => cockpitNext(),
      onPrevious: () => cockpitPrev(),
    });
    if (!mediaSession.supported && !hintShown.lineControl) {
      // R13 降级路径：平台不支持线控 → 一次性提示，跳段用大按钮
      hintShown.lineControl = true;
      store.update({ lineControlHint: true });
    }
  }

  function unbindMediaSession(): void {
    mediaSession?.destroy();
    mediaSession = null;
    lastMetaSegmentId = null;
  }

  /** 下一段（驾驶舱大按钮 / 线控双击 nexttrack 共用） */
  function cockpitNext(): void {
    if (!scheduler || !store.get().queuePlaying) return;
    scheduler.next();
    emitFrame();
  }

  /** 上一段（驾驶舱大按钮 / 线控 previoustrack 共用） */
  function cockpitPrev(): void {
    if (!scheduler || !store.get().queuePlaying) return;
    scheduler.prev();
    emitFrame();
  }

  function pauseCockpit(): void {
    if (!store.get().queuePlaying || video.paused) return;
    engine.pause();
    mediaSession?.setPlaybackState('paused');
    syncWakeLock();
    emitFrame();
  }

  function resumeCockpit(): void {
    const st = store.get();
    if (!st.videoReady) return;
    if (!st.queuePlaying) {
      // 播完 / 未开播 → 从头开播
      if (startQueue()) {
        mediaSession?.setPlaybackState('playing');
        syncWakeLock();
      }
      return;
    }
    if (video.paused) {
      void engine.play();
      mediaSession?.setPlaybackState('playing');
      syncWakeLock();
      emitFrame();
    }
  }

  /** 启动队列（内部）：成功返回 true。供编辑器「播放队列」与驾驶舱进入/续播共用。 */
  function startQueue(): boolean {
    const st = store.get();
    if (!st.videoReady || st.queuePlaying) return st.queuePlaying;
    const cfg = activeConfig();
    if (!cfg) return false;
    // v0.3.2 · 项9：与试听互斥——队列起播前先停 audit（playQueue / 驾驶舱续播路径统一收口）
    if (auditScheduler) exitAudit('user');
    scheduler = new SegmentScheduler(engine, systemClock, compilePlan(cfg), {
      capabilities: { rVFC: caps?.rVFC ?? false },
      onFinish: () => {
        // v0.3.2 · 项7：播完确定性落点——onFinish 不经 stopQueueInternal（现状缺陷：
        // 末段 2x 播完 rate 残留 2x），此处显式复位调度器句柄 + rate 归 1 + 模式回 idle
        scheduler = null;
        engine.setRate(1);
        playMode = 'idle';
        store.update({ queuePlaying: false });
        persistence.clearPlayback();
        mediaSession?.setPlaybackState('none');
        syncWakeLock();
        emitFrame();
      },
    });
    if (!scheduler.start()) {
      scheduler = null;
      notify('warn', '播放队列为空：请先勾选至少一段。');
      return false;
    }
    store.update({ queuePlaying: true });
    playMode = 'queue';
    emitFrame();
    return true;
  }

  // ---------- 基础工具 ----------

  // v0.3.2 · 项1：通知中心（info 5s 自动消失 + 并发挤位；freeze = 完全静止）。
  // 冻结三通道优先级：URL 参数 ?fvpNoticeTtl > window 标志（E2E fixture）> navigator.webdriver。
  const noticeTiming = resolveNoticeTiming({
    search: typeof window !== 'undefined' ? window.location.search : '',
    testFlag: typeof window !== 'undefined'
      ? Boolean((window as unknown as { __GYMPLAY_TEST_FREEZE_NOTICES__?: boolean }).__GYMPLAY_TEST_FREEZE_NOTICES__)
      : false,
    webdriver: typeof navigator !== 'undefined' ? navigator.webdriver === true : false,
  });
  const noticeCenter = createNoticeCenter({
    infoTtlMs: noticeTiming.infoTtlMs,
    freeze: noticeTiming.freeze,
    onExpire: (id) => {
      // 到期消失走既有 dismissNotice 单一路径（挤位 / 自动 / 手动同一出口）
      controller.dismissNotice(id);
    },
  });

  /**
   * v0.3.3 · 项2：通知计时的**按视图配对计数**（2-d / 2-e）。
   *
   * 为什么在 controller 侧做配对、而不依赖 notice-center 的 pauseAll/resumeAll：
   * 本批次硬边界是「不改 notice-center.ts」（归高级开发）。而方案 §2.2 第 4 条要求的
   * 「带配对计数」正是为「详情面板与回收站同时打开、关一层不得误解另一层的计时」。
   * 因此在 controller 侧用**视图键集合**实现配对：进入视图 → 加入集合；集合从空变非空
   * 时真正 pauseAll 一次；离开视图 → 从集合移除；集合变空时真正 resumeAll 一次。
   * 同一视图重复进入 / 重复离开都是幂等的（Set 去重）——这是「不漏、不重」的实现口径：
   * **真正调用 pauseAll/resumeAll 的次数恒为「集合 0↔非0 的跃迁次数」**，不是调用方次数。
   *
   * 视图键：
   * - `'detail'`：段详情面板（selectedSegmentId 非 null）；
   * - `'recycle'`：回收站弹层（recycleOpen）；
   * - `'cockpit'`：驾驶舱（mode==='cockpit'）——**只暂停，不确认**（见 enterCockpit 注释）。
   */
  const pausedViews = new Set<'detail' | 'recycle' | 'cockpit' | 'hover'>();
  /** 暂停期间到达的通知：恢复计时时才登记（避免「遮挡期到达的信息」一开始就扣时长）。 */
  const deferredNotices = new Map<number, Notice>();
  let noticesPaused = false;
  /**
   * v0.3.3 · 项3：上次落盘副本被丢弃的条数（0 = 完整落盘）。
   * 只在**丢弃量继续变大**时提示：配额不足是持续状态，每次入栈都提示会把通知区刷满；
   * 而丢弃量不变说明损伤没有加深，不必重复打扰。提示里的条数因此始终是当前真实值。
   */
  let undoDroppedNotified = 0;

  /**
   * 视图暂停/恢复的唯一入口（幂等）。`on` = 该视图此刻是否处于「应当暂停计时」的状态。
   *
   * 断点差异（≥960px）的处理见 `syncViewNoticePauseForViewport`：桌面端 detail-sheet 是
   * 静态侧栏（position: static，不遮挡通知区），**「遮挡」语义在两种断点下不同**，
   * 因此桌面端不为 detail 视图加暂停项（详见该函数注释）。
   */
  function setViewNoticePause(view: 'detail' | 'recycle' | 'cockpit' | 'hover', on: boolean): void {
    const had = pausedViews.has(view);
    if (on === had) return;
    if (on) pausedViews.add(view);
    else pausedViews.delete(view);
    const shouldPause = pausedViews.size > 0;
    if (shouldPause === noticesPaused) return;
    noticesPaused = shouldPause;
    if (shouldPause) {
      noticeCenter.pauseAll();
      return;
    }
    noticeCenter.resumeAll();
    // 暂停期到达的通知此刻才登记计时（信息不因「被遮挡」而少扣时间）
    for (const n of deferredNotices.values()) noticeCenter.track(n);
    deferredNotices.clear();
  }

  /** 当前断点是否 ≥960px（桌面：detail-sheet 为静态侧栏、不遮挡）。 */
  function isDesktopViewport(): boolean {
    try {
      return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(min-width: 960px)').matches
        : false;
    } catch {
      return false;
    }
  }

  /**
   * v0.3.3 · 项2：把「详情面板开合」同步进暂停集合，并按断点区分「遮挡」语义。
   *
   * - **<960px（浮层）**：detail-sheet 是 position: fixed 底部弹层 + scrim，**真的遮挡**
   *   通知区（层级 45 压在通知栈之上）→ 开 = 暂停计时。
   * - **≥960px（静态侧栏）**：detail-sheet 是 position: static 的右栏（CSS `editor.css`
   *   的 `@media (min-width:960px)` 段），与通知区**并列、不重叠**，不存在遮挡 →
   *   **不因开合而暂停/恢复计时**（若照搬浮层语义，会让桌面端「打开右栏 = 通知计时凭空停住」，
   *   关掉右栏才继续走，等于制造了一个不该有的暂停源）。
   *
   * 判据 2-d 的口径是「弹层遮挡不计时」——它测的是**遮挡**，因此严格按断点分别成立：
   * 2-d / 2-e 的实测在非桌面断点下进行（测试桩 `isDesktopViewport()` 恒 false）；
   * 桌面端「开合不暂停」由 tests/unit/app/notice-wiring.test.ts 的独立用例断言。
   */
  function syncDetailViewNoticePause(): void {
    const open = store.get().selectedSegmentId !== null;
    setViewNoticePause('detail', open && !isDesktopViewport());
  }

  /** 视图状态变化的统一同步点（所有会改 selectedSegmentId / recycleOpen / mode 的路径都调它）。 */
  function syncViewNoticePause(): void {
    const st = store.get();
    setViewNoticePause('recycle', st.recycleOpen);
    // 驾驶舱：只暂停不确认（见 enterCockpit）——进入即暂停，退出即恢复，全程不判「已读」
    setViewNoticePause('cockpit', st.mode === 'cockpit');
    syncDetailViewNoticePause();
  }

  /**
   * 视图快照 + store 订阅：**所有**会改这三个字段的路径（含删除后自动收起详情、
   * 应用/丢弃草稿、导入视频清选中）都被同一条 diff 覆盖，避免逐个调用点漏接。
   *
   * 「不漏」的含义：任何一次视图开合都会经过这里；「不重」的含义：同一状态不重复触发
   * （diff 相同即 return），且真正 pauseAll/resumeAll 的次数由 setViewNoticePause 的
   * 集合跃迁去重，恒等于 0↔非0 跃迁次数。
   */
  let viewSnapshot = {
    sel: store.get().selectedSegmentId,
    recycle: store.get().recycleOpen,
    mode: store.get().mode,
  };
  function syncViewNoticePauseFromState(): void {
    const st = store.get();
    if (
      st.selectedSegmentId === viewSnapshot.sel &&
      st.recycleOpen === viewSnapshot.recycle &&
      st.mode === viewSnapshot.mode
    ) {
      return;
    }
    viewSnapshot = { sel: st.selectedSegmentId, recycle: st.recycleOpen, mode: st.mode };
    syncViewNoticePause();
  }
  const unsubscribeViewPause = store.subscribe(syncViewNoticePauseFromState);

  /**
   * 断点跨越（<960 ↔ ≥960）会改变 detail-sheet 的「遮挡」语义，需要重算。
   * 只在有 addEventListener 的环境挂（Node 测试桩与老 WebView 都可缺席）。
   */
  const onViewportChange = (): void => syncViewNoticePause();
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', onViewportChange);
  }

  function notify(kind: NoticeKind, text: string): void {
    const notice = makeNotice(kind, text);
    const current = store.get().notices;
    // info 超上限挤位（freeze = 不挤位）：先推入，再对最旧 info 走既有
    // dismissNotice 单一路径移除（B §1.2b——挤位 / 自动到期 / 手动关闭同一出口，含计时取消）
    let evict: number[] = [];
    if (!noticeTiming.freeze) {
      evict = pruneInfos([...current, notice], NOTICE_INFO_CAP);
    }
    store.update({ notices: [...current, notice] });
    for (const id of evict) controller.dismissNotice(id);
    if (noticesPaused) {
      // v0.3.3 · 项2（2-d / 2-e 的成立条件）：暂停期间到达的通知**不启动计时**。
      // 说明：这一条在方案 §2.2 第 3 条里归 notice-center 的 track()（该项归高级开发）；
      // 那一侧落地前，先在本层用「延后登记、恢复时统一补启」实现同等语义——
      // 本文件不改 notice-center.ts，故不改 track 本体。两侧都落地时，这里退化为冗余（无害）。
      deferredNotices.set(notice.id, notice);
      return;
    }
    noticeCenter.track(notice);
  }

  /** 当前被编辑的配置：冲突草稿态下是草稿，否则是生效配置。 */
  function activeConfig(): PlayerConfig | null {
    const st = store.get();
    return st.pendingKeyConfig ?? st.config;
  }

  /** 生效配置落盘（草稿态绝不调用，F7 AC3）。 */
  function persist(cfg: PlayerConfig): void {
    persistence.save(cfg);
  }

  function commitEdit(res: EditResult): boolean {
    if (!res.ok) {
      notify('warn', res.error.message);
      return false;
    }
    const st = store.get();
    if (st.pendingKeyConfig !== null) {
      // 草稿态：只改草稿，不写本地存储（F7 AC3「未确认前不写本地存储」）
      store.update({ pendingKeyConfig: res.value });
    } else {
      store.update({ config: res.value, configOrigin: st.configOrigin ?? 'local-edit' });
      persist(res.value);
    }
    return true;
  }

  // ---------- v0.3.2 · 项2+10：撤销世界线栈 ----------

  /**
   * 撤销栈同步（规则 5）：storageDegraded ‖ 草稿态 → 仅内存不落盘；
   * 写入失败（连「只留最新一条」都写不进）→ 降级会话内内存历史，
   * 经既有 storageDegraded 通道联动文案 F。
   *
   * v0.3.3 · 项3：同步写入计数两字段（undoTotal / undoRecoverable），UI 侧可见性判定
   * 直接读它们，不再自己 filter（避免口径漂移）。
   *
   * v0.3.3 · 项3 · 配额降容回报：`saveUndoStack` 在配额不足时会**渐进丢弃最旧条目**并回报
   * `dropped`。这里必须把它翻译成用户可见提示——旧实现 `ok:true` 不报丢弃条数，
   * 面板看着「历史还在」而落盘只剩 1 条，正是项3 要消除的静默丢历史。
   * 会话内 `undoStack` 保持完整（被丢的是**持久化副本**，本次会话仍可恢复），
   * 故提示里写明「仅本次会话内仍可恢复」，不误导成「已经彻底没了」。
   */
  function syncUndoStack(entries: UndoEntry[], bannerVisible: boolean): void {
    const st = store.get();
    const counts = undoCounts(entries);
    store.update({
      undoStack: entries,
      undoBannerVisible: bannerVisible,
      undoTotal: counts.total,
      undoRecoverable: counts.recoverable,
    });
    if (st.storageDegraded || st.pendingKeyConfig !== null) return;
    const saved = saveUndoStack(entries, undefined, st.undoBreak);
    if (!saved.ok) {
      store.update({ storageDegraded: true });
      return;
    }
    if (saved.dropped > 0) {
      store.update({
        undoBreak: makeBreakRecord(
          'capacity',
          `本地存储空间不足，最旧的 ${saved.dropped} 条撤销历史未能落盘`,
          saved.dropped,
        ),
      });
      if (saved.dropped > undoDroppedNotified) {
        undoDroppedNotified = saved.dropped;
        notify(
          'warn',
          `撤销历史空间不足，已丢弃最旧的 ${saved.dropped} 条（仅本次会话内仍可恢复，刷新后将不再保留）。`,
        );
      }
    } else {
      // 整栈完整落盘：损伤已解除，重置计数——否则「丢 2 条 → 历史被清空后重新开始 → 又丢 2 条」
      // 这条路径会因计数仍停在 2 而不再提示。
      undoDroppedNotified = 0;
    }
  }

  /**
   * 清栈（v0.3.3 · 项3 三分类，判据 3-d / 3-e）。
   *
   * - `total`（总闸）：换视频 / 换源 / 换整份配置——旧记录全部无意义，直接清。
   * - `broken`（真断裂）：当前配置与栈顶之间存在不可自动合并的分歧——**仍清栈**，但写入
   *   一条 `undoBreak` 痕迹（用户可见「为什么历史没了」，不再静默），并落进存储载体。
   * - `capacity`（容量）：单条超限或配额写满导致的截断——同样留痕迹。
   *
   * 会话内呈现层（点到失效条目）**不再走这里**：那是「置灰不清栈」（见 undoDelete）。
   *
   * @param kind 分类；不传则按 `total` 处理（保持旧调用点的默认语义不变）
   * @param reason 可读原因（写进痕迹；total 也记，便于追溯）
   */
  function clearUndoHistory(kind: UndoBreakKind = 'total', reason = '配置世界线已整体替换'): void {
    const st = store.get();
    const dropped = st.undoStack.length;
    const hasTrace = kind !== 'total';
    // 幂等：本来就没有历史、也没有需要保留的痕迹时不做任何事
    if (dropped === 0 && !st.undoBannerVisible && !st.recycleOpen && !hasTrace) return;
    const breakRecord: UndoBreakRecord | null = hasTrace
      ? makeBreakRecord(kind, reason, dropped)
      : null;
    store.update({
      undoStack: [],
      undoTotal: 0,
      undoRecoverable: 0,
      undoBannerVisible: false,
      recycleOpen: false,
      undoConfirm: null,
      undoBreak: breakRecord,
    });
    if (!st.storageDegraded && st.pendingKeyConfig === null) {
      try {
        if (breakRecord) {
          // 痕迹随空栈一起落盘（旧代码读到时只认 entries，忽略 lastBreak——3-i）
          saveUndoStack([], undefined, breakRecord);
        } else {
          window.localStorage.removeItem(UNDO_STORAGE_KEY);
        }
      } catch {
        /* 存储不可用：栈已仅存内存，无需处理 */
      }
    }
    if (breakRecord) notify('info', `撤销历史已清空（${reason}）。`);
  }

  /** 栈内自增序号（跨会话恢复后从 max+1 续起，保证栈内唯一）。 */
  function nextUndoId(entries: UndoEntry[]): number {
    let max = 0;
    for (const e of entries) if (e.id > max) max = e.id;
    return max + 1;
  }

  /** 解析并校验一条撤销记录的 pre（失败返回 null；调用方已用 isEntryApplicable 给过原因）。 */
  function parseEntryConfig(entry: UndoEntry): PlayerConfig | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry.pre);
    } catch {
      return null;
    }
    const res = validate(parsed);
    return res.ok ? res.value : null;
  }

  /** 该条之后还有多少条「可恢复」的删除记录会被本次恢复一并回退（确认文案用）。 */
  function countSuperseded(entries: UndoEntry[], fromIndex: number): number {
    return entries.slice(fromIndex + 1).filter((e) => !e.stale && e.kind !== 'restore').length;
  }

  /**
   * 包装层（规则 2，BA-F-9 / AB-P1-4）：全部编辑提交统一入口，不改 commitEdit 本体。
   * kind 映射：'delete-segment' / 'remove-entry' → 入栈；'restore' → 恢复记录（undoDelete 专用，
   * 附截断上下文）；'none' → **不入栈也不清栈**（v0.3.3 · 项3：调速 / 改名 / 边界 / 队列顺序 /
   * 循环等编辑不再清空历史，栈的连续性由 pushUndoEntry 的 chainBroken 标记承载）。
   * CI 静态断言（scripts/gate-undo.mjs）：controller.ts 中裸 commitEdit 调用数 == 0。
   */
  function commitEditTracked(
    kind: UndoKind | 'none',
    segLabel: string,
    res: EditResult,
    preCanonical: string | null,
    restoreContext?: { truncateFrom: number; truncatedCount: number; targetPost: string; reversePre?: string },
  ): boolean {
    const ok = commitEdit(res); // gate-undo: 包装层内部唯一合法调用点
    if (!ok || !res.ok) return false;
    const st = store.get();
    if (kind === 'none') {
      // 项3（判据 3-c）：非删除编辑**不清栈**。旧行为是 clearUndoHistory()，
      // 使「删一段 → 改个速率」把整条历史抹掉；这里保留历史，栈顶世界线由逐条门禁负责。
      return true;
    }
    if (kind === 'restore' && restoreContext && preCanonical !== null) {
      // 规则 4：截断 entries[i..top]（保留只读展示）→ push 恢复记录
      //（restore 豁免链式 push 条件，维护 top.post === current 不变量，连按 undo 连续回退可行）
      const truncated = markStaleFrom(st.undoStack, restoreContext.truncateFrom);
      const record: UndoEntry = {
        id: nextUndoId(st.undoStack),
        createdAt: Date.now(),
        kind: 'restore',
        segLabel,
        pre: preCanonical,
        post: restoreContext.targetPost,
      };
      let next = pushUndoEntry(truncated, record);
      // 项3（方案 §2.3 第 4 条）：把被覆盖的那份当前配置存成一条**反向记录**，
      // 把「恢复导致的数据丢失」降级为「可再撤回」。反向记录紧跟恢复记录之后。
      if (restoreContext.reversePre !== undefined) {
        const reverse: UndoEntry = {
          id: nextUndoId(next),
          createdAt: Date.now(),
          kind: 'restore',
          segLabel,
          pre: restoreContext.reversePre,
          post: restoreContext.targetPost,
          reverse: true,
        };
        next = pushUndoEntry(next, reverse);
      }
      syncUndoStack(next, false);
      const n = restoreContext.truncatedCount;
      notify(
        'info',
        n > 1
          ? `已恢复到删除「${segLabel}」之前（之后的 ${n - 1} 次删除一并回退）`
          : `已恢复到删除「${segLabel}」之前。`,
      );
      return true;
    }
    // 删除类（规则 1）：pre === top.post 链式追加；不连续 → 追加并标 chainBroken（不清栈）
    if (preCanonical === null) return true;
    const entry: UndoEntry = {
      id: nextUndoId(st.undoStack),
      createdAt: Date.now(),
      kind,
      segLabel,
      pre: preCanonical,
      post: canonicalize(res.value),
    };
    // 项3 · 容量护栏（架构师实测：300 段配置下 label 20/30 字的条目超 64KB，旧行为把整栈塌成 1 条）：
    // 超限条目**不入栈**，原栈原样保留 + 明确提示；绝不丢弃既有历史。
    if (isUndoEntryOversized(entry)) {
      store.update({
        undoBreak: makeBreakRecord('capacity', `单条记录 ${undoEntryBytes(entry)} 字节，超过 64KB 上限`, 0),
      });
      notify(
        'warn',
        `这次删除的历史记录过大（单条 ${undoEntryBytes(entry)} 字节，超过 64KB 上限），未能保存为可撤销项；之前的撤销历史仍然保留。`,
      );
      return true;
    }
    syncUndoStack(pushUndoEntry(st.undoStack, entry), true);
    return true;
  }

  function queueFrame(): QueueFrame {
    if (!scheduler) {
      return { playing: false, paused: video.paused, queueIndex: -1, queueTotal: 0, segmentId: null, rate: 1, remainingMs: 0, loopsDone: 0, auditSegmentId: null, auditRate: 1 };
    }
    const s = scheduler.current();
    const cfg = activeConfig();
    const total = cfg ? compilePlan(cfg).items.length : 0;
    return {
      playing: s.state === 'playing',
      paused: video.paused,
      queueIndex: s.queueIndex,
      queueTotal: total,
      segmentId: s.segmentId,
      rate: s.rate,
      remainingMs: s.remainingMs,
      loopsDone: s.loopsDone,
      auditSegmentId: null,
      auditRate: 1,
    };
  }

  function emitFrame(): void {
    const t = engine.getTime();
    const q = queueFrame();
    // v0.3.2 · 项9：audit 态随帧下发（BA-F-4：queueFrame 恒读队列调度器，
    // 试听期 scheduler===null → 队列字段为空态，徽标不误读；audit 数据在此单独填充）
    if (auditScheduler && auditPlan) {
      q.auditSegmentId = auditPlan.items[0].segmentId;
      q.auditRate = auditPlan.items[0].rate;
    }
    // 驾驶舱线控卡片元数据：段切换时更新（锁屏/耳机控件上显示当前段名）
    if (mediaSession && q.segmentId !== lastMetaSegmentId) {
      lastMetaSegmentId = q.segmentId;
      const seg = activeConfig()?.segments.find((x) => x.id === q.segmentId);
      mediaSession.setMetadata({ title: seg?.label || '未命名段' });
    }
    for (const cb of frameCbs) cb(t, q);
  }

  engine.onTick(() => {
    emitFrame();
    // P7-B：队列播放中按 1s 节流写播放快照，供回前台校准续播
    const now = Date.now();
    if (scheduler && store.get().queuePlaying && now - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
      lastSnapshotAt = now;
      writeSnapshot();
    }
  });

  engine.onEvent((e) => {
    if (e.type === 'error') notify('error', COPY_LOAD_FAILED);
    if (e.type === 'gesture-required') notify('info', '浏览器要求先点一下页面才能播放，请再点一次播放。');
  });

  function writeSnapshot(): void {
    if (!scheduler) return;
    const s = scheduler.current();
    if (s.state !== 'playing' || !s.segmentId) return;
    const seg = activeConfig()?.segments.find((x) => x.id === s.segmentId);
    persistence.savePlayback({
      queueIndex: s.queueIndex,
      segmentId: s.segmentId,
      offsetSec: Math.max(0, engine.getTime() - (seg?.start ?? 0)),
      playing: true,
      savedAt: new Date().toISOString(),
    });
  }

  // P7-B：页面隐藏立即落盘 + 播放快照；回前台校准续播
  function onPageHide(): void {
    const st = store.get();
    if (st.config !== null && st.pendingKeyConfig === null) persistence.saveNow(st.config);
    if (scheduler && st.queuePlaying) writeSnapshot();
  }
  function onVisibility(): void {
    if (document.visibilityState === 'hidden') onPageHide();
    else {
      if (scheduler && store.get().queuePlaying) scheduler.resync();
      // v0.3.2 · 项9 · 矩阵 #14：试听回前台校准续播（BA-F-13：越界时 locateItem→null
      // → advancePastEnd → onFinish → exitAudit('natural')，行为安全）
      if (auditScheduler && playMode === 'audit') auditScheduler.resync();
    }
  }
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);

  function stopQueueInternal(): void {
    if (scheduler) {
      scheduler.stop();
      scheduler = null;
    }
    // v0.3.2 · 项7：停队列收口——rate 归 1、模式回 idle（所有停队列路径统一经此复位）
    engine.setRate(1);
    playMode = 'idle';
    if (store.get().queuePlaying) store.update({ queuePlaying: false });
    persistence.clearPlayback();
    mediaSession?.setPlaybackState('none');
    syncWakeLock();
  }

  // ---------- v0.3.2 · 项9：单段试听（audit 状态机 idle ⇄ audit + 态内暂停自循环） ----------

  /** 试听退出来源：user = 用户动作（矩阵 #2/#3/#5/#7/#8/#11/#12/#13）；natural = 播完（#10，
   *  含 BA-F-13 越界回前台经 advancePastEnd→onFinish 的不可区分路径）；restart = 幂等重建（#4）。 */
  type AuditExitReason = 'user' | 'natural' | 'restart';

  /** 停止试听：调度器幂等停 + 速率归 1 + 模式回 idle。不 seek、不改选中态、不写播放快照（#15）。 */
  function exitAudit(reason: AuditExitReason): void {
    if (auditScheduler) {
      auditScheduler.stop(); // 幂等可重入（onFinish 后再 stop 安全，B评A 核实）
      auditScheduler = null;
    }
    auditPlan = null;
    engine.setRate(1);
    playMode = 'idle';
    if (store.get().auditSegmentId !== null) store.update({ auditSegmentId: null });
    // BA-F-13：natural 结束补轻提示（越界回前台与自然播完共用同一 onFinish 出口，
    // 用户感知「试听为何停了」；闪变方案弃用，轻提示可发现、可测）
    if (reason === 'natural') notify('info', '试听结束。');
    emitFrame();
  }

  /** 起播试听：单段 plan @段值，与队列互斥；幂等重建（同段回段首、速率刷新，矩阵 #4）。 */
  function startAudition(id: string): void {
    const st = store.get();
    const cfg = activeConfig();
    const seg = cfg?.segments.find((s) => s.id === id);
    if (!cfg || !seg || !st.videoReady) return;
    // 互斥：任一起播前先停对方（audit plan 不与队列调度器并存）
    if (scheduler) stopQueueInternal();
    if (auditScheduler) exitAudit('restart');
    const seq = resolveAuditionSequenceIndex(cfg, seg.id);
    const plan: PlayPlan = {
      items: [{
        segmentId: seg.id,
        label: seg.label,
        start: seg.start,
        end: seg.end,
        rate: seg.rate,
        // BA-F-12 / G-3 / N-1：真实下标，禁用 -1 哨兵（段不在队列时取段列表下标作为有定义兜底）
        sequenceIndex: seq.sequenceIndex,
      }],
      // loop off：单段播完即 onFinish（矩阵 #10 自然结束；segment 模式会无限循环）
      loop: { mode: 'off', count: 0 },
    };
    auditPlan = plan;
    auditScheduler = new SegmentScheduler(engine, systemClock, plan, {
      capabilities: { rVFC: caps?.rVFC ?? false },
      onFinish: () => {
        // 矩阵 #10：到达段 end → 试听结束（调度器已 pause；此处补归 1x / idle / 徽标刷新）
        exitAudit('natural');
      },
    });
    if (!auditScheduler.start()) {
      auditScheduler = null;
      auditPlan = null;
      return;
    }
    playMode = 'audit';
    store.update({ auditSegmentId: id });
    emitFrame();
  }

  // ---------- 视频装载 ----------

  /**
   * F8 AC5：把配置对齐到实际视频时长。
   * >1s 偏差 → 文案 E（warn）；≤1s 且有钳制 → 文案 E 话术（info）。
   * 全部段越界的极端情况 → 回退为全片初始段（并如实提示）。
   */
  function alignConfigToVideo(cfg: PlayerConfig, filename: string, actualDuration: number): PlayerConfig {
    const { config, adjusted, dropped } = clampConfigToDuration(cfg, actualDuration);
    const diff = Math.abs(actualDuration - cfg.video.duration);
    let next: PlayerConfig = {
      ...config,
      video: { type: 'local', filename, duration: actualDuration },
    };
    if (next.segments.length === 0) {
      notify('warn', COPY_VIDEO_MISMATCH);
      next = createInitialConfig({ filename, duration: actualDuration });
    } else if (diff > 1) {
      notify('warn', COPY_VIDEO_MISMATCH);
    } else if (adjusted > 0 || dropped > 0) {
      notify('info', COPY_BOUNDARY_CLAMPED);
    }
    return next;
  }

  async function doImport(file: File): Promise<void> {
    const probe = canPlayTypeProbe(video);
    const hevcOk = (caps?.hevc ?? 'unknown') !== 'unsupported';
    const loaded: SourceLoadResult = loadLocalSource(file, probe, hevcOk);
    if (!loaded.ok) {
      notify('error', loaded.message); // F1 AC2 / R9 fallback 文案
      return;
    }
    try {
      await engine.load(loaded.source);
    } catch {
      loaded.revoke();
      notify('error', COPY_LOAD_FAILED); // F9 AC1：解码失败 / 内存不足统一话术
      return;
    }
    // R2 AC3：重新导入视频后恢复本机音量偏好（部分平台换源会重置音量）
    engine.setVolume(volumePrefs.volume);
    engine.setMuted(volumePrefs.muted);
    objectUrlRevoke?.();
    objectUrlRevoke = loaded.revoke;

    const actual = video.duration;
    const st = store.get();
    const existing = activeConfig();
    let worldLineBroken = false;

    if (existing) {
      // 恢复 / 密钥配置与新视频配对：钳制校验（F8 AC5）
      const aligned = alignConfigToVideo(existing, file.name, actual);
      worldLineBroken = canonicalize(aligned) !== canonicalize(existing);
      if (st.pendingKeyConfig !== null) {
        store.update({ pendingKeyConfig: aligned });
      } else {
        store.update({ config: aligned });
        persist(aligned);
      }
    } else {
      const cfg = createInitialConfig(
        { filename: file.name, duration: actual },
        { createdAt: new Date().toISOString(), appVersion: '0.2.0' },
      );
      store.update({ config: cfg, configOrigin: 'local-edit' });
      persist(cfg);
    }

    store.update({
      videoReady: true,
      videoName: file.name,
      videoDuration: actual,
      needsVideo: false,
      selectedSegmentId: null,
      shareLink: null,
    });
    // 项2 / 项3 · 三分类「真断裂」：换视频后 alignConfigToVideo 实际改动了配置（含边界钳制），
    // 当前配置与栈顶记录之间已不可自动合并 → **仍清栈**，但写入 undoBreak 痕迹（判据 3-d）。
    // ⚠ 判据 3-e：本行**必须保持条件形态**——改成无条件会让「每次切视频都清空历史」，
    // 把 N-3 从「调速清栈」扩大成「切视频也清栈」。
    // （方案原文题为「第 766 行」；批次 2 新增代码后本行位移至下方，形态与语义未变。判据 3-e
    //   要求本行保持条件形态，静态形态断言未随本次改动新增独立用例——此处不虚指测试文件。）
    if (worldLineBroken) clearUndoHistory('broken', '换视频后段边界被钳制，当前编排与历史记录无法自动衔接');
    if (loaded.hint === 'hevc-passthrough') notify('info', COPY_HEVC_PASSTHROUGH);
    emitFrame();
  }

  function stopIfPlayingBeforeEdit(): void {
    // 配置变更会使调度器持有的 plan 过期：编辑即停队列播放
    if (scheduler) stopQueueInternal();
    // v0.3.2 · 项9 · 矩阵 #8：编辑即停纪律扩展覆盖试听（改起止/删除/勾选/队列编辑等）
    if (auditScheduler) exitAudit('user');
  }

  // ---------- 配置导入（M3：URL 密钥与 .json 文件共用生效入口） ----------

  /** .json 文件 / 粘贴 JSON 文本导入：解析 + 校验，失败给可诊断文案（F8 AC4 纪律一致）。 */
  async function importConfigBlob(file: Blob): Promise<void> {
    const parsed = await parseConfigFile(file);
    if (!parsed.ok) {
      notify('error', parsed.error.message);
      return;
    }
    applyImportedConfig(parsed.value);
  }

  /** 导入配置生效：F7 AC3 草稿纪律（本地有配置先挂草稿，应用前不写本地存储）。 */
  function applyImportedConfig(cfg: PlayerConfig): void {
    // v0.3.2 · 项9 · 矩阵 #13：导入 = activeConfig 切源（含草稿挂起）→ 停止试听
    // （audit plan 基于旧 activeConfig 构建，必须终止）
    if (auditScheduler) exitAudit('user');
    const st = store.get();
    if (st.config && canonicalize(st.config) === canonicalize(cfg)) {
      notify('info', '这份配置与当前内容一致，无需导入。');
      return;
    }
    // 项3 · 三分类「真断裂」：导入一份外部编排 = 当前世界线被外部内容替换，
    // 旧记录指向的配置与再导入内容之间没有可合并的路径 → 仍清栈，留痕迹（判据 3-d）。
    clearUndoHistory('broken', '导入了另一份编排，历史记录与导入内容无法衔接');
    if (st.config !== null) {
      // F7 AC3：本地有配置 → 草稿态挂起，不写本地存储
      store.update({ pendingKeyConfig: cfg });
      notify('info', '已载入分享编排为草稿（未保存），请预览后选择「应用」或「保留我的」。');
    } else {
      const aligned = st.videoReady ? alignConfigToVideo(cfg, st.videoName ?? cfg.video.filename, st.videoDuration ?? cfg.video.duration) : cfg;
      store.update({ config: aligned, configOrigin: 'key', needsVideo: !st.videoReady });
      persist(aligned);
      notify('info', '配置已导入。');
    }
  }

  // ---------- 对外动作 ----------

  const controller: EditorController = {
    async importFile(file: File): Promise<void> {
      const st = store.get();
      if (st.videoReady) {
        if (st.videoName === file.name) return; // 重选同一文件：无操作
        // F1 AC3：已装载视频时换新文件须确认清空
        pendingReplaceFile = file;
        store.update({ confirmReplaceOpen: true });
        return;
      }
      await doImport(file);
    },

    async confirmReplace(accept: boolean): Promise<void> {
      const file = pendingReplaceFile;
      pendingReplaceFile = null;
      store.update({ confirmReplaceOpen: false });
      if (!accept || !file) return;
      // 确认后清空当前配置（F1 AC3），以新视频重建
      stopQueueInternal();
      // v0.3.2 · 项9 · 矩阵 #5：一切终止——试听也停（配置清空重建，audit plan 必然作废）
      if (auditScheduler) exitAudit('user');
      objectUrlRevoke?.();
      objectUrlRevoke = null;
      store.update({
        config: null,
        configOrigin: null,
        pendingKeyConfig: null,
        videoReady: false,
        videoName: null,
        videoDuration: null,
        needsVideo: false,
        selectedSegmentId: null,
        shareLink: null,
      });
      persistence.clear();
      writeKeyToLocation(null);
      // 项3 · 三分类「总闸」：确认换视频 → 整份配置清空重建，旧记录全部无意义，直接清
      //（不入栈：undo 快照只存配置不存媒体，恢复会产出「段边界指向另一部视频」的悬空配置）
      clearUndoHistory('total', '已导入新视频，旧编排与历史记录整体作废');
      await doImport(file);
    },

    togglePlay(): void {
      if (!store.get().videoReady) return;
      // v0.3.2 · 项7+项9：模式感知（resolvePlayAction 纯函数矩阵，见 play-mode.test）——
      // 队列/试听中暂停续播保段值（矩阵 #1）；自由预览起播前显式归 1（改速不泄漏进预览，F7′）
      switch (resolvePlayAction(playMode, video.paused)) {
        case 'resume':
          void engine.play();
          break;
        case 'pause':
          engine.pause();
          break;
        case 'preview-play':
          engine.setRate(1);
          playMode = 'preview';
          void engine.play();
          break;
        default:
          engine.pause();
          break;
      }
      emitFrame();
    },

    seekPreview(seconds: number): void {
      if (!store.get().videoReady) return;
      // v0.3.2 · 项7：队列持有播放权时先停队列（切断「拖进度条 → 队列跳段带速」串扰），转自由预览
      if (scheduler) stopQueueInternal();
      // v0.3.2 · 项9 · 矩阵 #2：定位动作 = 退出试听（C4 三态推广）→ 自由预览 @1x，seek 到目标位
      if (auditScheduler) exitAudit('user');
      engine.seek(seconds);
      emitFrame();
    },

    nudgePreview(deltaSec: number): void {
      const st = store.get();
      if (!st.videoReady || !Number.isFinite(deltaSec)) return;
      // v0.3.2 · 项7：同 seekPreview——队列持有播放权时先退出（scheduler 在即停）
      if (scheduler) stopQueueInternal();
      // v0.3.2 · 项9 · 矩阵 #2：步进同为定位动作 → 退出试听
      if (auditScheduler) exitAudit('user');
      const duration = st.videoDuration ?? activeConfig()?.video.duration ?? 0;
      const target = Math.min(duration, Math.max(0, engine.getTime() + deltaSec));
      engine.seek(target);
      emitFrame();
    },

    mark(): void {
      const st = store.get();
      if (!st.videoReady) return;
      // 打点期间停队列播放，避免调度器持有过期 plan
      stopQueueInternal();
      // v0.3.2 · 项9：打点 = 分割编辑 → 编辑即停试听（矩阵 #8）
      if (auditScheduler) exitAudit('user');
      engine.pause();
      commitEditTracked('none', '', splitSegmentAt(mustConfig(), engine.getTime()), null);
    },

    selectSegment(id: string): void {
      const cfg = activeConfig();
      if (!cfg) return;
      const seg = cfg.segments.find((s) => s.id === id);
      if (!seg) return;
      // v0.3.2 · 项7：有界播放中点选 → 先退出队列（调度器持有的 plan 随即作废），
      // 再按 F2-AC2 以段首 @1x 自由预览起播（不携带段值速率）
      if (scheduler) stopQueueInternal();
      // v0.3.2 · 项9 · 矩阵 #3：试听中点选另一段 → 退出 → 同 F2-AC2 语义
      // （跳新段起点、preview @1x 起播；连续对比经显式试听按钮）
      if (auditScheduler) exitAudit('user');
      store.update({ selectedSegmentId: id });
      if (store.get().videoReady) {
        engine.setRate(1);
        playMode = 'preview';
        engine.seek(seg.start);
        void engine.play();
        emitFrame();
      }
    },

    deselectSegment(): void {
      // v0.3.2 · 项8：仅收起详情 sheet——选中态 ⇔ 开合的唯一契约是 selectedSegmentId；
      // 不 seek、不改速率（selectSegment 的跳段首 @1x 语义只发生在「选中」方向）
      if (store.get().selectedSegmentId === null) return;
      store.update({ selectedSegmentId: null });
    },

    startAudition(id): void {
      startAudition(id);
    },

    exitAudition(): void {
      // 矩阵 #4「重启」语义由 startAudition 幂等重建承接；主入口试听中呈现为停止按钮
      if (auditScheduler) exitAudit('user');
    },

    setRate(id, rate) {
      // v0.3.2 · 项9 · 矩阵 #6：调速作用于试听中的段 → 就地生效不打断——
      // 不设会话级独立速率（D-1 细则否决）：段字段正常提交（草稿态分流不受影响），
      // plan.items[0].rate 就地更新 + engine.setRate（scheduler current()/resync 读 item.rate）。
      // 边界：草稿挂起（pendingKeyConfig）时调速只写草稿、试听不跟随（audit plan 基于起播时
      // 的 activeConfig 构建；导入即停试听，矩阵 #13 覆盖主路径）
      if (store.get().auditSegmentId === id) {
        commitEditTracked('none', '', setSegmentRate(mustConfig(), id, rate), null);
        if (auditScheduler && auditPlan && store.get().pendingKeyConfig === null) {
          auditPlan.items[0].rate = rate;
          engine.setRate(rate);
        }
        emitFrame();
        return;
      }
      // 矩阵 #7：作用于其他段 → 编辑即停常规纪律
      stopIfPlayingBeforeEdit();
      commitEditTracked('none', '', setSegmentRate(mustConfig(), id, rate), null);
    },

    rename(id, label) {
      commitEditTracked('none', '', renameSegment(mustConfig(), id, label), null);
    },

    setBounds(id, start, end) {
      stopIfPlayingBeforeEdit();
      return commitEditTracked('none', '', updateSegmentBounds(mustConfig(), id, start, end), null);
    },

    removeSegment(id) {
      stopIfPlayingBeforeEdit();
      // 项2：删除前快照（pre）与可读标签先行捕获，再走删除编辑
      const cfg = mustConfig();
      const seg = cfg.segments.find((s) => s.id === id);
      const pre = canonicalize(cfg);
      const label = seg?.label || `段 ${(cfg.segments.findIndex((s) => s.id === id) + 1) || '未命名'}`;
      if (
        commitEditTracked('delete-segment', label, deleteSegment(cfg, id), pre) &&
        store.get().selectedSegmentId === id
      ) {
        store.update({ selectedSegmentId: null });
      }
    },

    toggleQueue(id, inQueue) {
      stopIfPlayingBeforeEdit();
      commitEditTracked('none', '', setInQueue(mustConfig(), id, inQueue), null);
    },

    moveEntry(from, to) {
      stopIfPlayingBeforeEdit();
      commitEditTracked('none', '', moveSequenceEntry(mustConfig(), from, to), null);
    },

    duplicateEntry(index) {
      stopIfPlayingBeforeEdit();
      commitEditTracked('none', '', duplicateSequenceEntry(mustConfig(), index), null);
    },

    removeEntry(index) {
      stopIfPlayingBeforeEdit();
      // 项10：队列项删除前快照；标签取该队列项引用的段名
      const cfg = mustConfig();
      const refId = cfg.sequence[index];
      const seg = refId !== undefined ? cfg.segments.find((s) => s.id === refId) : undefined;
      const pre = canonicalize(cfg);
      commitEditTracked('remove-entry', seg?.label || '未命名段', removeSequenceEntry(cfg, index), pre);
    },

    setLoopMode(mode, count) {
      stopIfPlayingBeforeEdit();
      commitEditTracked('none', '', setLoop(mustConfig(), mode, count), null);
    },

    /**
     * v0.3.3 · 项3：逐条恢复（门禁判定对象 = 被点击条目）。
     *
     * 三条分支：
     * ① 条目自身损坏（JSON 坏 / 校验不过）→ **只置灰该条**（stale + invalidReason），
     *    不再整栈清空（旧行为是 clearUndoHistory，把「一条坏了」放大成「全部历史消失」）。
     * ② 该条 post === 当前 canonical → 世界线末端，直接恢复。
     * ③ 不一致 → 写明「删除之后你还改过 N 处」写入 `undoConfirm`，等 confirmUndo() 再提交；
     *    被覆盖的当前配置作为反向记录的 pre 一并带下去。判据 3-a / 3-b 走这条。
     */
    undoDelete(entryId: number): void {
      const st = store.get();
      const stack = st.undoStack;
      const idx = stack.findIndex((e) => e.id === entryId && !e.stale && e.kind !== 'restore');
      if (idx < 0) return;
      const entry = stack[idx];
      const cfg = activeConfig();
      if (!cfg) return;
      const currentCanonical = canonicalize(cfg);

      // ① 适用性（纯函数，不抛异常）：分两类处理——
      //    「记录自身损坏」（JSON 坏 / 校验不过 / id 重复）→ 按条置灰，恢复必然失败；
      //    「与当前配置冲突」（区间越界 / id 被复用）→ **不置灰**，走恢复前确认：
      //    用户在确认后仍应能恢复，不能因为再判一次就把它置灰（否则 3-b 场景恢复不了）。
      const verdict = isEntryApplicable(entry, cfg);
      if (!verdict.ok && isEntryDamagedReason(verdict.reason)) {
        syncUndoStack(
          stack.map((e) => (e.id === entry.id ? { ...e, stale: true, invalidReason: verdict.message } : e)),
          st.undoBannerVisible,
        );
        notify('warn', `${verdict.message}，该条历史已置灰。`);
        return;
      }
      if (!verdict.ok) {
        // 与当前配置冲突（id 被复用 / 区间越界）：不是记录坏了，是「此刻恢复会覆盖别人」——
        // 仍允许用户在确认后恢复，故不置灰，只在确认文案里说明。
        // targetPost 这里必须算出来（confirmUndo 不再重算），否则确认后恢复没有目标世界线。
        const conflictCfg = parseEntryConfig(entry);
        store.update({
          undoConfirm: {
            entryId: entry.id,
            segLabel: entry.segLabel,
            superseded: countSuperseded(stack, idx),
            message: `${verdict.message}。恢复会一并回退 ${countSuperseded(stack, idx)} 处改动；被覆盖的当前编排会存成一条反向记录，可再撤回。`,
            overwritten: currentCanonical,
            targetPost: conflictCfg ? canonicalize(conflictCfg) : '',
            truncateFrom: idx,
          },
        });
        return;
      }

      const targetCfg = parseEntryConfig(entry);
      if (!targetCfg) {
        // 适用性刚已通过，这里只作防御（理论上不可达）
        store.update({ undoConfirm: null });
        return;
      }
      const targetPost = canonicalize(targetCfg);
      // ② 世界线末端（该条之后无改动）
      if (undoGateFor(entry, currentCanonical)) {
        stopIfPlayingBeforeEdit();
        const truncatedCount = stack.slice(idx).filter((e) => !e.stale).length;
        if (targetPost === currentCanonical) {
          // 恢复目标与现状一致：只置灰不重放提交
          syncUndoStack(markStaleFrom(stack, idx), false);
          return;
        }
        commitEditTracked('restore', entry.segLabel, { ok: true, value: targetCfg }, currentCanonical, {
          truncateFrom: idx,
          truncatedCount,
          targetPost,
        });
        return;
      }
      // ③ 不是当前世界线末端：恢复前显式确认 + 被覆盖配置存成反向记录
      store.update({
        undoConfirm: {
          entryId: entry.id,
          segLabel: entry.segLabel,
          superseded: countSuperseded(stack, idx),
          message: `这条记录之后还有 ${countSuperseded(stack, idx)} 处改动，恢复会一并回退；被覆盖的当前编排会存成一条反向记录，可再撤回。`,
          overwritten: currentCanonical,
          targetPost,
          truncateFrom: idx,
        },
      });
    },

    /** v0.3.3 · 项3：确认恢复（唯一真正提交恢复的路径之一，另一条是「末端直接恢复」）。 */
    confirmUndo(): void {
      const st = store.get();
      const prompt = st.undoConfirm;
      if (!prompt) return;
      const stack = st.undoStack;
      const idx = stack.findIndex((e) => e.id === prompt.entryId);
      if (idx < 0) {
        store.update({ undoConfirm: null });
        return;
      }
      const entry = stack[idx];
      const cfg = activeConfig();
      if (!cfg) {
        store.update({ undoConfirm: null });
        return;
      }
      const currentCanonical = canonicalize(cfg);
      const verdict = isEntryApplicable(entry, cfg);
      if (!verdict.ok && isEntryDamagedReason(verdict.reason)) {
        // 只有「记录自身损坏」才置灰（恢复必然失败）；冲突类（区间越界 / id 被复用）
        // 已在 undoDelete 时告知过用户，且用户已确认「会一并回退」→ 继续往下恢复。
        store.update({
          undoConfirm: null,
          undoStack: stack.map((e) => (e.id === entry.id ? { ...e, stale: true, invalidReason: verdict.message } : e)),
        });
        notify('warn', `${verdict.message}，该条历史已置灰。`);
        return;
      }
      const parsed = parseEntryConfig(entry);
      if (!parsed) {
        store.update({
          undoConfirm: null,
          undoStack: stack.map((e) => (e.id === entry.id ? { ...e, stale: true, invalidReason: '撤销记录已损坏' } : e)),
        });
        notify('warn', '历史记录已损坏，无法恢复');
        return;
      }
      const targetPost = canonicalize(parsed);
      stopIfPlayingBeforeEdit();
      store.update({ undoConfirm: null });
      const truncatedCount = stack.slice(idx).filter((e) => !e.stale).length;
      if (targetPost === currentCanonical) {
        syncUndoStack(markStaleFrom(stack, idx), false);
        return;
      }
      // 反向记录的 pre = 被覆盖的当前配置（prompt.overwritten），post = 目标
      commitEditTracked('restore', entry.segLabel, { ok: true, value: parsed }, currentCanonical, {
        truncateFrom: idx,
        truncatedCount,
        targetPost,
        reversePre: prompt.overwritten,
      });
    },

    /** v0.3.3 · 项3：取消恢复前确认——不清栈、不改配置，只解除提示。 */
    cancelUndo(): void {
      if (!store.get().undoConfirm) return;
      store.update({ undoConfirm: null });
    },

    dismissUndo(): void {
      if (!store.get().undoBannerVisible) return;
      store.update({ undoBannerVisible: false });
    },

    openRecycle(): void {
      if (store.get().recycleOpen) return;
      store.update({ recycleOpen: true });
    },

    closeRecycle(): void {
      if (!store.get().recycleOpen) return;
      store.update({ recycleOpen: false });
    },

    playQueue(): void {
      startQueue();
    },

    stopQueue(): void {
      // v0.3.2 · 项9 · 矩阵 #12：■ 停止按钮对队列与试听都生效（disabled 条件 queuePlaying ‖ audit）
      if (auditScheduler) exitAudit('user');
      stopQueueInternal();
      engine.pause();
      emitFrame();
    },

    // ---------- M2 驾驶舱 ----------

    enterCockpit(): void {
      const st = store.get();
      if (!st.videoReady || st.mode === 'cockpit') return;
      const cfg = activeConfig();
      if (!cfg || compilePlan(cfg).items.length === 0) {
        notify('warn', '播放队列为空：请先勾选至少一段。');
        return;
      }
      // v0.3.2 · 项9 · 矩阵 #11：进入驾驶舱 → 停止试听 → 队列从头开播
      if (auditScheduler) exitAudit('user');
      // 未在播 → 从队列头开播；编辑器里已在播 → 直接切入不打断
      if (!st.queuePlaying && !startQueue()) return;
      store.update({ mode: 'cockpit' });
      bindMediaSession();
      mediaSession?.setPlaybackState(video.paused ? 'paused' : 'playing');
      syncWakeLock();
      emitFrame();
    },

    exitCockpit(): void {
      if (store.get().mode !== 'cockpit') return;
      stopQueueInternal();
      engine.pause();
      unbindMediaSession();
      store.update({ mode: 'editor', wakeLockHint: false, lineControlHint: false });
      syncWakeLock();
      emitFrame();
    },

    cockpitToggle(): void {
      if (store.get().mode !== 'cockpit') return;
      if (!store.get().queuePlaying || video.paused) resumeCockpit();
      else pauseCockpit();
    },

    cockpitNext(): void {
      cockpitNext();
    },

    cockpitPrev(): void {
      cockpitPrev();
    },

    setLoopLive(mode, count) {
      const normalized = mode === 'queue' && count !== undefined && count > 0 ? Math.floor(count) : 0;
      if (!commitEditTracked('none', '', setLoop(mustConfig(), mode, count), null)) return;
      // 热切换：调度器就地更新循环语义，不打断当前段（重编译会重置播放位置）
      scheduler?.setLoop({ mode, count: normalized });
      emitFrame();
    },

    dismissHint(kind) {
      store.update(kind === 'wakeLock' ? { wakeLockHint: false } : { lineControlHint: false });
    },

    openShare(): void {
      if (!activeConfig()) return;
      store.update({ shareConfirmOpen: true, shareLink: null, shareExportPrompt: false });
    },

    confirmShare(): void {
      const cfg = activeConfig();
      if (!cfg) return;
      // 草稿态下分享的是草稿内容（可试排后可分享）
      const key = encodeConfig(cfg);
      const url = `${window.location.origin}${window.location.pathname}${buildHashWithKey(key)}`;
      if (url.length > URL_KEY_CHAR_LIMIT) {
        // P10 降级（M3）：超 1500 判定线 → 不生成会被截断的长链，引导导出 .json 文件
        notify('warn', COPY_KEY_TOO_LONG);
        store.update({ shareConfirmOpen: false, shareLink: null, shareExportPrompt: true });
        return;
      }
      store.update({ shareConfirmOpen: false, shareLink: url, shareExportPrompt: false });
    },

    closeShare(): void {
      store.update({ shareConfirmOpen: false, shareLink: null, shareExportPrompt: false });
    },

    async copyShareLink(): Promise<boolean> {
      const link = store.get().shareLink;
      if (!link) return false;
      try {
        await navigator.clipboard.writeText(link);
        notify('info', '链接已复制，发送给练友即可。');
        return true;
      } catch {
        notify('warn', '复制失败，请手动长按链接复制。');
        return false;
      }
    },

    importKeyText(text: string): void {
      const trimmed = text.trim();
      if (!trimmed) return;
      // M3：粘贴 .json 配置文本（降级载体二）→ 与文件导入共用同一链路
      if (trimmed.startsWith('{')) {
        void importConfigBlob(new Blob([trimmed], { type: 'application/json' }));
        return;
      }
      // 兼容整段链接 / #c=… / 裸密钥三种粘贴形态
      let key: string | null = null;
      const hashIdx = trimmed.indexOf('#');
      if (hashIdx >= 0) key = extractKeyFromHash(trimmed.slice(hashIdx));
      else key = trimmed.startsWith('c=') ? trimmed.slice(2) : trimmed;
      if (!key) {
        notify('error', COPY_KEY_INVALID);
        return;
      }
      const decoded = decodeKey(key);
      if (!decoded.ok) {
        notify('error', COPY_KEY_INVALID); // F8 AC4
        return;
      }
      applyImportedConfig(decoded.value);
    },

    exportConfigFile(): boolean {
      const cfg = activeConfig();
      if (!cfg) {
        notify('warn', '当前没有可导出的配置。');
        return false;
      }
      // P10 降级载体二：规范化 JSON 文本落 .json 文件（与 URL 密钥同一数据模型）
      const blob = buildConfigFileBlob(cfg);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gymplay-config-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      notify('info', '配置已导出为 .json 文件，发送给练友即可；对方用「导入配置」装入后选择同一视频开练。');
      return true;
    },

    async importConfigFile(file: Blob): Promise<void> {
      await importConfigBlob(file);
    },

    applyDraft(): void {
      const st = store.get();
      const draft = st.pendingKeyConfig;
      if (!draft) return;
      let next = draft;
      if (st.videoReady && st.videoDuration) {
        next = alignConfigToVideo(draft, st.videoName ?? draft.video.filename, st.videoDuration);
      }
      stopQueueInternal();
      store.update({
        config: next,
        configOrigin: 'key',
        pendingKeyConfig: null,
        needsVideo: !st.videoReady,
        selectedSegmentId: null,
      });
      persistence.saveNow(next);
      writeKeyToLocation(null);
      // 项3 · 三分类「总闸」：草稿转正 = 世界线整体切换（新编排成为新的基准）→ 直接清
      clearUndoHistory('total', '草稿已转正，撤销历史随世界线切换作废');
      notify('info', '已应用分享编排并保存到本机。');
    },

    discardDraft(): void {
      if (!store.get().pendingKeyConfig) return;
      store.update({ pendingKeyConfig: null, selectedSegmentId: null });
      writeKeyToLocation(null);
      // 项3 · 三分类「真断裂」：丢弃草稿 → 回到本地编排，两者不是同一世界线的两段
      //（栈里若有本地编排期的记录，无法自动衔接到「丢弃后回到的旧编排」）→ 仍清，留痕迹
      clearUndoHistory('broken', '已丢弃分享草稿，回到本地编排，历史记录无法衔接');
      notify('info', '已保留本地编排，分享的草稿已丢弃。');
    },

    notify,

    dismissNotice(id: number): void {
      noticeCenter.cancel(id);
      store.update({ notices: store.get().notices.filter((n) => n.id !== id) });
    },

    pauseNoticeTimers(): void {
      // v0.3.3 · 项2：hover/focus 也走同一配对集合（键 'hover'）——与详情/回收站/驾驶舱
      // 叠加时不会互相误解对方。UI 侧调用点不变（editor.ts:357-366 归高级开发，不改）。
      setViewNoticePause('hover', true);
    },

    resumeNoticeTimers(): void {
      setViewNoticePause('hover', false);
    },

    setVolume(volume: number): void {
      volumePrefs = { ...volumePrefs, volume: clampVolume(volume) };
      engine.setVolume(volumePrefs.volume);
      volumeStore.save(volumePrefs);
    },

    setMuted(muted: boolean): void {
      volumePrefs = { ...volumePrefs, muted };
      engine.setMuted(muted);
      volumeStore.save(volumePrefs);
    },

    getVolumePrefs(): VolumePrefs {
      return { ...volumePrefs };
    },

    onFrame(cb) {
      frameCbs.add(cb);
    },

    destroy(): void {
      noticeCenter.destroy();
      stopQueueInternal();
      unsubscribeViewPause();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('resize', onViewportChange);
      }
      frameCbs.clear();
      unbindMediaSession();
      wakeLock.destroy();
      engine.destroy();
      objectUrlRevoke?.();
    },
  };

  function mustConfig(): PlayerConfig {
    const cfg = activeConfig();
    if (!cfg) throw new Error('当前没有可编辑的配置');
    return cfg;
  }

  return controller;
}
