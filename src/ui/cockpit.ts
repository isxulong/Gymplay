/**
 * L5 · 练时驾驶舱主视图（M2，F6）。
 *
 * 首屏纪律（F6 AC1「首屏只呈现」）：当前段名 + 超大倒计时 + 三大按钮
 * （上一段 / 暂停继续 / 下一段），无编辑入口、无其他常驻控件。
 * 队列进度与循环切换收在「下滑手势区」面板里，不进首屏。
 *
 * 误触隔离（F6 AC2）：根容器对非按钮区的触点一律吞掉
 * （pointerdown/click 不冒泡到任何播放控制；touch-action: none 禁掉
 * 双击缩放与滚屏）；退出驾驶舱走面板内两步确认，防汗手误触回编辑器。
 *
 * 线控（F6 AC3）：单击中键 = 播放/暂停、双击 = 下一段，经 Media Session
 * 映射（L0 media-session，随进入驾驶舱绑定）；平台不支持时一次性提示
 * （R13 降级路径），跳段用大按钮。
 *
 * 常亮（F6 AC5）：Wake Lock 随播放持有；API 缺失/被拒 → 顶部一次性
 * 文案 D 提示，不阻塞训练。
 *
 * 帧级刷新（倒计时/段名/进度）走 controller.onFrame 直改 DOM，不经 store。
 */

import { compilePlan } from '../core/scheduler/plan';
import type { PlayerConfig } from '../core/config/schema';
import { COPY_WAKE_LOCK_UNAVAILABLE } from '../platform/wake-lock';
import type { EditorController, QueueFrame } from '../app/controller';
import type { AppState } from '../app/state';
import type { Store } from '../app/store';
import { h, mount, on } from './dom';
import { createControls, type CockpitControls } from './cockpit/controls';
import { createCountdown, type Countdown } from './cockpit/countdown';

/** R13 降级提示（平台不支持线控）：一次性，跳段用大按钮 */
export const COPY_LINE_CONTROL_UNAVAILABLE =
  '当前浏览器不支持耳机线控，请使用屏幕上的大按钮播放 / 暂停与跳段。';

const SWIPE_OPEN_PX = 72;
const SWIPE_CLOSE_PX = -72;

export interface CockpitView {
  root: HTMLElement;
  /** 视频元素挂载点（视觉隐藏但保持渲染，引擎与画面帧回调依赖它） */
  videoHost: HTMLElement;
  bind(store: Store<AppState>, controller: EditorController): void;
}

function activeConfigOf(state: AppState): PlayerConfig | null {
  return state.pendingKeyConfig ?? state.config;
}

