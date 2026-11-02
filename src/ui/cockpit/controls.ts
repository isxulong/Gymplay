/**
 * L5 · 驾驶舱三大按钮（F6 AC1：上一段 / 暂停继续 / 下一段）。
 *
 * 练时主姿势是设备放一两米外、手上有汗：按钮超大、整行均分、
 * 图标+文字双标签；按钮区外的触点一律不改变播放状态（F6 AC2 误触隔离
 * 由驾驶舱根容器统一吞掉非按钮区交互，见 cockpit.ts）。
 */

import { h, on } from '../dom';

export interface CockpitControls {
  el: HTMLElement;
  /** 播放/暂停中键图标随引擎状态切换（paused → ▶，播放中 → ⏸） */
  setPaused(paused: boolean): void;
}

export interface CockpitControlsCallbacks {
  onPrev(): void;
  onToggle(): void;
  onNext(): void;
}

export function createControls(cb: CockpitControlsCallbacks): CockpitControls {
  const prev = h(
    'button',
    { class: 'cockpit-btn cockpit-btn--nav', 'data-testid': 'cockpit-prev', 'aria-label': '上一段' },
    h('span', { class: 'cockpit-btn__icon' }, '⏮'),
    h('span', { class: 'cockpit-btn__text' }, '上一段'),
  );
  const toggle = h(
    'button',
    { class: 'cockpit-btn cockpit-btn--toggle', 'data-testid': 'cockpit-toggle', 'aria-label': '暂停 / 继续' },
    h('span', { class: 'cockpit-btn__icon' }, '⏸'),
    h('span', { class: 'cockpit-btn__text' }, '暂停'),
  );
  const next = h(
    'button',
    { class: 'cockpit-btn cockpit-btn--nav', 'data-testid': 'cockpit-next', 'aria-label': '下一段' },
    h('span', { class: 'cockpit-btn__icon' }, '⏭'),
    h('span', { class: 'cockpit-btn__text' }, '下一段'),
  );
  on(prev, 'click', () => cb.onPrev());
  on(toggle, 'click', () => cb.onToggle());
  on(next, 'click', () => cb.onNext());

  const toggleIcon = toggle.querySelector('.cockpit-btn__icon')!;
  const toggleText = toggle.querySelector('.cockpit-btn__text')!;
  return {
    el: h('div', { class: 'cockpit__controls', 'data-testid': 'cockpit-controls' }, prev, toggle, next),
    setPaused(paused: boolean): void {
      toggleIcon.textContent = paused ? '▶' : '⏸';
      toggleText.textContent = paused ? '继续' : '暂停';
    },
  };
}
