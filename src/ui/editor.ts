/**
 * L5 · 编辑器主视图（M1）。
 *
 * 骨架一次性构建（video 元素永不重建），动态区域随 store 重渲染；
 * 播放头 / 时间码 / 队列状态行走 controller.onFrame 直改 DOM，不经 store。
 *
 * 覆盖交付物：本地文件装载（含 HEVC 提示）｜时间刻度条打点｜段落条｜速度档位｜
 * 队列视图（勾选/拖拽/重复段）｜密钥生成与导入（URL hash）｜自动保存状态｜
 * hash 草稿态冲突 UI（F7 AC3）。
 */

import { COPY_STORAGE_UNAVAILABLE } from '../core/config/persistence';
import type { PlayerConfig } from '../core/config/schema';
import type { EditorController, QueueFrame } from '../app/controller';
import {
  COPY_KEY_RECEIVER_GUIDE,
  COPY_REPLACE_CONFIRM,
} from '../app/controller';
import type { AppState } from '../app/state';
import type { Store } from '../app/store';
import { h, mount, on } from './dom';
import { createTimelineBar, type TimelineBar } from './editor/timeline-bar';
import { renderQueue } from './editor/queue-view';

/** 文案 A · 视频源限制（需求稿成稿，空状态页 + 导入区常驻） */
const COPY_SOURCE_LIMITS =
  '本工具播放的是你自己设备里的视频文件，支持 MP4、WebM 等浏览器可解码的常见格式。B站、抖音等平台的视频，请先下载到本机后再导入。本工具不解析、不抓取、不下载任何在线视频。';
/** 文案 B · 版权提示（需求稿成稿，点击分享时展示，确认后生成） */
const COPY_SHARE_COPYRIGHT =
  '生成的分享链接只包含你的分段、速度和顺序配置，不包含视频本身，接收者需要自行准备同一份视频文件。请确认你有权使用该视频；请只分享链接配置，不要传播未经授权的视频文件。';

/** 速度档位（F4 AC1 初始档位集合）；>2x 为跳过区（P4 听测结论，M-1 约束入 UI） */
const RATE_PRESETS_NORMAL = [0.5, 0.75, 1, 1.25, 1.5, 2];
const RATE_PRESETS_SKIP = [3, 4];

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const sText = Number.isInteger(s) ? String(s) : s.toFixed(1);
  return `${m}:${sText.padStart(2, '0')}`;
}

function activeConfigOf(state: AppState): PlayerConfig | null {
  return state.pendingKeyConfig ?? state.config;
}

export interface EditorView {
  root: HTMLElement;
  video: HTMLVideoElement;
  /** 骨架完成后绑定 controller（渲染 + 帧回调） */
  bind(store: Store<AppState>, controller: EditorController): void;
}

