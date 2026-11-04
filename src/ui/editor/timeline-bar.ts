/**
 * L5 · 时间刻度条（定稿 §2.1 波形替代方案）。
 * 仅按 video.duration 渲染时间轴与段边界色块：纯 DOM/CSS、零音频解码、恒定内存。
 *
 * v0.3.1 · R1 可拖动播放头（交互方案 v1.1 垂直距离灵敏度模型）：
 * - 手势分流：按下后位移 < MOVE_SLOP_PX（5px，产品验收口径）视为点击——
 *   色块点击 = 选中该段（F2 AC2 语义不破），空白点击 = seek（F2 AC1 不破）；
 *   水平位移 ≥ 5px 且水平分量大于垂直分量 → 进入 scrub 寻址，本次手势不再触发选中；
 * - scrub = 定位预览，不触发段选中、不改变播放状态（拖前播放则松手仍在播放）；
 * - 灵敏度档位由指尖与轨道中心线的垂直距离 d 驱动（不按角度）：d≤32px 1x、
 *   32–96px 精调 1/4、>96px 精调 1/8，8px 迟滞防闪切（阈值均为方案建议值）；
 * - 拖动全程时间气泡实时显示时刻（0.1s）+ 档位文字与颜色徽标；
 * - 垂直滑动起手交给页面滚动（CSS touch-action: pan-y + JS 方向裁决）；
 * - 越界钳制 [0, duration]；scrub 更新走 rAF 节流（每帧至多一次 currentTime 赋值）。
 *
 * v0.3.1 补强（复核一 P2-1 / P2-2 / P3-3a）：
 * - v1.1 §3.1 播放头水滴手柄：≈18×24px 视觉 + 44×44px 隐形命中热区（元素本体即热区，
 *   层级高于色块与刻度）；按住手柄 = 从当前播放位置继续微调（锚定当前时刻，
 *   不跳到按压点重锚定），与「轨道任意位置按下拖动」共存；手柄上轻点为无操作；
 * - v1.1 §3.2 段落边界吸附：拖动落点距段边界 ±8px（1x 档；1/4→±4px、1/8→±2px）
 *   内吸附对齐，吸附瞬间 vibrate(1) 轻触感（与换档触感同口径）；
 * - v1.1 §2 轻点时长口径：按下→抬起 ≥ TAP_MAX_MS（300ms）且未过位移线 →
 *   不算轻点，不触发选中 / seek。
 */

import { h, on } from '../dom';
import {
  GEAR_LABELS,
  GEAR_RATIOS,
  MOVE_SLOP_PX,
  TAP_MAX_MS,
  gearForDistance,
  snapToBoundaries,
  type ScrubGear,
} from './scrub-gear';
import { formatClock } from './time-input';

export interface TimelineModel {
  duration: number;
  segments: Array<{ id: string; start: number; end: number; label: string; rate: number }>;
  selectedId: string | null;
}

export interface TimelineBar {
  el: HTMLElement;
  update(model: TimelineModel): void;
  updatePlayhead(timeSec: number): void;
  destroy(): void;
}

function formatTick(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const sText = Number.isInteger(s) ? String(s) : s.toFixed(1);
  return `${m}:${sText.padStart(2, '0')}`;
}

/** 选一个好看的刻度步长：候选里取使刻度数 ≤12 的最小值。 */
function pickStep(duration: number): number {
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
  for (const c of candidates) if (duration / c <= 12) return c;
  return 3600;
}

const SEGMENT_COLORS = ['#2f6fed', '#34c759', '#ff9f0a', '#af52de', '#ff453a', '#64d2ff'];

/** 档位徽标配色类名（1x 中性 / 精调 1/4 黄 / 精调 1/8 橙，v1.1 §7.3）。 */
const GEAR_CLASSES = ['tl__gear--1x', 'tl__gear--q', 'tl__gear--e'] as const;

function vibrate(): void {
  // 触感提示（吸附/档位切换）；iOS Safari 无此 API → 静默跳过（v1.1 §8）
  try {
    (navigator as { vibrate?: (p: number) => boolean }).vibrate?.(1);
  } catch {
    /* 静默 */
  }
}