export function createCockpitView(root: HTMLElement): CockpitView {
  // ---------- 静态骨架 ----------
  const hints = h('div', { class: 'cockpit__hints', 'data-testid': 'cockpit-hints' });
  const segName = h('div', { class: 'cockpit__seg-name', 'data-testid': 'cockpit-seg-name' }, '—');
  const countdown: Countdown = createCountdown();
  const controls: CockpitControls = createControls({
    onPrev: () => controllerRef?.cockpitPrev(),
    onToggle: () => controllerRef?.cockpitToggle(),
    onNext: () => controllerRef?.cockpitNext(),
  });
  const stage = h(
    'section',
    { class: 'cockpit__stage', 'data-testid': 'cockpit-stage' },
    segName,
    countdown.el,
    controls.el,
  );
  const videoHost = h('div', { class: 'cockpit__video-host', 'data-testid': 'cockpit-video-host' });

  // 下滑手势区面板：队列进度 + 循环切换 + 退出（不进首屏）
  const panelHandle = h('div', { class: 'cockpit-panel__handle', 'data-testid': 'cockpit-panel-handle' }, '▲▼ 上滑收起 · 下滑打开');
  const progressText = h('div', { class: 'cockpit-panel__progress', 'data-testid': 'cockpit-progress' });
  const queueList = h('ol', { class: 'cockpit-panel__queue', 'data-testid': 'cockpit-queue-list' });
  const loopBox = h('div', { class: 'cockpit-panel__loop', 'data-testid': 'cockpit-loop-modes' });
  const panelClose = h('button', { class: 'fvp-btn', 'data-testid': 'cockpit-panel-close' }, '收起面板');
  const exitBox = h('div', { class: 'cockpit-panel__exit', 'data-testid': 'cockpit-exit-box' });
  const panel = h(
    'aside',
    { class: 'cockpit-panel', 'data-testid': 'cockpit-panel' },
    panelHandle,
    h('h2', { class: 'cockpit-panel__title' }, '队列进度'),
    progressText,
    queueList,
    loopBox,
    h('div', { class: 'cockpit-panel__footer' }, panelClose, exitBox),
  );

  const shell = h('div', { class: 'cockpit', 'data-testid': 'cockpit' }, hints, stage, videoHost, panel);
  mount(root, shell);

  let controllerRef: EditorController | null = null;
  let storeRef: Store<AppState> | null = null;
  let panelOpen = false;

  // ---------- 下滑手势开面板 / 上滑或按钮收面板 ----------
  function openPanel(): void {
    panelOpen = true;
    panel.classList.add('cockpit-panel--open');
  }
  function closePanel(): void {
    panelOpen = false;
    panel.classList.remove('cockpit-panel--open');
    renderExitBox(); // 收起时复位两步确认，防误触残留
  }

  // 手势只挂在舞台区与面板把手上（面板内容区保留滚动与控件交互）
  let swipeStartY: number | null = null;
  function swipeStart(e: PointerEvent): void {
    swipeStartY = e.clientY;
  }
  function swipeMove(e: PointerEvent): void {
    if (swipeStartY === null) return;
    const dy = e.clientY - swipeStartY;
    if (!panelOpen && dy > SWIPE_OPEN_PX) {
      openPanel();
      swipeStartY = null;
    } else if (panelOpen && dy < SWIPE_CLOSE_PX) {
      closePanel();
      swipeStartY = null;
    }
  }
  function swipeEnd(): void {
    swipeStartY = null;
  }
  for (const zone of [stage, panelHandle]) {
    on(zone, 'pointerdown', swipeStart);
    on(zone, 'pointermove', swipeMove);
    on(zone, 'pointerup', swipeEnd);
    on(zone, 'pointercancel', swipeEnd);
  }

  // F6 AC2 误触隔离：驾驶舱内非按钮区的点击/触摸不改变任何状态。
  // 交互元素只有三大按钮与面板内控件；其余区域触点到这里为止。
  on(shell, 'click', (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('label')) return;
    e.preventDefault();
    e.stopPropagation();
  });

  on(panelClose, 'click', () => closePanel());

  // ---------- 退出（两步确认，误触隔离的一部分） ----------
  let exitArmed = false;
  function renderExitBox(): void {
    exitArmed = false;
    const exitBtn = h('button', { class: 'fvp-btn', 'data-testid': 'cockpit-exit' }, '退出驾驶舱');
    on(exitBtn, 'click', () => {
      if (!exitArmed) {
        exitArmed = true;
        mount(
          exitBox,
          h('span', { class: 'cockpit-panel__exit-hint' }, '退出将停止本次播放，'),
          (() => {
            const confirmBtn = h('button', { class: 'fvp-btn fvp-btn--danger', 'data-testid': 'cockpit-exit-confirm' }, '确认退出');
            on(confirmBtn, 'click', () => controllerRef?.exitCockpit());
            return confirmBtn;
          })(),
          (() => {
            const cancelBtn = h('button', { class: 'fvp-btn', 'data-testid': 'cockpit-exit-cancel' }, '取消');
            on(cancelBtn, 'click', () => renderExitBox());
            return cancelBtn;
          })(),
        );
      }
    });
    mount(exitBox, exitBtn);
  }

  // ---------- 一次性提示（文案 D / R13 降级） ----------
  function renderHints(state: AppState, controller: EditorController): void {
    const nodes: Node[] = [];
    if (state.wakeLockHint) {
      const close = h('button', { class: 'fvp-notice__close', 'data-testid': 'cockpit-hint-close-wakelock' }, '×');
      on(close, 'click', () => controller.dismissHint('wakeLock'));
      nodes.push(
        h('div', { class: 'fvp-notice fvp-notice--warn', 'data-testid': 'cockpit-wakelock-hint' },
          h('span', {}, COPY_WAKE_LOCK_UNAVAILABLE), close),
      );
    }
    if (state.lineControlHint) {
      const close = h('button', { class: 'fvp-notice__close', 'data-testid': 'cockpit-hint-close-linecontrol' }, '×');
      on(close, 'click', () => controller.dismissHint('lineControl'));
      nodes.push(
        h('div', { class: 'fvp-notice fvp-notice--warn', 'data-testid': 'cockpit-linecontrol-hint' },
          h('span', {}, COPY_LINE_CONTROL_UNAVAILABLE), close),
      );
    }
    mount(hints, ...nodes);
  }

  // ---------- 面板结构（队列进度列表 + 循环三态） ----------
  function renderPanelStructure(cfg: PlayerConfig, controller: EditorController): void {
    const plan = compilePlan(cfg);
    mount(
      queueList,
      ...plan.items.map((item, i) =>
        h(
          'li',
          { class: 'cockpit-panel__queue-item', 'data-testid': `cockpit-queue-item-${i}` },
          h('span', { class: 'cockpit-panel__queue-label' }, item.label || '未命名段'),
          h('span', { class: 'cockpit-panel__queue-meta' }, `${formatRange(item.start, item.end)} · ${item.rate}x`),
        ),
      ),
    );

    const modes: Array<{ value: PlayerConfig['loop']['mode']; label: string }> = [
      { value: 'off', label: '不循环' },
      { value: 'queue', label: '整列循环' },
      { value: 'segment', label: '单段循环' },
    ];
    const radioRow = h('div', { class: 'queue__loop' });
    for (const m of modes) {
      const radio = h('input', {
        type: 'radio',
        name: 'cockpit-loop-mode',
        'data-testid': `cockpit-loop-${m.value}`,
        ...(cfg.loop.mode === m.value ? { checked: '' } : {}),
      }) as HTMLInputElement;
      on(radio, 'change', () => {
        if (radio.checked) controller.setLoopLive(m.value, cfg.loop.count);
      });
      radioRow.append(h('label', { class: 'queue__loop-label' }, radio, m.label));
    }
    const loopChildren: Node[] = [h('span', { class: 'fvp-muted' }, '循环：'), radioRow];
    if (cfg.loop.mode === 'queue') {
      const countInput = h('input', {
        type: 'number',
        min: '0',
        step: '1',
        value: String(cfg.loop.count ?? 0),
        'data-testid': 'cockpit-loop-count',
      }) as HTMLInputElement;
      on(countInput, 'change', () => {
        controller.setLoopLive('queue', Math.max(0, Math.floor(Number(countInput.value) || 0)));
      });
      loopChildren.push(h('label', { class: 'queue__loop-count' }, '次数（0 = 无限）：', countInput));
    }
    mount(loopBox, ...loopChildren);
  }

  function formatRange(start: number, end: number): string {
    const fmt = (sec: number): string => {
      const m = Math.floor(sec / 60);
      const s = sec - m * 60;
      const sText = Number.isInteger(s) ? String(s) : s.toFixed(1);
      return `${m}:${sText.padStart(2, '0')}`;
    };
    return `${fmt(start)}–${fmt(end)}`;
  }

  // ---------- 帧级刷新（倒计时 / 段名 / 按钮态 / 进度行，不经 store） ----------
  function renderFrame(q: QueueFrame): void {
    const cfg = storeRef ? activeConfigOf(storeRef.get()) : null;
    const plan = cfg ? compilePlan(cfg) : null;
    const items = plan?.items ?? [];

    // 段名：播放中取当前段；未开播/播完展示队列首项（F6 AC1 当前段名）
    const idx = q.playing ? q.queueIndex : 0;
    const item = items[idx] ?? null;
    segName.textContent = item ? item.label || '未命名段' : '—';

    // 倒计时（F6 AC4：含倍速折算的段剩余时间）；未开播显示首段全长
    const remaining =
      q.playing && q.segmentId
        ? q.remainingMs
        : item
          ? Math.round(((item.end - item.start) / item.rate) * 1000)
          : 0;
    countdown.update(remaining);

    controls.setPaused(!q.playing || q.paused);

    // 进度行 + 当前项高亮
    const loopMode = cfg?.loop.mode ?? 'off';
    const loopText =
      loopMode === 'queue'
        ? ` · 整列循环 第 ${q.loopsDone + 1} 圈`
        : loopMode === 'segment'
          ? ` · 单段循环 已重播 ${q.loopsDone} 次`
          : '';
    progressText.textContent = q.playing
      ? `第 ${q.queueIndex + 1}/${items.length} 项${loopText}`
      : `队列共 ${items.length} 项 · 未开播${loopText}`;
    const children = queueList.children;
    for (let i = 0; i < children.length; i++) {
      children[i].classList.toggle('cockpit-panel__queue-item--active', q.playing && i === q.queueIndex);
    }
  }

  function bind(store: Store<AppState>, controller: EditorController): void {
    controllerRef = controller;
    storeRef = store;
    renderExitBox();
    store.subscribe((state) => {
      renderHints(state, controller);
      const cfg = activeConfigOf(state);
      if (cfg) renderPanelStructure(cfg, controller);
    });
    const cfg = activeConfigOf(store.get());
    renderHints(store.get(), controller);
    if (cfg) renderPanelStructure(cfg, controller);
    controller.onFrame((_t, q) => renderFrame(q));
  }

  return { root, videoHost, bind };
}
