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
  COPY_KEY_TOO_LONG,
  COPY_REPLACE_CONFIRM,
} from '../app/controller';
import { foldNotices } from '../app/notice-center';
import type { AppState } from '../app/state';
import type { Store } from '../app/store';
import { topActiveDeletion, activeUndoEntries } from '../app/undo-store';
import type { RecycleView } from './editor/recycle-view';
import { h, mount, on } from './dom';
import { createTimelineBar, type TimelineBar } from './editor/timeline-bar';
import { renderQueue } from './editor/queue-view';
import { createRecycleView } from './editor/recycle-view';
import { buildUndoConfirmBanner } from './editor/undo-confirm';
import { readUndoCounts, recycleBinText } from './editor/undo-counts';
import { formatClock, parseTimeInput } from './editor/time-input';

/** 文案 A · 视频源限制（需求稿成稿，空状态页 + 导入区常驻） */
const COPY_SOURCE_LIMITS =
  '本工具播放的是你自己设备里的视频文件，支持 MP4、WebM 等浏览器可解码的常见格式。B站、抖音等平台的视频，请先下载到本机后再导入。本工具不解析、不抓取、不下载任何在线视频。';
/** 文案 B · 版权提示（需求稿成稿，点击分享时展示，确认后生成） */
const COPY_SHARE_COPYRIGHT =
  '生成的分享链接只包含你的分段、速度和顺序配置，不包含视频本身，接收者需要自行准备同一份视频文件。请确认你有权使用该视频；请只分享链接配置，不要传播未经授权的视频文件。';

/** 速度档位（F4 AC1 初始档位集合）；>2x 为跳过区（P4 听测结论，M-1 约束入 UI）
 * v0.3.2 · 项5：单一事实源提取至 rate-presets.ts（BA-F-8），此处改为同源 re-export */
import { RATE_PRESETS_NORMAL, RATE_PRESETS_SKIP } from './rate-presets';
export { RATE_PRESETS_NORMAL, RATE_PRESETS_SKIP };

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const sText = Number.isInteger(s) ? String(s) : s.toFixed(1);
  return `${m}:${sText.padStart(2, '0')}`;
}

