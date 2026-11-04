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
import { systemClock } from '../core/player/clock';
import type { PlayerEngine } from '../core/player/engine';
import { createNativeEngine } from '../core/player/native-engine';
import { compilePlan } from '../core/scheduler/plan';
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
import type { AppState, NoticeKind } from './state';
import type { Store } from './store';

/** 文案 E（定稿 §1.2 / F8 AC5，>1s 偏差） */
export const COPY_VIDEO_MISMATCH =
  '导入的视频与这份编排记录的长度不一致，可能不是同一份视频。段边界已按实际长度调整，请核对后再练。';
/** 文案 E 话术的信息级复用（F8 AC5，≤1s 钳制） */
export const COPY_BOUNDARY_CLAMPED = '段边界已按实际长度调整，请核对后再练。';
/** F1 AC3 确认语 */
export const COPY_REPLACE_CONFIRM = '导入新视频将清空当前分段配置';
/** P10 结论：URL 密钥超 1500 判定线（>50 段）→ M3 起引导走 .json 导出/导入降级，不生成不可用长链 */
export const COPY_KEY_TOO_LONG =
  '当前配置段数较多，生成的链接超过 1500 字符上限，在部分分享渠道可能被截断而无法还原。请改用「导出配置」生成 .json 文件发送给练友；配置已自动保存在本机。';
/** 接收方引导（需求稿文案 B2）：打开分享链接后、导入视频前 */
export const COPY_KEY_RECEIVER_GUIDE =
  '你收到的是一份「训练编排」，不包含视频。请从本机导入同一份视频文件——导入后，分段、速度和顺序会自动套好，直接开练。';
/** HEVC 直读提示（P9 结论：不引导转码，仅提示） */
export const COPY_HEVC_PASSTHROUGH = '检测到 HEVC 编码视频，当前浏览器可直读，已直接装载。';

const SNAPSHOT_INTERVAL_MS = 1000;

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
}): EditorController {
  const { store, persistence, video } = opts;
  const caps = store.get().capabilities;
  const engine: PlayerEngine = createNativeEngine(video, {
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
    scheduler = new SegmentScheduler(engine, systemClock, compilePlan(cfg), {
      capabilities: { rVFC: caps?.rVFC ?? false },
      onFinish: () => {
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
    emitFrame();
    return true;
  }

  // ---------- 基础工具 ----------

  function notify(kind: NoticeKind, text: string): void {
    store.update({ notices: [...store.get().notices, makeNotice(kind, text)] });
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

  function queueFrame(): QueueFrame {
    if (!scheduler) {
      return { playing: false, paused: video.paused, queueIndex: -1, queueTotal: 0, segmentId: null, rate: 1, remainingMs: 0, loopsDone: 0 };
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
    };
  }

  function emitFrame(): void {
    const t = engine.getTime();
    const q = queueFrame();
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
    else if (scheduler && store.get().queuePlaying) scheduler.resync();
  }
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);

  function stopQueueInternal(): void {
    if (scheduler) {
      scheduler.stop();
      scheduler = null;
    }
    if (store.get().queuePlaying) store.update({ queuePlaying: false });
    persistence.clearPlayback();
    mediaSession?.setPlaybackState('none');
    syncWakeLock();
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

    if (existing) {
      // 恢复 / 密钥配置与新视频配对：钳制校验（F8 AC5）
      const aligned = alignConfigToVideo(existing, file.name, actual);
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
    if (loaded.hint === 'hevc-passthrough') notify('info', COPY_HEVC_PASSTHROUGH);
    emitFrame();
  }

  function stopIfPlayingBeforeEdit(): void {
    // 配置变更会使调度器持有的 plan 过期：编辑即停队列播放
    if (scheduler) stopQueueInternal();
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
    const st = store.get();
    if (st.config && canonicalize(st.config) === canonicalize(cfg)) {
      notify('info', '这份配置与当前内容一致，无需导入。');
      return;
    }
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
      await doImport(file);
    },

    togglePlay(): void {
      if (!store.get().videoReady) return;
      if (video.paused) void engine.play();
      else engine.pause();
    },

    seekPreview(seconds: number): void {
      if (!store.get().videoReady) return;
      engine.seek(seconds);
      emitFrame();
    },

    nudgePreview(deltaSec: number): void {
      const st = store.get();
      if (!st.videoReady || !Number.isFinite(deltaSec)) return;
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
      engine.pause();
      commitEdit(splitSegmentAt(mustConfig(), engine.getTime()));
    },

    selectSegment(id: string): void {
      const cfg = activeConfig();
      if (!cfg) return;
      const seg = cfg.segments.find((s) => s.id === id);
      if (!seg) return;
      store.update({ selectedSegmentId: id });
      // F2 AC2：点段落条某段 → 播放头跳至该段起点并开始播放
      if (store.get().videoReady) {
        engine.seek(seg.start);
        void engine.play();
        emitFrame();
      }
    },

    setRate(id, rate) {
      stopIfPlayingBeforeEdit();
      commitEdit(setSegmentRate(mustConfig(), id, rate));
    },

    rename(id, label) {
      commitEdit(renameSegment(mustConfig(), id, label));
    },

    setBounds(id, start, end) {
      stopIfPlayingBeforeEdit();
      return commitEdit(updateSegmentBounds(mustConfig(), id, start, end));
    },

    removeSegment(id) {
      stopIfPlayingBeforeEdit();
      if (commitEdit(deleteSegment(mustConfig(), id)) && store.get().selectedSegmentId === id) {
        store.update({ selectedSegmentId: null });
      }
    },

    toggleQueue(id, inQueue) {
      stopIfPlayingBeforeEdit();
      commitEdit(setInQueue(mustConfig(), id, inQueue));
    },

    moveEntry(from, to) {
      stopIfPlayingBeforeEdit();
      commitEdit(moveSequenceEntry(mustConfig(), from, to));
    },

    duplicateEntry(index) {
      stopIfPlayingBeforeEdit();
      commitEdit(duplicateSequenceEntry(mustConfig(), index));
    },

    removeEntry(index) {
      stopIfPlayingBeforeEdit();
      commitEdit(removeSequenceEntry(mustConfig(), index));
    },

    setLoopMode(mode, count) {
      stopIfPlayingBeforeEdit();
      commitEdit(setLoop(mustConfig(), mode, count));
    },

    playQueue(): void {
      startQueue();
    },

    stopQueue(): void {
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
      if (!commitEdit(setLoop(mustConfig(), mode, count))) return;
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
      notify('info', '已应用分享编排并保存到本机。');
    },

    discardDraft(): void {
      if (!store.get().pendingKeyConfig) return;
      store.update({ pendingKeyConfig: null, selectedSegmentId: null });
      writeKeyToLocation(null);
      notify('info', '已保留本地编排，分享的草稿已丢弃。');
    },

    notify,

    dismissNotice(id: number): void {
      store.update({ notices: store.get().notices.filter((n) => n.id !== id) });
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
      stopQueueInternal();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
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
