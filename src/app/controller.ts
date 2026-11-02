/**
 * L4 · 编辑器控制器：store + persistence + engine + scheduler 的接线层。
 *
 * 职责：
 * - 视频装载（L0 sources 探测 → L1 NativeEngine 装载，F1/F9/F8 AC5 时长校验）；
 * - 编辑动作入口（全部经 L3 edit 纯函数产出新配置，再 commit）；
 * - 自动保存（任何生效配置变更 → 防抖保存；页面隐藏 → 立即保存 + 播放快照）；
 * - 队列播放（L2 SegmentScheduler，P7-B 回前台 resync 校准续播）；
 * - 密钥生成 / 导入 / 冲突裁决（F7 AC3、F8 AC1/AC4、P10 超限提示）。
 *
 * 草稿态纪律（F7 AC3）：pendingKeyConfig 存在时，编辑作用于草稿、不写本地存储；
 * 「应用」后草稿转正并落盘，「保留我的」丢弃草稿。两态共用同一组编辑入口。
 */

import { encodeConfig, decodeKey, canonicalize, URL_KEY_CHAR_LIMIT, COPY_KEY_INVALID } from '../core/config/codec';
import { buildHashWithKey, extractKeyFromHash, writeKeyToLocation } from '../core/config/hash';
import type { Persistence } from '../core/config/persistence';
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
import {
  canPlayTypeProbe,
  loadLocalSource,
  COPY_LOAD_FAILED,
  type SourceLoadResult,
} from '../platform/sources';
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
/** P10 结论：URL 密钥超 1500 判定线（>50 段）→ M1 只提示，导出文件分享在 M3 接线 */
export const COPY_KEY_TOO_LONG =
  '当前配置段数较多，生成的链接超过 1500 字符上限，在部分分享渠道可能被截断而无法还原。配置已自动保存在本机；「导出文件分享」功能将在后续版本提供。';
/** 接收方引导（需求稿文案 B2）：打开分享链接后、导入视频前 */
export const COPY_KEY_RECEIVER_GUIDE =
  '你收到的是一份「训练编排」，不包含视频。请从本机导入同一份视频文件——导入后，分段、速度和顺序会自动套好，直接开练。';
/** HEVC 直读提示（P9 结论：不引导转码，仅提示） */
export const COPY_HEVC_PASSTHROUGH = '检测到 HEVC 编码视频，当前浏览器可直读，已直接装载。';

const SNAPSHOT_INTERVAL_MS = 1000;

export interface QueueFrame {
  playing: boolean;
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
  mark(): void;
  selectSegment(id: string): void;
  setRate(id: string, rate: number): void;
  rename(id: string, label: string): void;
  setBounds(id: string, start: number, end: number): void;
  removeSegment(id: string): void;
  toggleQueue(id: string, inQueue: boolean): void;
  moveEntry(from: number, to: number): void;
  duplicateEntry(index: number): void;
  removeEntry(index: number): void;
  setLoopMode(mode: PlayerConfig['loop']['mode'], count?: number): void;
  playQueue(): void;
  stopQueue(): void;
  openShare(): void;
  confirmShare(): void;
  closeShare(): void;
  copyShareLink(): Promise<boolean>;
  importKeyText(text: string): void;
  applyDraft(): void;
  discardDraft(): void;
  notify(kind: NoticeKind, text: string): void;
  dismissNotice(id: number): void;
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

  let scheduler: SegmentScheduler | null = null;
  let objectUrlRevoke: (() => void) | null = null;
  let pendingReplaceFile: File | null = null;
  let lastSnapshotAt = 0;
  const frameCbs = new Set<(timeSec: number, queue: QueueFrame) => void>();

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
      return { playing: false, queueIndex: -1, queueTotal: 0, segmentId: null, rate: 1, remainingMs: 0, loopsDone: 0 };
    }
    const s = scheduler.current();
    const cfg = activeConfig();
    const total = cfg ? compilePlan(cfg).items.length : 0;
    return {
      playing: s.state === 'playing',
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
        { createdAt: new Date().toISOString(), appVersion: '0.1.0' },
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
      commitEdit(updateSegmentBounds(mustConfig(), id, start, end));
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
      const st = store.get();
      if (!st.videoReady || st.queuePlaying) return;
      const cfg = activeConfig();
      if (!cfg) return;
      scheduler = new SegmentScheduler(engine, systemClock, compilePlan(cfg), {
        capabilities: { rVFC: caps?.rVFC ?? false },
        onFinish: () => {
          store.update({ queuePlaying: false });
          persistence.clearPlayback();
          emitFrame();
        },
      });
      if (!scheduler.start()) {
        scheduler = null;
        notify('warn', '播放队列为空：请先勾选至少一段。');
        return;
      }
      store.update({ queuePlaying: true });
      emitFrame();
    },

    stopQueue(): void {
      stopQueueInternal();
      engine.pause();
      emitFrame();
    },

    openShare(): void {
      if (!activeConfig()) return;
      store.update({ shareConfirmOpen: true, shareLink: null });
    },

    confirmShare(): void {
      const cfg = activeConfig();
      if (!cfg) return;
      // 草稿态下分享的是草稿内容（可试排后可分享）
      const key = encodeConfig(cfg);
      const url = `${window.location.origin}${window.location.pathname}${buildHashWithKey(key)}`;
      if (url.length > URL_KEY_CHAR_LIMIT) notify('warn', COPY_KEY_TOO_LONG);
      store.update({ shareConfirmOpen: false, shareLink: url });
    },

    closeShare(): void {
      store.update({ shareConfirmOpen: false, shareLink: null });
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
      const st = store.get();
      if (st.config && canonicalize(st.config) === canonicalize(decoded.value)) {
        notify('info', '这份密钥与当前配置内容一致，无需导入。');
        return;
      }
      if (st.config !== null) {
        // F7 AC3：本地有配置 → 草稿态挂起，不写本地存储
        store.update({ pendingKeyConfig: decoded.value });
        notify('info', '已载入分享编排为草稿（未保存），请预览后选择「应用」或「保留我的」。');
      } else {
        const aligned = st.videoReady ? alignConfigToVideo(decoded.value, st.videoName ?? decoded.value.video.filename, st.videoDuration ?? decoded.value.video.duration) : decoded.value;
        store.update({ config: aligned, configOrigin: 'key', needsVideo: !st.videoReady });
        persist(aligned);
        notify('info', '密钥已导入。');
      }
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

    onFrame(cb) {
      frameCbs.add(cb);
    },

    destroy(): void {
      stopQueueInternal();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      frameCbs.clear();
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
