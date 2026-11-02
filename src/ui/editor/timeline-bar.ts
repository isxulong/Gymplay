/**
 * L5 · 时间刻度条（定稿 §2.1 波形替代方案）。
 * 仅按 video.duration 渲染时间轴与段边界色块：纯 DOM/CSS、零音频解码、恒定内存。
 * - 点击空白轨道 → 跳转预览（F2 AC1 点击/拖动进度）；
 * - 点击段色块 → 选中该段（控制器负责跳到段起点并播放，F2 AC2）；
 * - 播放头由 updatePlayhead 高频更新（不重渲染结构）。
 */

import { h, on } from '../dom';

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

export function createTimelineBar(callbacks: {
  onSeek(timeSec: number): void;
  onSelectSegment(id: string): void;
}): TimelineBar {
  let model: TimelineModel = { duration: 0, segments: [], selectedId: null };

  const playhead = h('div', { class: 'tl__playhead', 'data-testid': 'timeline-playhead' });
  const track = h('div', { class: 'tl__track', 'data-testid': 'timeline' }, playhead);
  const el = h('div', { class: 'tl' }, track);

  const offClick = on(track, 'click', (ev) => {
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
    playhead.style.left = `${Math.min(1, Math.max(0, timeSec / model.duration)) * 100}%`;
  }

  return {
    el,
    update,
    updatePlayhead,
    destroy() {
      offClick();
    },
  };
}