/** v0.3.1 · R1 AC6：当前时刻恒显一位小数（m:ss.s），时长沿用 formatTime 既有规则。 */
function formatTimeTenth(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** v0.3.1 · v1.1 §7.2：步进按钮长按连发参数（单击步进一档，长按 400ms 后连发，200ms 加速到 60ms）。 */
const STEP_REPEAT_DELAY_MS = 400;
const STEP_REPEAT_START_MS = 200;
const STEP_REPEAT_MIN_MS = 60;
const STEP_REPEAT_DECAY_MS = 20;

/** v0.3.2 · 项8：详情 sheet 下滑关闭阈值（sheet 头部向下拖超过该位移松手即关）。 */
const SHEET_DRAG_CLOSE_PX = 48;

function activeConfigOf(state: AppState): PlayerConfig | null {
  return state.pendingKeyConfig ?? state.config;
}

export interface EditorView {
  root: HTMLElement;
  video: HTMLVideoElement;
  /** 骨架完成后绑定 controller（渲染 + 帧回调） */
  bind(store: Store<AppState>, controller: EditorController): void;
  /** v0.3.2 · 项8：详情 sheet 双宿主移动（desktop=true 移入右栏 aside，否则回主文档流） */
  applyLayout(desktop: boolean): void;
}

export function createEditorView(root: HTMLElement): EditorView {
  // ---------- 静态骨架 ----------
  const fileInput = h('input', {
    type: 'file',
    accept: 'video/*',
    'data-testid': 'file-input',
    class: 'fvp-hidden-file',
  }) as HTMLInputElement;

  // M3 · 载体二：.json 配置文件导入入口（隐藏文件输入）
  const configFileInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    'data-testid': 'config-file-input',
    class: 'fvp-hidden-file',
  }) as HTMLInputElement;

  const saveState = h('span', { class: 'fvp-save-state', 'data-testid': 'save-state' });
  // v0.3.2 · 项2+10：回收站入口（header 常驻按钮，N=0 隐藏；计数随 store 重渲染）
  const recycleBinBtn = h(
    'button',
    { class: 'fvp-btn fvp-btn--recycle', 'data-testid': 'recycle-bin' },
    '🗑 回收站',
  );
  // v0.3.2 · 项1（C1 裁决）：单一 banners 容器拆为两个兄弟容器——
  // notice-stack（sticky 吸顶，承载通知）+ banner-stack（文档流原位，承载决策横幅）。
  // 显式标注：notice-stack 的 sticky 不改写 UX-v1.1-C6——C6 仅约束决策横幅，决策横幅随文档流。
  const noticeStack = h('div', { class: 'fvp-notice-stack', 'data-testid': 'notice-stack' });
  const bannerStack = h('div', { class: 'fvp-banner-stack', 'data-testid': 'banner-stack' });
  // v0.3.3 · 项1：fixed 贴底槽的文档流占位（高度跟随 --fvp-dock-height）
  const dockSpacer = h('div', { class: 'fvp-dock-spacer', 'aria-hidden': 'true' });

  const video = h('video', {
    class: 'player__video',
    'data-testid': 'video',
    playsinline: '',
  }) as HTMLVideoElement;
  video.playsInline = true;

  const playToggle = h('button', { class: 'fvp-btn fvp-btn--primary', 'data-testid': 'play-toggle' }, '▶ 播放');
  // v0.3.2 · 项7：模式徽标——transport 行 playToggle 旁常驻，随帧更新
  //（预览中性灰 / 队列蓝 / 试听橙，三态配色见 editor.css；audit 态 Phase 4 接入）
  const playModeBadge = h(
    'span',
    { class: 'fvp-play-mode-badge fvp-play-mode-badge--preview', 'data-testid': 'play-mode-badge' },
    '预览 · 1x',
  );
  const timeLabel = h('span', { class: 'player__time', 'data-testid': 'time-label' }, '0:00 / 0:00');
  const markBtn = h('button', { class: 'fvp-btn fvp-btn--mark', 'data-testid': 'mark-button' }, '✚ 打点');

  // v0.3.1 · R2 音量控件：滑杆（0-100）+ 静音切换；按设备记忆，不进分享密钥
  const volumeMute = h(
    'button',
    { class: 'fvp-btn fvp-btn--icon', 'data-testid': 'volume-mute', 'aria-label': '静音切换' },
    '🔊',
  );
  const volumeSlider = h('input', {
    type: 'range', min: '0', max: '100', step: '1', value: '100',
    class: 'player__volume', 'data-testid': 'volume-slider', 'aria-label': '音量',
  }) as HTMLInputElement;

  // v0.3.1 · v1.1 §7.2 步进按钮：±1s / ±0.1s，仅暂停时显示；单击步进一档，长按连发加速
  const stepButtons = h(
    'div',
    { class: 'player__steps', 'data-testid': 'step-buttons', hidden: '' },
    h('button', { class: 'fvp-btn fvp-btn--step', 'data-testid': 'step-minus-1s', 'data-delta': '-1' }, '−1s'),
    h('button', { class: 'fvp-btn fvp-btn--step', 'data-testid': 'step-minus-0.1s', 'data-delta': '-0.1' }, '−0.1s'),
    h('button', { class: 'fvp-btn fvp-btn--step', 'data-testid': 'step-plus-0.1s', 'data-delta': '0.1' }, '+0.1s'),
    h('button', { class: 'fvp-btn fvp-btn--step', 'data-testid': 'step-plus-1s', 'data-delta': '1' }, '+1s'),
  );

  // v0.3.2 · 项3：换视频入口（UX-反馈2）——transport 行尾次级按钮，走既有 importFile 链
  // （不同名 → 确认横幅；同名 no-op；队列播放中停队列），videoReady=false 时随 playerPane 隐藏
  const changeVideoBtn = h(
    'button',
    { class: 'fvp-btn fvp-btn--change-video', 'data-testid': 'change-video' },
    '🔄 换视频',
  );

  const timeline: TimelineBar = createTimelineBar({
    onSeek: (t) => controllerRef?.seekPreview(t),
    onSelectSegment: (id) => controllerRef?.selectSegment(id),
  });

  const playerPane = h(
    'section',
    { class: 'player-pane' },
    video,
    h(
      'div',
      { class: 'player__transport' },
      playToggle,
      playModeBadge,
      timeLabel,
      markBtn,
      h('div', { class: 'player__volume-group' }, volumeMute, volumeSlider),
      stepButtons,
      changeVideoBtn,
    ),
    timeline.el,
  );

  const segmentList = h('div', { class: 'segments__list', 'data-testid': 'segment-list' });
  // v0.3.2 · 项4/8 · Phase 1（D 第三形态纯重排）：段详情从 segmentsPane 移出，
  // 主文档流顺序 = player → 段列表 → 队列 → 详情 → share（零新容器、零新增视觉 CSS；
  // 零新容器 = 不引入会被 Phase 3 sheet 化推翻的临时视觉层，D-2 采纳）
  // v0.3.2 · 项8 · Phase 3（sheet 终态）：segment-detail 退役——详情区唯一容器 testid =
  // detail-sheet，关闭钮 sheet-close、遮罩 sheet-scrim（C2 先决条件② 单层统一）。
  // 移动端（<960）底部弹层 + scrim；桌面端（≥960）由 main.ts applyLayout 把 detailSheet
  // 节点移入 aside.editor-aside（grid 第二列 380px，无 scrim 常驻——复用 applyMode 双宿主先例）。
  // 选中态 ⇔ 开合：selectedSegmentId !== null ⇔ open；关闭（下滑 / scrim / 按钮）→ deselectSegment。
  const sheetCloseBtn = h('button', { class: 'fvp-btn detail-sheet__close', 'data-testid': 'sheet-close' }, '关闭');
  const sheetGrip = h('div', { class: 'detail-sheet__grip', 'aria-hidden': 'true' });
  const sheetHead = h('header', { class: 'detail-sheet__head' }, sheetGrip, h('h3', {}, '段落详情'), sheetCloseBtn);
  const detailBody = h('div', { class: 'detail-sheet__body segments__detail' });
  const detailSheet = h(
    'section',
    { class: 'detail-sheet', 'data-testid': 'detail-sheet', hidden: '' },
    sheetHead,
    detailBody,
  );
  const sheetScrim = h('div', { class: 'detail-scrim', 'data-testid': 'sheet-scrim', hidden: '' });
  const segmentsPane = h(
    'section',
    { class: 'segments-pane' },
    h('h2', {}, '段落'),
    segmentList,
  );

  const queueContainer = h('div', { class: 'queue' });
  const queuePane = h('section', { class: 'queue-pane' }, h('h2', {}, '播放队列'), queueContainer);

  // 分享 / 导入区
  const shareOpenBtn = h('button', { class: 'fvp-btn fvp-btn--primary', 'data-testid': 'share-open' }, '🔗 生成分享链接');
  const sharePanel = h('div', { class: 'share__panel' });
  const exportOpenBtn = h('button', { class: 'fvp-btn', 'data-testid': 'export-open' }, '📤 导出配置');
  const importOpenBtn = h('button', { class: 'fvp-btn', 'data-testid': 'import-open' }, '📥 导入配置');
  const keyInput = h('input', {
    type: 'text',
    placeholder: '粘贴分享链接、密钥或配置 JSON',
    'data-testid': 'key-input',
    class: 'share__input',
  }) as HTMLInputElement;
  const keyImportBtn = h('button', { class: 'fvp-btn', 'data-testid': 'key-import' }, '导入密钥');
  const sharePane = h(
    'section',
    { class: 'share-pane' },
    h('h2', {}, '分享与导入'),
    h('div', { class: 'share__file-ops' }, shareOpenBtn, exportOpenBtn, importOpenBtn),
    sharePanel,
    h('div', { class: 'share__import' }, keyInput, keyImportBtn),
    h('p', { class: 'fvp-muted' }, COPY_SOURCE_LIMITS),
  );

  // v0.3.2 · 项8：桌面右栏锚点（≥960 时 applyLayout 把 detailSheet 移入此处，
  // grid 第二列 380px；<960 时空置不占版面——flex 列布局下空 aside 无视觉影响）
  const editorAside = h('aside', { class: 'editor-aside' });
  const editorMain = h('main', { class: 'fvp-editor', 'data-testid': 'editor' }, playerPane, segmentsPane, queuePane, detailSheet, sharePane, editorAside);

  // 空状态（F9 AC2：三步引导 + 文案 A；M3：附接收方「导入配置」入口——
  // 冷启动无本地配置时分享区不可见，拿到 .json 编排文件的接收方从这里进入）
  const emptyPickBtn = h('button', { class: 'fvp-btn fvp-btn--primary fvp-btn--big', 'data-testid': 'empty-pick' }, '📂 选择本地视频');
  const emptyImportBtn = h('button', { class: 'fvp-btn', 'data-testid': 'empty-import' }, '📥 导入编排配置');
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
    h('p', { class: 'fvp-muted' }, '已有练友分享的编排文件（.json）？', emptyImportBtn),
    h('p', { class: 'fvp-muted' }, COPY_SOURCE_LIMITS),
  );

  // 需重新选择视频（恢复 / 密钥配置等待配对）
  const needsVideoText = h('p', { 'data-testid': 'needs-video-text' });

  // v0.3.2 · 项2+10：回收站弹层容器（Phase 3 前简化内联面板；controller 就绪后在 bind 内挂载）
  const recycleRoot = h('div', { class: 'recycle-root' });
  let recycleView: RecycleView | null = null;

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

  const shell = h(
    'div',
    { class: 'fvp' },
    h('header', { class: 'fvp__header' }, h('h1', {}, 'Gymplay · 编辑器'), recycleBinBtn, saveState),
    noticeStack,
    emptyState,
    needsVideoPane,
    editorMain,
    sheetScrim,
    // v0.3.3 · 项1（N-2）：贴底槽是 `position: fixed`，脱离文档流、常驻视口底部。
    // 它不再需要像 sticky 那样依赖「自然位置低于视口底」这一前提，放在文档流哪里
    // 都不影响吸底行为；保留在末尾只为 DOM 顺序直观（视觉上由 fixed 决定）。
    bannerStack,
    // 占位条：fixed 脱离文档流后被遮挡的末尾空间补偿（见 editor.css 同名规则注释）。
    dockSpacer,
    recycleRoot,
  );

  mount(root, shell, fileInput, configFileInput);

  let controllerRef: EditorController | null = null;

  /**
   * v0.3.3 · 项1：把贴底槽实测高度写入 `--fvp-dock-height`。
   *
   * 用途单一：给**固定定位**的通知条（`.fvp-sw-toast`）提供避让量——它无法用文档流
   * 或 sticky 看到贴底槽，只能靠这个变量把底边距整体抬上去，从而保证两者纵向重叠为 0
   *（判据 1-e / X-2）。贴底槽自身的高度由内容决定，不做任何赋值。
   *
   * 写入值取 `bannerStack` 的真实渲染高度（`getBoundingClientRect().height`）；
   * 无横幅时为 0，通知条退回 v0.3.2 的 16px 底边距。
   */
  function syncDockHeight(): void {
    const h = bannerStack.getBoundingClientRect().height;
    // 亚像素高度向上取整：宁多让 1px，也不让通知条压进贴底槽 1px（判据是「重叠 = 0」）
    const px = h > 0 ? Math.ceil(h) : 0;
    // 必须写在 documentElement：`.fvp-sw-toast` 由 ui/sw-update.ts 直接 append 到
    // document.body，它不在 #app 子树内，因此读不到写在 #app / .fvp 上的自定义属性。
    document.documentElement.style.setProperty('--fvp-dock-height', `${px}px`);

    // v0.3.3 · 项1 修订（X-2 补强）：段详情面板打开时，通知条只避让贴底槽是**不够的**。
    // 面板是 `position: fixed; bottom: 0` 且层级 45 < 槽 58，但面板打开时其顶部会
    // 高过贴底槽顶部（实测：提示条 494.6–548.6，与面板重叠 54px、与「删除此段」重叠
    // 43px，按钮中心点过去点到的是「刷新即更新」）。因此避让量要取「槽高」与
    // 「面板露在视口里的高度」两者的较大值。
    // --fvp-sheet-band 由 syncSheetBand() 按面板实测高度写入（不可见时写 0px），
    // 通知条的 bottom 用 max() 复合这两个量（见 base.css `.fvp-sw-toast`）。
    if (!document.documentElement.style.getPropertyValue('--fvp-sheet-band')) {
      document.documentElement.style.setProperty('--fvp-sheet-band', '0px');
    }
  }

  /**
   * v0.3.3 · 项1 修订：把当前可视的段详情面板高度写入 `--fvp-sheet-band`。
   * 只统计面板本身的 `getBoundingClientRect().height`——它就是被 fixed 面板
   * 压在视口底部的那一段；面板隐藏（display:none）时量到 0，自然归零。
   */
  function syncSheetBand(): void {
    const sheet = detailSheet;
    const visible = !sheet.hidden && sheet.getBoundingClientRect().height > 0;
    const px = visible ? Math.ceil(sheet.getBoundingClientRect().height) : 0;
    document.documentElement.style.setProperty('--fvp-sheet-band', `${px}px`);
  }

  function bind(store: Store<AppState>, controller: EditorController): void {
    controllerRef = controller;

    on(fileInput, 'change', () => {
      const file = fileInput.files?.[0];
      if (file) void controller.importFile(file);
      fileInput.value = ''; // 允许重选同一文件触发 change
    });
    on(configFileInput, 'change', () => {
      const file = configFileInput.files?.[0];
      if (file) void controller.importConfigFile(file);
      configFileInput.value = '';
    });
    for (const btn of [emptyPickBtn, needsVideoBtn]) on(btn, 'click', () => fileInput.click());

    // v0.3.2 · 项3：换视频按钮走同一 file-input 通道（确认横幅/同名 no-op/停队列复用既有链）
    on(changeVideoBtn, 'click', () => fileInput.click());
    // v0.3.2 · 项2+10：回收站开合
    on(recycleBinBtn, 'click', () => controller.openRecycle());
    // v0.3.2 · 项8：详情 sheet 关闭三通道（按钮 / scrim / 下滑手势）→ deselectSegment
    on(sheetCloseBtn, 'click', () => controller.deselectSegment());
    on(sheetScrim, 'click', () => controller.deselectSegment());
    // 下滑关闭：sheet 头部（含 grip）按下向下拖 >48px 松手即关；挂头部不与正文
    // 输入控件抢手势。触摸跟手位移为真机走查项（方案「真机走查清单」），此处只保证语义。
    let sheetDragY: number | null = null;
    on(sheetHead, 'pointerdown', (ev) => {
      // 按钮区（关闭钮）不抢手势：指针捕获会把 click 重定向到头部，
      // 按钮自身的 click 将不再触发——须放行
      if (ev.target instanceof Element && ev.target.closest('button')) return;
      const pe = ev as PointerEvent;
      sheetDragY = pe.clientY;
      // 指针捕获：向下拖越出头部（进入正文/页面）后 pointerup 仍回落到头部
      //（鼠标无隐式捕获，触摸有；统一显式捕获，失败不致命）
      try {
        sheetHead.setPointerCapture(pe.pointerId);
      } catch {
        /* pointerId 已失效等场景忽略——手势不成立即可 */
      }
    });
    on(sheetHead, 'pointerup', (ev) => {
      const y0 = sheetDragY;
      sheetDragY = null;
      if (y0 !== null && (ev as PointerEvent).clientY - y0 > SHEET_DRAG_CLOSE_PX) {
        controller.deselectSegment();
      }
    });
    on(sheetHead, 'pointercancel', () => {
      sheetDragY = null;
    });
    recycleView = createRecycleView(controller);
    recycleRoot.append(recycleView.el);
    on(emptyImportBtn, 'click', () => configFileInput.click());
    on(playToggle, 'click', () => controller.togglePlay());
    on(markBtn, 'click', () => controller.mark());
    on(shareOpenBtn, 'click', () => controller.openShare());
    on(exportOpenBtn, 'click', () => controller.exportConfigFile());
    on(importOpenBtn, 'click', () => configFileInput.click());
    on(keyImportBtn, 'click', () => controller.importKeyText(keyInput.value));

    // v0.3.2 · 项1：通知栈 hover/focus 区域级暂停（UX-反馈1）——pointerover/out 与
    // focusin/out 事件委托到 notice-stack，命中 .fvp-notice--info 时暂停/恢复计时。
    const overInfo = (target: EventTarget | null): boolean =>
      target instanceof Element && !!target.closest('.fvp-notice--info');
    on(noticeStack, 'pointerover', (ev) => {
      if (overInfo(ev.target)) controller.pauseNoticeTimers();
    });
    on(noticeStack, 'pointerout', (ev) => {
      if (overInfo(ev.target)) controller.resumeNoticeTimers();
    });
    on(noticeStack, 'focusin', (ev) => {
      if (overInfo(ev.target)) controller.pauseNoticeTimers();
    });
    on(noticeStack, 'focusout', (ev) => {
      if (overInfo(ev.target)) controller.resumeNoticeTimers();
    });

    // v0.3.1 · R2 音量控件：初始化为本机偏好；滑杆拖动实时生效并落盘（R2 AC1/AC3/AC5）
    // R2 AC5 口径补强（复核一 P3-1）：图标呈现「实际可闻状态」——volume=0 等价静音态
    const refreshVolumeIcon = (): void => {
      const p = controller.getVolumePrefs();
      volumeMute.textContent = p.muted || p.volume === 0 ? '🔇' : '🔊';
    };
    const prefs = controller.getVolumePrefs();
    volumeSlider.value = String(Math.round(prefs.volume * 100));
    refreshVolumeIcon();
    on(volumeSlider, 'input', () => {
      const v = Number(volumeSlider.value) / 100;
      controller.setVolume(v);
      refreshVolumeIcon();
    });
    on(volumeMute, 'click', () => {
      const nowMuted = !controller.getVolumePrefs().muted;
      controller.setMuted(nowMuted);
      refreshVolumeIcon();
    });

    // v0.3.1 · v1.1 §7.2 步进按钮：pointerdown 立即步进一档，长按 400ms 后连发，
    // 连发间隔从 200ms 逐次收紧到 60ms；pointerup/cancel/leave 停止（吞掉合成 click）。
    for (const btn of Array.from(stepButtons.querySelectorAll<HTMLButtonElement>('button[data-delta]'))) {
      const delta = Number(btn.dataset.delta);
      let delayTimer: ReturnType<typeof setTimeout> | null = null;
      let repeatTimer: ReturnType<typeof setTimeout> | null = null;
      const clearTimers = (): void => {
        if (delayTimer !== null) clearTimeout(delayTimer);
        if (repeatTimer !== null) clearTimeout(repeatTimer);
        delayTimer = null;
        repeatTimer = null;
      };
      const scheduleRepeat = (interval: number): void => {
        repeatTimer = setTimeout(() => {
          controller.nudgePreview(delta);
          scheduleRepeat(Math.max(STEP_REPEAT_MIN_MS, interval - STEP_REPEAT_DECAY_MS));
        }, interval);
      };
      on(btn, 'pointerdown', () => {
        controller.nudgePreview(delta);
        clearTimers();
        delayTimer = setTimeout(() => scheduleRepeat(STEP_REPEAT_START_MS), STEP_REPEAT_DELAY_MS);
      });
      on(btn, 'pointerup', clearTimers);
      on(btn, 'pointercancel', clearTimers);
      on(btn, 'pointerleave', clearTimers);
      on(btn, 'click', (ev) => ev.preventDefault());
    }

    store.subscribe((state) => render(state, store, controller));
    render(store.get(), store, controller);

    // v0.3.3 · 项1：贴底槽高度随横幅增减而变（撤销条 / 冲突条 / 换视频条 / 存储降级条
    // 各自出现或消失）。ResizeObserver 盯容器自身高度，变化即回写 CSS 变量——
    // 这样 .fvp-sw-toast 的避让量始终与真实槽高一致，不必在每处渲染代码里手工同步。
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => syncDockHeight());
      ro.observe(bannerStack);
    }

    controller.onFrame((t, q) => renderFrame(t, q));
  }

  // ---------- 帧级更新（播放头 / 时间码 / 队列状态行） ----------
  function renderFrame(timeSec: number, q: QueueFrame): void {
    const state = storeRef?.get();
    const cfg = state ? activeConfigOf(state) : null;
    const duration = state?.videoDuration ?? cfg?.video.duration ?? 0;
    // v0.3.1 · R1 AC6：当前时刻恒显一位小数（m:ss.s），时长沿用既有规则
    timeLabel.textContent = `${formatTimeTenth(timeSec)} / ${formatTime(duration)}`;
    playToggle.textContent = video.paused ? '▶ 播放' : '⏸ 暂停';
    // v0.3.2 · 项7+项9：模式徽标三态——audit 优先（「试听 · 段名 · 速率」，橙色）；
    // 队列态恒读队列调度器（q 恒为队列帧，BA-F-4：试听期 queueIndex=-1 不误读）
    if (q.auditSegmentId) {
      const seg = cfg?.segments.find((s) => s.id === q.auditSegmentId);
      playModeBadge.textContent = `试听 · ${seg?.label || '未命名段'} · ${q.auditRate}x`;
      playModeBadge.className = 'fvp-play-mode-badge fvp-play-mode-badge--audit';
    } else if (q.queueIndex >= 0 && q.queueTotal > 0) {
      playModeBadge.textContent = `队列 · 第 ${q.queueIndex + 1}/${q.queueTotal} 项 · ${q.rate}x`;
      playModeBadge.className = 'fvp-play-mode-badge fvp-play-mode-badge--queue';
    } else {
      playModeBadge.textContent = '预览 · 1x';
      playModeBadge.className = 'fvp-play-mode-badge fvp-play-mode-badge--preview';
    }
    // v0.3.1 · v1.1 §5/§7.2：暂停时打点按钮带时刻、步进按钮显示；播放中隐藏步进
    markBtn.textContent = video.paused ? `✚ 打点 ${formatClock(timeSec, duration)}` : '✚ 打点';
    stepButtons.hidden = !video.paused || !state?.videoReady;
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
    // v0.3.3 · 项2：弹层开合（detail / recycle / cockpit）的暂停登记**不在本层**——
    // 唯一登记处是 controller 的 syncViewNoticePause()（见 src/app/controller.ts）。
    // 本层只保留 hover/focus 的 pointerover/out、focusin/out 接线（键 'hover'）。

    // v0.3.2 · 项2+10：回收站入口计数（N = 可恢复删除步数；N=0 隐藏）+ 弹层渲染
    // v0.3.3 · 项3（3-f）：可见性改按**总条数**判定（不再因「全部失效」而隐藏入口）；
    // 文案区分「有 N 条可恢复」与「N 条但都已失效」。口径集中在 undo-counts.ts。
    const counts = readUndoCounts(state);
    recycleBinBtn.hidden = counts.total === 0;
    recycleBinBtn.textContent = recycleBinText(counts);
    recycleView?.render(state);

    // 需配对视频提示
    if (cfg && !state.videoReady) {
      needsVideoText.textContent = `当前编排对应视频文件「${cfg.video.filename}」（${formatTime(cfg.video.duration)}）。本地文件无法跨会话保留，请重新选择同一文件。`;
      needsVideoGuide.textContent = state.configOrigin === 'key' ? COPY_KEY_RECEIVER_GUIDE : '';
    }

    // 播放器区
    markBtn.toggleAttribute('disabled', !state.videoReady);
    playToggle.toggleAttribute('disabled', !state.videoReady);
    shareOpenBtn.toggleAttribute('disabled', cfg === null);
    exportOpenBtn.toggleAttribute('disabled', cfg === null);

    if (cfg) {
      timeline.update({
        duration: state.videoDuration ?? cfg.video.duration,
        segments: cfg.segments,
        selectedId: state.selectedSegmentId,
      });
      renderSegmentList(state, cfg, controller);
      renderSegmentDetail(state, cfg, controller);
      renderQueue(queueContainer, { config: cfg, videoReady: state.videoReady, queuePlaying: state.queuePlaying, auditActive: state.auditSegmentId !== null }, {
        onToggle: (id, inQueue) => controller.toggleQueue(id, inQueue),
        onMove: (from, to) => controller.moveEntry(from, to),
        onDuplicate: (i) => controller.duplicateEntry(i),
        onRemove: (i) => controller.removeEntry(i),
        onLoop: (mode, count) => controller.setLoopMode(mode, count),
        onPlayQueue: () => controller.playQueue(),
        onStopQueue: () => controller.stopQueue(),
        onEnterCockpit: () => controller.enterCockpit(),
        onRate: (id, rate) => controller.setRate(id, rate),
      });
    } else {
      mount(segmentList);
      // v0.3.2 · 项8：无配置 → 详情收起（sheet 与 scrim 一并隐藏）
      detailSheet.hidden = true;
      sheetScrim.hidden = true;
      mount(detailBody);
      mount(queueContainer);
      // v0.3.3 · 项1 修订：面板收起 → 避让量归零
      syncSheetBand();
    }

    renderSharePanel(state, controller);
  }

  // ---------- 通知与横幅 ----------
  function renderBanners(state: AppState, controller: EditorController): void {
    // v0.3.2 · 项1（C1 裁决）：决策横幅（常驻、无计时）挂 banner-stack（文档流原位）
    const decisionNodes: Node[] = [];

    // v0.3.3 · 项3 补丁：恢复前显式确认（P0 回归修复）。
    //
    // 两条「撤销」相关提示的**互斥裁定**：`undoConfirm` 非 null 时**不渲染**撤销横幅
    //（见下方 `state.undoBannerVisible && state.undoConfirm === null` 的短路条件）。
    // 理由：撤销横幅的 [撤销] 也走 `undoDelete`，而确认框 pending 时再点它只会把
    // `state.undoConfirm` 换成另一条目的确认——用户会看到「撤销」与「确认恢复」两个
    // 都在说撤销，点其中一个还会改掉另一个的内容。让确认框独占这段提示区后，
    // 语义链是唯一的一条：[恢复] → 确认框（确认 / 取消）；取消后 `undoBannerVisible`
    // 仍是原值，撤销横幅自然回来，无需额外状态。
    //
    // 挂载位：回收站面板打开时改由 recycle-view 渲染——面板 `.recycle-root` 是
    // `inset: 0` 的全屏覆盖层（层级 60），高于贴底槽 58，挂这里会被整块遮住，
    // 用户看到的仍是「什么都没发生」。此处只在面板收起时挂 banner-stack。
    // 两处条件互斥（`!state.recycleOpen` vs `state.recycleOpen`），
    // 同一时刻 DOM 中只有一份 `undo-confirm-*` 节点，不会出现双按钮。
    if (!state.recycleOpen) {
      const confirmBanner = buildUndoConfirmBanner(state, controller);
      if (confirmBanner) decisionNodes.push(confirmBanner);
    }

    // v0.3.2 · 项2+10：撤销横幅（UX-v1.1-N2 常驻语义）——删除后置顶渲染；
    // [撤销] = undo(栈顶最近可恢复删除)；[知道了] = dismissUndo（栈保留，回收站仍可恢复）
    // v0.3.3 · 项3 补丁：确认框 pending 时让位（互斥裁定见上方注释）。
    if (state.undoBannerVisible && state.undoConfirm === null) {
      const top = topActiveDeletion(state.undoStack);
      if (top) {
        const rest = activeUndoEntries(state.undoStack).filter((e) => e.kind !== 'restore').length - 1;
        const text =
          (top.kind === 'remove-entry' ? `已删除队列项「${top.segLabel}」` : `已删除段「${top.segLabel}」`) +
          (rest > 0 ? `（回收站内还有 ${rest} 步可恢复）` : '');
        const undoBtn = h('button', { class: 'fvp-btn fvp-btn--primary', 'data-testid': 'undo-restore' }, '撤销');
        on(undoBtn, 'click', () => controller.undoDelete(top.id));
        const dismissBtn = h('button', { class: 'fvp-btn', 'data-testid': 'undo-dismiss' }, '知道了');
        on(dismissBtn, 'click', () => controller.dismissUndo());
        decisionNodes.push(
          h(
            'div',
            { class: 'fvp-banner fvp-banner--undo', 'data-testid': 'undo-banner' },
            h('p', {}, text),
            h('div', { class: 'fvp-banner__ops' }, undoBtn, dismissBtn),
          ),
        );
      }
    }

    // F7 AC3 冲突横幅：本地有配置 + 打开分享链接 → 草稿态预览
    if (state.pendingKeyConfig) {
      const applyBtn = h('button', { class: 'fvp-btn fvp-btn--primary', 'data-testid': 'conflict-apply' }, '应用此编排（覆盖本地）');
      on(applyBtn, 'click', () => controller.applyDraft());
      const discardBtn = h('button', { class: 'fvp-btn', 'data-testid': 'conflict-discard' }, '保留我的编排');
      on(discardBtn, 'click', () => controller.discardDraft());
      decisionNodes.push(
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
      decisionNodes.push(
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
      decisionNodes.push(h('div', { class: 'fvp-banner fvp-banner--warn', 'data-testid': 'storage-banner' }, COPY_STORAGE_UNAVAILABLE));
    }

    // v0.3.2 · 项1：通知栈挂 notice-stack（sticky 吸顶）；aria——info 礼貌播报、warn/error 告警
    // v0.3.3 · 项2（2-c）：warn/error 按「同文案折叠计数 + 独立上限 3 条」呈现；
    // 折叠是**纯展示层**行为（foldNotices 不增删 store 里的条目）——info 不折叠，
    // 保持 v0.3.2 的「4 条同文案 info 仍 4 行」既有口径。
    const noticeNodes: Node[] = [];
    for (const item of foldNotices(state.notices)) {
      const ariaAttrs: Record<string, string> =
        item.kind === 'info'
          ? { role: 'status', 'aria-live': 'polite' }
          : { role: 'alert' };
      const close = h('button', { class: 'fvp-notice__close', 'data-testid': `notice-close-${item.ids[0]}` }, '×');
      // 折叠组关闭 = 整组一并关闭（用户点「×」的意思是「这条提示别再显示」）
      on(close, 'click', () => {
        for (const id of item.ids) controller.dismissNotice(id);
      });
      noticeNodes.push(
        h(
          'div',
          {
            class: `fvp-notice fvp-notice--${item.kind}`,
            'data-testid': 'notice',
            'data-kind': item.kind,
            ...(item.count > 1 ? { 'data-fold-count': String(item.count) } : {}),
            ...ariaAttrs,
          },
          h('span', {}, item.text),
          // v0.3.3 · 项2（2-c）：同一文案重复出现 → 「×N」折叠计数（info 永不折叠，count 恒 1）
          ...(item.count > 1 ? [h('span', { class: 'fvp-notice__fold', 'data-testid': 'notice-fold' }, `×${item.count}`)] : []),
          close,
        ),
      );
    }

    mount(bannerStack, ...decisionNodes);
    mount(noticeStack, ...noticeNodes);
    // v0.3.3 · 项1：贴底槽高度写回 CSS 变量（供 .fvp-sw-toast 避让引用，判据 1-e）
    syncDockHeight();
  }

  // ---------- 段落条 + 选中段编辑（v0.3.2 · 项8：renderSegments 拆分为列表 / 详情两个渲染单元） ----------
  function renderSegmentList(state: AppState, cfg: PlayerConfig, controller: EditorController): void {
    const sorted = [...cfg.segments].sort((a, b) => a.start - b.start);
    // v0.3.1 · R3：段落条元信息同步 mm:ss.s 显示（满 1 小时 h:mm:ss.s）
    const segDuration = state.videoDuration ?? cfg.video.duration;
    const items: Node[] = sorted.map((seg, i) => {
      const name = seg.label || `段 ${i + 1}`;
      const btn = h(
        'button',
        {
          class: `segment${seg.id === state.selectedSegmentId ? ' segment--selected' : ''}${seg.inQueue ? '' : ' segment--off'}`,
          'data-testid': `segment-item-${seg.id}`,
        },
        h('span', { class: 'segment__name' }, name),
        h('span', { class: 'segment__meta' }, `${formatClock(seg.start, segDuration)}–${formatClock(seg.end, segDuration)} · ${seg.rate}x${seg.inQueue ? '' : ' · 未勾选'}`),
      );
      on(btn, 'click', () => controller.selectSegment(seg.id));
      // v0.3.2 · 项9：段列表项「试听」快捷入口（BA-F-11：连续对比两段一步可达；
      // 点击一律 startAudition——同段即幂等重启（矩阵 #4），异段即切换目标）
      const auditionBtn = h(
        'button',
        {
          class: `segment__audition${state.auditSegmentId === seg.id ? ' segment__audition--active' : ''}`,
          'data-testid': `audition-seg-${seg.id}`,
          ...(state.videoReady ? {} : { disabled: '' }),
        },
        state.auditSegmentId === seg.id ? '■ 试听中' : '▶ 试听',
      );
      on(auditionBtn, 'click', (ev) => {
        ev.stopPropagation();
        controller.startAudition(seg.id);
      });
      // 外层行容器：避免 button 嵌套 button（HTML 不允许），主条目与快捷入口并排
      return h('div', { class: 'segment-row' }, btn, auditionBtn);
    });
    // v0.3.2 · 项8：原详情区空态引导文案迁移至段列表底部 muted hint（不占 testid，
    // 方案项 4/8 迁移表首行）；仅未选中时出现，与旧空态语义一致
    if (state.selectedSegmentId === null) {
      items.push(h('p', { class: 'fvp-muted segments__hint' }, '点选段落条上的段，设置名称、起止与速度。'));
    }
    mount(segmentList, ...items);
  }

  function renderSegmentDetail(state: AppState, cfg: PlayerConfig, controller: EditorController): void {
    const selected = cfg.segments.find((s) => s.id === state.selectedSegmentId);
    // v0.3.2 · 项8：选中态 ⇔ sheet 开合（selectedSegmentId !== null ⇔ open）；
    // scrim 同步（桌面端 ≥960 由 CSS display:none 常隐，JS 不区分断点）
    detailSheet.hidden = selected === undefined;
    sheetScrim.hidden = selected === undefined;
    if (!selected) {
      mount(detailBody);
      // v0.3.3 · 项1 修订：面板收起 → 避让量归零（否则通知条会永久上抬一段）
      syncSheetBand();
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

    // 起止（v0.3.1 · R3：展示与输入为 mm:ss.s，视频满 1 小时用 h:mm:ss.s；内部存储保持秒）
    const videoDuration = state.videoDuration ?? cfg.video.duration;
    const startText = formatClock(selected.start, videoDuration);
    const endText = formatClock(selected.end, videoDuration);
    const startInput = h('input', {
      type: 'text', value: startText, placeholder: 'mm:ss.s，例如 12:34.5', 'data-testid': 'detail-start',
    }) as HTMLInputElement;
    const endInput = h('input', {
      type: 'text', value: endText, placeholder: 'mm:ss.s，例如 12:34.5', 'data-testid': 'detail-end',
    }) as HTMLInputElement;
    const boundsError = h('p', { class: 'fvp-field-error', 'data-testid': 'detail-bounds-error', hidden: '' });

    const restoreBounds = (): void => {
      startInput.value = startText;
      endInput.value = endText;
    };
    const clearBoundsError = (): void => {
      startInput.classList.remove('fvp-input--error');
      endInput.classList.remove('fvp-input--error');
      boundsError.hidden = true;
      boundsError.textContent = '';
    };
    const showBoundsError = (badStart: boolean, badEnd: boolean, message: string): void => {
      startInput.classList.toggle('fvp-input--error', badStart);
      endInput.classList.toggle('fvp-input--error', badEnd);
      boundsError.textContent = message;
      boundsError.hidden = false;
      // R3 AC5：非法输入恢复原值、不提交；复核一 P3-3b：只恢复非法字段，
      // 另一字段的未提交有效编辑保留（setBounds 拒绝的组合非法路径仍整组恢复，见下）
      if (badStart) startInput.value = startText;
      if (badEnd) endInput.value = endText;
    };

    const commitBounds = (): void => {
      const start = parseTimeInput(startInput.value);
      const end = parseTimeInput(endInput.value);
      if (start === null || end === null) {
        // R3 AC5：无法解析（abc / 12:99 / 空串）→ 标红提示 + 恢复原值 + 不提交
        showBoundsError(start === null, end === null, '时间格式不正确，请用 mm:ss.s（如 12:34.5），满 1 小时用 h:mm:ss.s。');
        return;
      }
      clearBoundsError();
      // R3 AC6：越界 / start≥end / 段重叠 → setBounds 拒绝（通知走既有 warn 通道），UI 恢复原值
      if (!controller.setBounds(selected.id, start, end)) {
        startInput.classList.add('fvp-input--error');
        endInput.classList.add('fvp-input--error');
        restoreBounds();
      }
      // 提交成功：store 更新触发 render，输入框以规范格式重渲染
    };
    on(startInput, 'change', commitBounds);
    on(endInput, 'change', commitBounds);
    on(startInput, 'input', clearBoundsError);
    on(endInput, 'input', clearBoundsError);

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

    // v0.3.2 · 项9 · C4 裁决 A：sheet 内「试听本段」主入口（试听中变「■ 停止试听」）
    const auditingThis = state.auditSegmentId === selected.id;
    const auditionBtn = h(
      'button',
      {
        class: `fvp-btn fvp-btn--primary${auditingThis ? ' fvp-btn--audit-active' : ''}`,
        'data-testid': auditingThis ? 'audition-stop' : 'audition-start',
      },
      auditingThis ? '■ 停止试听' : '▶ 试听本段',
    );
    on(auditionBtn, 'click', () => {
      if (state.auditSegmentId === selected.id) controller.exitAudition();
      else controller.startAudition(selected.id);
    });

    mount(
      detailBody,
      h('h3', {}, `编辑：${selected.label || '未命名段'}`),
      h('label', { class: 'fvp-field' }, '名称', labelInput),
      h('label', { class: 'fvp-muted', 'data-testid': 'pitch-note' }, '变速保调已默认开启（人声音调不随速度变化）。'),
      h('div', { class: 'fvp-row' },
        h('label', { class: 'fvp-field' }, '开始', startInput),
        h('label', { class: 'fvp-field' }, '结束', endInput)),
      boundsError,
      h('div', { class: 'fvp-field' }, '速度档位（队列播放与试听本段生效；自由预览恒 1x）', rateRow, skipZone),
      auditionBtn,
      deleteBtn,
    );

    // v0.3.3 · 项1 修订：面板显隐与高度都变了 → 刷新通知条的避让量（--fvp-sheet-band）。
    // 放在 mount 之后：此时 detailBody 已重排，量到的是本次渲染的真实高度。
    syncSheetBand();
  }

  // ---------- 分享面板（文案 B 确认 → 生成；F8 AC1；P10 超限 → 引导导出） ----------
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
    // P10 降级（M3）：URL 超 1500 判定线 → 不生成链接，引导导出 .json 文件
    if (state.shareExportPrompt) {
      const exportNow = h('button', { class: 'fvp-btn fvp-btn--primary', 'data-testid': 'share-export' }, '📤 导出配置（.json 文件）');
      on(exportNow, 'click', () => controller.exportConfigFile());
      const close = h('button', { class: 'fvp-btn', 'data-testid': 'share-close' }, '关闭');
      on(close, 'click', () => controller.closeShare());
      mount(
        sharePanel,
        h('div', { class: 'share__confirm', 'data-testid': 'share-too-long' },
          h('p', {}, COPY_KEY_TOO_LONG),
          h('div', { class: 'fvp-banner__ops' }, exportNow, close)),
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

  // v0.3.2 · 项8：详情 sheet 双宿主移动（移动端主文档流 ⇄ 桌面右栏 aside）。
  // 节点移动复用 main.ts applyMode 的 video 双宿主先例——移动的是同一节点实例，
  // 事件与渲染绑定不重建；接线（matchMedia 监听）在 main.ts。
  function applyLayout(desktop: boolean): void {
    if (desktop) {
      editorAside.append(detailSheet);
    } else {
      // 移动端宿主位 = Phase 1 主文档流顺序（queue 之后、share 之前）
      editorMain.insertBefore(detailSheet, sharePane);
    }
  }

  return { root, video, bind, applyLayout };
}