export function createTimelineBar(callbacks: {
  onSeek(timeSec: number): void;
  onSelectSegment(id: string): void;
}): TimelineBar {
  let model: TimelineModel = { duration: 0, segments: [], selectedId: null };

  // v1.1 §3.1：播放头 = 2px 竖线 + 顶部水滴手柄（44×44px 隐形热区，层级最高）
  const playhead = h(
    'div',
    { class: 'tl__playhead', 'data-testid': 'timeline-playhead' },
    h('div', { class: 'tl__playhead-grip', 'data-testid': 'timeline-playhead-grip' }),
  );
  const track = h('div', { class: 'tl__track', 'data-testid': 'timeline' }, playhead);
  // 气泡挂在 .tl 上（track 有 overflow:hidden，气泡需溢出到轨道上方）
  const bubble = h(
    'div',
    { class: 'tl__bubble', 'data-testid': 'scrub-bubble', hidden: '' },
    h('span', { class: 'tl__bubble-time', 'data-testid': 'scrub-time' }),
    h('span', { class: 'tl__gear tl__gear--1x', 'data-testid': 'scrub-gear' }),
  );
  const el = h('div', { class: 'tl' }, track, bubble);

  // ---------- 手势状态 ----------
  interface Gesture {
    pointerId: number;
    startX: number;
    startY: number;
    /** 按下时刻（ev.timeStamp），轻点时长口径（v1.1 §2） */
    startTime: number;
    /** 按下点在播放头手柄热区内：锚定当前播放位置微调，不跳到按压点 */
    grabPlayhead: boolean;
    scrubbing: boolean;
  }
  let gesture: Gesture | null = null;
  let suppressClick = false;
  let gear: ScrubGear = 0;
  let anchorX = 0;
  let anchorTime = 0;
  let rafId = 0;
  let pending: { x: number; y: number } | null = null;
  /** 当前播放头时刻（updatePlayhead 维护），供手柄拖动锚定 */
  let lastPlayheadTime = 0;
  /** 段落边界（秒，升序去重），update(model) 时重建 */
  let boundaries: number[] = [];
  /** 当前吸附到的边界；吸附态变化时触发触感 */
  let snappedBoundary: number | null = null;

  const bubbleTime = bubble.querySelector('[data-testid="scrub-time"]') as HTMLElement;
  const gearBadge = bubble.querySelector('[data-testid="scrub-gear"]') as HTMLElement;

  function trackCenterY(): number {
    const rect = track.getBoundingClientRect();
    return rect.top + rect.height / 2;
  }

  function clampTime(t: number): number {
    return Math.min(model.duration, Math.max(0, t));
  }

  function setGearBadge(g: ScrubGear): void {
    gearBadge.textContent = GEAR_LABELS[g];
    gearBadge.classList.remove(...GEAR_CLASSES);
    gearBadge.classList.add(GEAR_CLASSES[g]);
  }

  /** scrub 主逻辑：按垂直距离定档（含迟滞与换档重锚定），按水平位移寻址。 */
  function applyScrub(x: number, y: number): void {
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0 || model.duration <= 0) return;

    // v1.1 §7.3：垂直距离驱动档位（向下为正，向上按 0 计），不按角度
    const d = Math.max(0, y - trackCenterY());
    const nextGear = gearForDistance(d, gear);
    const secPerPx = model.duration / rect.width;
    // 时刻 = 锚定时刻 + 相对锚点的水平位移 × 灵敏度；锚点在档位不变时保持不动
    const rawT = clampTime(anchorTime + (x - anchorX) * secPerPx * GEAR_RATIOS[gear]);
    // v1.1 §3.2：距段边界 ±8px（随精调档缩小到 ±2px）内吸附对齐
    const snapped = snapToBoundaries(rawT, boundaries, secPerPx, gear);
    const t = snapped ?? rawT;
    if (snapped !== snappedBoundary) {
      // 吸附瞬间轻触感（与换档同口径 navigator.vibrate?.(1)，v1.1 §8）
      if (snapped !== null) vibrate();
      snappedBoundary = snapped;
    }
    if (nextGear !== gear) {
      // 换档瞬间以当前（吸附后）时刻与触点重锚定，避免灵敏度突变导致播放头跳变；轻触感提示
      anchorX = x;
      anchorTime = t;
      gear = nextGear;
      vibrate();
    }
    callbacks.onSeek(t);

    // 气泡：时刻 + 档位徽标，跟随手指横向位置（钳制在轨道内），位于轨道上方
    bubbleTime.textContent = formatClock(t, model.duration);
    setGearBadge(gear);
    const bx = Math.min(rect.width, Math.max(0, x - rect.left));
    bubble.style.left = `${bx}px`;
  }

  function scheduleScrub(x: number, y: number): void {
    pending = { x, y };
    if (rafId === 0) {
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const p = pending;
        pending = null;
        if (p && gesture?.scrubbing) applyScrub(p.x, p.y);
      });
    }
  }

  function beginScrub(x: number): void {
    if (!gesture) return;
    gesture.scrubbing = true;
    gear = 0;
    snappedBoundary = null;
    const rect = track.getBoundingClientRect();
    anchorX = x;
    if (gesture.grabPlayhead) {
      // v1.1 §3.1：按住手柄 = 从当前播放位置继续微调（不跳到按压点重锚定）
      anchorTime = clampTime(lastPlayheadTime);
    } else {
      const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (x - rect.left) / rect.width)) : 0;
      anchorTime = clampTime(ratio * model.duration);
    }
    try {
      track.setPointerCapture(gesture.pointerId);
    } catch {
      /* 部分环境不支持时静默 */
    }
    track.classList.add('tl__track--scrubbing');
    bubble.hidden = false;
    setGearBadge(0);
    bubbleTime.textContent = formatClock(anchorTime, model.duration);
    const bx = rect.width > 0 ? Math.min(rect.width, Math.max(0, x - rect.left)) : 0;
    bubble.style.left = `${bx}px`;
    callbacks.onSeek(anchorTime);
  }

  function endScrub(): void {
    // 松手时先落实最后一帧待处理的拖动位置，再清理 rAF（落点以松手位置为准）
    if (rafId !== 0) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (pending && gesture?.scrubbing) applyScrub(pending.x, pending.y);
    pending = null;
    track.classList.remove('tl__track--scrubbing');
    bubble.hidden = true;
    suppressClick = true; // 吞掉本次手势的合成 click（v1.1 §2：拖动优先于点选）
  }

  const offPointerDown = on(track, 'pointerdown', (ev) => {
    if (model.duration <= 0) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    if (gesture) return; // 单指手势，多余触点忽略
    const grabPlayhead =
      (ev.target as HTMLElement).closest?.('[data-testid="timeline-playhead-grip"]') !== null;
    gesture = {
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      startTime: ev.timeStamp,
      grabPlayhead,
      scrubbing: false,
    };
    suppressClick = false;
  });

  const offPointerMove = on(track, 'pointermove', (ev) => {
    if (!gesture || ev.pointerId !== gesture.pointerId) return;
    if (!gesture.scrubbing) {
      const dx = Math.abs(ev.clientX - gesture.startX);
      const dy = Math.abs(ev.clientY - gesture.startY);
      // 方向裁决（v1.1 §6.2）：水平分量主导且位移过线才进 scrub；
      // 垂直主导 → 不干预，页面滚动由 touch-action: pan-y 原生接管
      if (dx >= MOVE_SLOP_PX && dx > dy) beginScrub(ev.clientX);
      else return;
    }
    scheduleScrub(ev.clientX, ev.clientY);
  });

  const offPointerUp = on(track, 'pointerup', (ev) => {
    if (!gesture || ev.pointerId !== gesture.pointerId) return;
    if (gesture.scrubbing) {
      endScrub();
    } else if (gesture.grabPlayhead || ev.timeStamp - gesture.startTime >= TAP_MAX_MS) {
      // 手柄上轻点 = 已落在当前播放位置，吞 click 防 seek 跳变；
      // 长按（≥300ms）未过位移线 = 非轻点（v1.1 §2），不触发选中 / seek
      suppressClick = true;
    }
    gesture = null;
  });

  const offPointerCancel = on(track, 'pointercancel', (ev) => {
    if (!gesture || ev.pointerId !== gesture.pointerId) return;
    if (gesture.scrubbing) endScrub();
    gesture = null;
  });

  const offClick = on(track, 'click', (ev) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const segEl = (ev.target as HTMLElement).closest('[data-seg-id]') as HTMLElement | null;
    if (segEl?.dataset.segId) {
      // 段色块点击 → 选中（控制器跳到段起点并播放，F2 AC2）
      callbacks.onSelectSegment(segEl.dataset.segId);
      return;
    }
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0 || model.duration <= 0) return;
    const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    callbacks.onSeek(ratio * model.duration);
  });

  function update(next: TimelineModel): void {
    model = next;
    // 保留 playhead 节点，重建其余子元素
    for (const child of [...track.children]) {
      if (child !== playhead) child.remove();
    }
    const { duration, segments } = model;
    // 吸附边界集（v1.1 §3.2）：各段 start/end 去重升序
    boundaries = [...new Set(segments.flatMap((seg) => [seg.start, seg.end]))].sort((a, b) => a - b);
    if (duration <= 0) return;

    // 段色块（放下层）
    const sorted = [...segments].sort((a, b) => a.start - b.start);
    sorted.forEach((seg, i) => {
      const block = h('div', {
        class: `tl__seg${seg.id === model.selectedId ? ' tl__seg--selected' : ''}`,
        'data-seg-id': seg.id,
        'data-testid': `timeline-seg-${seg.id}`,
        title: `${seg.label || `段 ${i + 1}`} ${formatTick(seg.start)}–${formatTick(seg.end)} · ${seg.rate}x`,
      });
      block.style.left = `${(seg.start / duration) * 100}%`;
      block.style.width = `${((seg.end - seg.start) / duration) * 100}%`;
      block.style.background = SEGMENT_COLORS[i % SEGMENT_COLORS.length];
      track.insertBefore(block, playhead);
    });

    // 刻度（最上层，pointer-events 交给 CSS 关闭以免挡点击）
    const step = pickStep(duration);
    for (let t = 0; t <= duration + 1e-9; t += step) {
      const tick = h('div', { class: 'tl__tick' });
      tick.style.left = `${(t / duration) * 100}%`;
      tick.append(h('span', { class: 'tl__tick-label' }, formatTick(t)));
      track.append(tick);
    }
  }

  function updatePlayhead(timeSec: number): void {
    if (model.duration <= 0) return;
    lastPlayheadTime = Math.min(model.duration, Math.max(0, timeSec));
    playhead.style.left = `${Math.min(1, Math.max(0, timeSec / model.duration)) * 100}%`;
  }

  return {
    el,
    update,
    updatePlayhead,
    destroy() {
      offClick();
      offPointerDown();
      offPointerMove();
      offPointerUp();
      offPointerCancel();
      if (rafId !== 0) cancelAnimationFrame(rafId);
    },
  };
}