export function createEditorView(root: HTMLElement): EditorView {
  // ---------- 静态骨架 ----------
  const fileInput = h('input', {
    type: 'file',
    accept: 'video/*',
    'data-testid': 'file-input',
    class: 'fvp-hidden-file',
  }) as HTMLInputElement;

  const saveState = h('span', { class: 'fvp-save-state', 'data-testid': 'save-state' });
  const banners = h('div', { class: 'fvp-banners', 'data-testid': 'banners' });

  const video = h('video', {
    class: 'player__video',
    'data-testid': 'video',
    playsinline: '',
  }) as HTMLVideoElement;
  video.playsInline = true;

  const playToggle = h('button', { class: 'fvp-btn fvp-btn--primary', 'data-testid': 'play-toggle' }, '▶ 播放');
  const timeLabel = h('span', { class: 'player__time', 'data-testid': 'time-label' }, '0:00 / 0:00');
  const markBtn = h('button', { class: 'fvp-btn fvp-btn--mark', 'data-testid': 'mark-button' }, '✚ 打点');

  const timeline: TimelineBar = createTimelineBar({
    onSeek: (t) => controllerRef?.seekPreview(t),
    onSelectSegment: (id) => controllerRef?.selectSegment(id),
  });

  const playerPane = h(
    'section',
    { class: 'player-pane' },
    video,
    h('div', { class: 'player__transport' }, playToggle, timeLabel, markBtn),
    timeline.el,
  );

  const segmentList = h('div', { class: 'segments__list', 'data-testid': 'segment-list' });
  const segmentDetail = h('div', { class: 'segments__detail', 'data-testid': 'segment-detail' });
  const segmentsPane = h(
    'section',
    { class: 'segments-pane' },
    h('h2', {}, '段落'),
    segmentList,
    segmentDetail,
  );

  const queueContainer = h('div', { class: 'queue' });
  const queuePane = h('section', { class: 'queue-pane' }, h('h2', {}, '播放队列'), queueContainer);

  // 分享 / 导入区
  const shareOpenBtn = h('button', { class: 'fvp-btn fvp-btn--primary', 'data-testid': 'share-open' }, '🔗 生成分享链接');
  const sharePanel = h('div', { class: 'share__panel' });
  const keyInput = h('input', {
    type: 'text',
    placeholder: '粘贴分享链接或密钥',
    'data-testid': 'key-input',
    class: 'share__input',
  }) as HTMLInputElement;
  const keyImportBtn = h('button', { class: 'fvp-btn', 'data-testid': 'key-import' }, '导入密钥');
  const sharePane = h(
    'section',
    { class: 'share-pane' },
    h('h2', {}, '分享与导入'),
    shareOpenBtn,
    sharePanel,
    h('div', { class: 'share__import' }, keyInput, keyImportBtn),
    h('p', { class: 'fvp-muted' }, COPY_SOURCE_LIMITS),
  );

  const editorMain = h('main', { class: 'fvp-editor', 'data-testid': 'editor' }, playerPane, segmentsPane, queuePane, sharePane);

  // 空状态（F9 AC2：三步引导 + 文案 A）
  const emptyPickBtn = h('button', { class: 'fvp-btn fvp-btn--primary fvp-btn--big', 'data-testid': 'empty-pick' }, '📂 选择本地视频');
  const emptyState = h(
    'section',
    { class: 'empty-state', 'data-testid': 'empty-state' },
    h('h2', {}, '三步开始分段变速跟练'),
    h(
      'ol',
      { class: 'empty-state__steps' },
      h('li', {}, '① 导入本机视频文件'),
      h('li', {}, '② 播放中点「打点」切出段落，逐段设速度'),
      h('li', {}, '③ 勾选段落生成播放队列，开练'),
    ),
    emptyPickBtn,
    h('p', { class: 'fvp-muted' }, COPY_SOURCE_LIMITS),
  );

  // 需重新选择视频（恢复 / 密钥配置等待配对）
  const needsVideoText = h('p', { 'data-testid': 'needs-video-text' });
  const needsVideoGuide = h('p', { class: 'fvp-muted', 'data-testid': 'needs-video-guide' });
  const needsVideoBtn = h('button', { class: 'fvp-btn fvp-btn--primary', 'data-testid': 'needs-video-pick' }, '📂 选择视频文件');
  const needsVideoPane = h(
    'section',
    { class: 'needs-video', 'data-testid': 'needs-video' },
    h('h2', {}, '还差一步：选择视频'),
    needsVideoText,
    needsVideoGuide,
    needsVideoBtn,
  );

  mount(
    root,
    h(
      'div',
      { class: 'fvp' },
      h('header', { class: 'fvp__header' }, h('h1', {}, 'Gymplay · 编辑器'), saveState),
      banners,
      emptyState,
      needsVideoPane,
      editorMain,
    ),
    fileInput,
  );

  let controllerRef: EditorController | null = null;

  function bind(store: Store<AppState>, controller: EditorController): void {
    controllerRef = controller;

    on(fileInput, 'change', () => {
      const file = fileInput.files?.[0];
      if (file) void controller.importFile(file);
      fileInput.value = ''; // 允许重选同一文件触发 change
    });
    for (const btn of [emptyPickBtn, needsVideoBtn]) on(btn, 'click', () => fileInput.click());
    on(playToggle, 'click', () => controller.togglePlay());
    on(markBtn, 'click', () => controller.mark());
    on(shareOpenBtn, 'click', () => controller.openShare());
    on(keyImportBtn, 'click', () => controller.importKeyText(keyInput.value));

    store.subscribe((state) => render(state, store, controller));
    render(store.get(), store, controller);

    controller.onFrame((t, q) => renderFrame(t, q));
  }

  // ---------- 帧级更新（播放头 / 时间码 / 队列状态行） ----------
  function renderFrame(timeSec: number, q: QueueFrame): void {
    const state = storeRef?.get();
    const cfg = state ? activeConfigOf(state) : null;
    const duration = state?.videoDuration ?? cfg?.video.duration ?? 0;
    timeLabel.textContent = `${formatTime(timeSec)} / ${formatTime(duration)}`;
    playToggle.textContent = video.paused ? '▶ 播放' : '⏸ 暂停';
    timeline.updatePlayhead(timeSec);
    const statusEl = queueContainer.querySelector('[data-testid="queue-status"]');
    if (statusEl) {
      if (q.playing && cfg) {
        const seg = cfg.segments.find((s) => s.id === q.segmentId);
        const loopText = cfg.loop.mode === 'queue' ? ` · 第 ${q.loopsDone + 1} 圈` : cfg.loop.mode === 'segment' ? ' · 单段循环' : '';
        statusEl.textContent = `播放中：第 ${q.queueIndex + 1}/${q.queueTotal} 项 · ${seg?.label || '未命名段'} · ${q.rate}x · 剩余 ${(q.remainingMs / 1000).toFixed(1)}s${loopText}`;
      }
    }
  }

  let storeRef: Store<AppState> | null = null;

  // ---------- 结构渲染 ----------
  function render(state: AppState, store: Store<AppState>, controller: EditorController): void {
    storeRef = store;
    const cfg = activeConfigOf(state);
    const isDraft = state.pendingKeyConfig !== null;

    // 区域可见性
    emptyState.hidden = !(state.config === null && state.pendingKeyConfig === null && !state.videoReady);
    needsVideoPane.hidden = !(cfg !== null && !state.videoReady);
    editorMain.hidden = !(state.videoReady || cfg !== null);
    editorMain.classList.toggle('fvp-editor--draft', isDraft);

    // 保存状态
    if (state.storageDegraded) {
      saveState.textContent = '⚠ 仅本次会话保存';
      saveState.classList.add('fvp-save-state--warn');
    } else if (isDraft) {
      saveState.textContent = '草稿预览（未保存）';
      saveState.classList.add('fvp-save-state--warn');
    } else {
      saveState.textContent = cfg ? '已自动保存' : '';
      saveState.classList.remove('fvp-save-state--warn');
    }

    renderBanners(state, controller);

    // 需配对视频提示
    if (cfg && !state.videoReady) {
      needsVideoText.textContent = `当前编排对应视频文件「${cfg.video.filename}」（${formatTime(cfg.video.duration)}）。本地文件无法跨会话保留，请重新选择同一文件。`;
      needsVideoGuide.textContent = state.configOrigin === 'key' ? COPY_KEY_RECEIVER_GUIDE : '';
    }

    // 播放器区
    markBtn.toggleAttribute('disabled', !state.videoReady);
    playToggle.toggleAttribute('disabled', !state.videoReady);
    shareOpenBtn.toggleAttribute('disabled', cfg === null);

    if (cfg) {
      timeline.update({
        duration: state.videoDuration ?? cfg.video.duration,
        segments: cfg.segments,
        selectedId: state.selectedSegmentId,
      });
      renderSegments(state, cfg, controller);
      renderQueue(queueContainer, { config: cfg, videoReady: state.videoReady, queuePlaying: state.queuePlaying }, {
        onToggle: (id, inQueue) => controller.toggleQueue(id, inQueue),
        onMove: (from, to) => controller.moveEntry(from, to),
        onDuplicate: (i) => controller.duplicateEntry(i),
        onRemove: (i) => controller.removeEntry(i),
        onLoop: (mode, count) => controller.setLoopMode(mode, count),
        onPlayQueue: () => controller.playQueue(),
        onStopQueue: () => controller.stopQueue(),
      });
    } else {
      mount(segmentList);
      mount(segmentDetail);
      mount(queueContainer);
    }

    renderSharePanel(state, controller);
  }

  // ---------- 通知与横幅 ----------
  function renderBanners(state: AppState, controller: EditorController): void {
    const nodes: Node[] = [];

    // F7 AC3 冲突横幅：本地有配置 + 打开分享链接 → 草稿态预览
    if (state.pendingKeyConfig) {
      const applyBtn = h('button', { class: 'fvp-btn fvp-btn--primary', 'data-testid': 'conflict-apply' }, '应用此编排（覆盖本地）');
      on(applyBtn, 'click', () => controller.applyDraft());
      const discardBtn = h('button', { class: 'fvp-btn', 'data-testid': 'conflict-discard' }, '保留我的编排');
      on(discardBtn, 'click', () => controller.discardDraft());
      nodes.push(
        h(
          'div',
          { class: 'fvp-banner fvp-banner--conflict', 'data-testid': 'conflict-banner' },
          h('p', {}, '你打开了一份分享编排。正在以草稿预览（可试排），应用前不会影响你本地已保存的配置。'),
          h('div', { class: 'fvp-banner__ops' }, applyBtn, discardBtn),
        ),
      );
    }

    // F1 AC3 换视频确认
    if (state.confirmReplaceOpen) {
      const ok = h('button', { class: 'fvp-btn fvp-btn--danger', 'data-testid': 'replace-confirm' }, '确认清空并导入');
      on(ok, 'click', () => void controller.confirmReplace(true));
      const cancel = h('button', { class: 'fvp-btn', 'data-testid': 'replace-cancel' }, '取消');
      on(cancel, 'click', () => void controller.confirmReplace(false));
      nodes.push(
        h(
          'div',
          { class: 'fvp-banner fvp-banner--warn', 'data-testid': 'replace-banner' },
          h('p', {}, COPY_REPLACE_CONFIRM),
          h('div', { class: 'fvp-banner__ops' }, ok, cancel),
        ),
      );
    }

    // 存储降级（文案 F，R14）
    if (state.storageDegraded) {
      nodes.push(h('div', { class: 'fvp-banner fvp-banner--warn', 'data-testid': 'storage-banner' }, COPY_STORAGE_UNAVAILABLE));
    }

    // 通知栈
    for (const n of state.notices) {
      const close = h('button', { class: 'fvp-notice__close', 'data-testid': `notice-close-${n.id}` }, '×');
      on(close, 'click', () => controller.dismissNotice(n.id));
      nodes.push(
        h(
          'div',
          { class: `fvp-notice fvp-notice--${n.kind}`, 'data-testid': 'notice', 'data-kind': n.kind },
          h('span', {}, n.text),
          close,
        ),
      );
    }

    mount(banners, ...nodes);
  }

  // ---------- 段落条 + 选中段编辑 ----------
  function renderSegments(state: AppState, cfg: PlayerConfig, controller: EditorController): void {
    const sorted = [...cfg.segments].sort((a, b) => a.start - b.start);
    const items = sorted.map((seg, i) => {
      const name = seg.label || `段 ${i + 1}`;
      const btn = h(
        'button',
        {
          class: `segment${seg.id === state.selectedSegmentId ? ' segment--selected' : ''}${seg.inQueue ? '' : ' segment--off'}`,
          'data-testid': `segment-item-${seg.id}`,
        },
        h('span', { class: 'segment__name' }, name),
        h('span', { class: 'segment__meta' }, `${formatTime(seg.start)}–${formatTime(seg.end)} · ${seg.rate}x${seg.inQueue ? '' : ' · 未勾选'}`),
      );
      on(btn, 'click', () => controller.selectSegment(seg.id));
      return btn;
    });
    mount(segmentList, ...items);

    const selected = cfg.segments.find((s) => s.id === state.selectedSegmentId);
    if (!selected) {
      mount(segmentDetail, h('p', { class: 'fvp-muted' }, '点选段落条上的段，设置名称、起止与速度。'));
      return;
    }

    // 名称
    const labelInput = h('input', {
      type: 'text',
      value: selected.label,
      maxlength: '30',
      placeholder: '段名（如：热身 / 深蹲组）',
      'data-testid': 'detail-label',
    }) as HTMLInputElement;
    on(labelInput, 'change', () => controller.rename(selected.id, labelInput.value));

    // 起止
    const startInput = h('input', {
      type: 'number', step: '0.1', min: '0', value: String(selected.start), 'data-testid': 'detail-start',
    }) as HTMLInputElement;
    const endInput = h('input', {
      type: 'number', min: '0', step: '0.1', value: String(selected.end), 'data-testid': 'detail-end',
    }) as HTMLInputElement;
    const commitBounds = (): void => {
      controller.setBounds(selected.id, Number(startInput.value), Number(endInput.value));
    };
    on(startInput, 'change', commitBounds);
    on(endInput, 'change', commitBounds);

    // 速度档位（P4：0.5~2 听感跟练区；3/4 跳过区·听感失真）
    const rateRow = h('div', { class: 'rates', 'data-testid': 'rate-picker' });
    for (const r of RATE_PRESETS_NORMAL) {
      const b = h(
        'button',
        { class: `rate${selected.rate === r ? ' rate--active' : ''}`, 'data-testid': `rate-${r}` },
        `${r}x`,
      );
      on(b, 'click', () => controller.setRate(selected.id, r));
      rateRow.append(b);
    }
    const skipZone = h('div', { class: 'rates rates--skip', 'data-testid': 'rate-skip-zone' },
      h('span', { class: 'rates__skip-label' }, '跳过区 · 听感失真'),
    );
    for (const r of RATE_PRESETS_SKIP) {
      const b = h(
        'button',
        { class: `rate rate--skip${selected.rate === r ? ' rate--active' : ''}`, 'data-testid': `rate-${r}` },
        `${r}x`,
      );
      on(b, 'click', () => controller.setRate(selected.id, r));
      skipZone.append(b);
    }

    const deleteBtn = h('button', { class: 'fvp-btn fvp-btn--danger', 'data-testid': 'detail-delete' }, '删除此段');
    on(deleteBtn, 'click', () => controller.removeSegment(selected.id));

    mount(
      segmentDetail,
      h('h3', {}, `编辑：${selected.label || '未命名段'}`),
      h('label', { class: 'fvp-field' }, '名称', labelInput),
      h('label', { class: 'fvp-muted', 'data-testid': 'pitch-note' }, '变速保调已默认开启（人声音调不随速度变化）。'),
      h('div', { class: 'fvp-row' },
        h('label', { class: 'fvp-field' }, '开始（秒）', startInput),
        h('label', { class: 'fvp-field' }, '结束（秒）', endInput)),
      h('div', { class: 'fvp-field' }, '速度档位', rateRow, skipZone),
      deleteBtn,
    );
  }

  // ---------- 分享面板（文案 B 确认 → 生成；F8 AC1） ----------
  function renderSharePanel(state: AppState, controller: EditorController): void {
    if (state.shareConfirmOpen) {
      const confirm = h('button', { class: 'fvp-btn fvp-btn--primary', 'data-testid': 'share-confirm' }, '确认生成');
      on(confirm, 'click', () => controller.confirmShare());
      const cancel = h('button', { class: 'fvp-btn', 'data-testid': 'share-cancel' }, '取消');
      on(cancel, 'click', () => controller.closeShare());
      mount(
        sharePanel,
        h('div', { class: 'share__confirm', 'data-testid': 'share-confirm-panel' },
          h('p', {}, COPY_SHARE_COPYRIGHT),
          h('div', { class: 'fvp-banner__ops' }, confirm, cancel)),
      );
      return;
    }
    if (state.shareLink) {
      const linkInput = h('input', {
        type: 'text', readonly: '', value: state.shareLink, 'data-testid': 'share-link', class: 'share__link',
      }) as HTMLInputElement;
      on(linkInput, 'focus', () => linkInput.select());
      const copyBtn = h('button', { class: 'fvp-btn fvp-btn--primary', 'data-testid': 'share-copy' }, '复制链接');
      on(copyBtn, 'click', () => void controller.copyShareLink());
      const close = h('button', { class: 'fvp-btn', 'data-testid': 'share-close' }, '关闭');
      on(close, 'click', () => controller.closeShare());
      mount(
        sharePanel,
        h('div', { class: 'share__result' },
          h('p', { class: 'fvp-muted' }, '链接只含配置、不含视频（接收者需自备同一视频文件）：'),
          linkInput,
          h('div', { class: 'fvp-banner__ops' }, copyBtn, close)),
      );
      return;
    }
    mount(sharePanel);
  }

  return { root, video, bind };
}
