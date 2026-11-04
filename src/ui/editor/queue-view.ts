/**
 * L5 · 队列视图（F5：勾选 / 拖拽排序 / 重复段 / 循环设置）。
 *
 * 队列 = sequence 的有序引用（同段可出现多次 = 重复段）；
 * 勾选是段级属性（inQueue），同段的多个队列项共享勾选态（F5 AC1：取消勾选
 * 不删配置、sequence 不动，重新勾选恢复原位）。
 * 拖拽用 HTML5 DnD，另配 ▲▼ 按钮兜底（触屏与可访问性）。
 */

import type { PlayerConfig } from '../../core/config/schema';
import { h, mount, on } from '../dom';
import { RATE_PRESETS_NORMAL, RATE_PRESETS_SKIP } from '../rate-presets';

export interface QueueCallbacks {
  onToggle(id: string, inQueue: boolean): void;
  onMove(from: number, to: number): void;
  onDuplicate(index: number): void;
  onRemove(index: number): void;
  onLoop(mode: PlayerConfig['loop']['mode'], count?: number): void;
  onPlayQueue(): void;
  onStopQueue(): void;
  /** M2：进入练时驾驶舱（F6） */
  onEnterCockpit(): void;
  /** v0.3.2 · 项5：队列项内快捷调速 → 既有 setRate（调速即停队列语义保留） */
  onRate(id: string, rate: number): void;
}

export interface QueueModel {
  config: PlayerConfig;
  videoReady: boolean;
  queuePlaying: boolean;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const sText = Number.isInteger(s) ? String(s) : s.toFixed(1);
  return `${m}:${sText.padStart(2, '0')}`;
}

/** 队列项视图模型：sequence 顺序展开，同段重复出现标注第几轮。 */
export function queueEntries(cfg: PlayerConfig): Array<{
  id: string;
  label: string;
  start: number;
  end: number;
  rate: number;
  inQueue: boolean;
  occurrence: number;
  totalOccurrences: number;
}> {
  const byId = new Map(cfg.segments.map((s) => [s.id, s]));
  const totals = new Map<string, number>();
  for (const ref of cfg.sequence) totals.set(ref, (totals.get(ref) ?? 0) + 1);
  const seen = new Map<string, number>();
  return cfg.sequence.map((ref) => {
    const seg = byId.get(ref);
    const occurrence = (seen.get(ref) ?? 0) + 1;
    seen.set(ref, occurrence);
    return {
      id: ref,
      label: seg?.label || '（未命名段）',
      start: seg?.start ?? 0,
      end: seg?.end ?? 0,
      rate: seg?.rate ?? 1,
      inQueue: seg?.inQueue ?? true,
      occurrence,
      totalOccurrences: totals.get(ref) ?? 1,
    };
  });
}

export function renderQueue(container: HTMLElement, model: QueueModel, cb: QueueCallbacks): void {
  const { config, videoReady, queuePlaying } = model;
  const entries = queueEntries(config);
  const playableCount = entries.filter((e) => e.inQueue).length;

  const children: Node[] = [];

  // 状态行（队列播放时由 frame 高频更新文本）
  const status = h('div', {
    class: 'queue__status',
    'data-testid': 'queue-status',
    'data-playing': queuePlaying ? 'true' : 'false',
  });
  status.textContent = queuePlaying ? '队列播放中…' : playableCount > 0 ? `队列共 ${playableCount} 项待播` : '队列为空（勾选段落以启用播放）';
  children.push(status);

  // 播放控制
  const playBtn = h(
    'button',
    {
      class: 'fvp-btn fvp-btn--primary',
      'data-testid': 'play-queue',
      ...(videoReady && playableCount > 0 && !queuePlaying ? {} : { disabled: '' }),
    },
    '▶ 播放队列',
  );
  on(playBtn, 'click', () => cb.onPlayQueue());
  const stopBtn = h(
    'button',
    { class: 'fvp-btn', 'data-testid': 'stop-queue', ...(queuePlaying ? {} : { disabled: '' }) },
    '■ 停止',
  );
  on(stopBtn, 'click', () => cb.onStopQueue());
  const cockpitBtn = h(
    'button',
    {
      class: 'fvp-btn fvp-btn--cockpit',
      'data-testid': 'enter-cockpit',
      ...(videoReady && playableCount > 0 ? {} : { disabled: '' }),
    },
    '🥊 进入驾驶舱',
  );
  on(cockpitBtn, 'click', () => cb.onEnterCockpit());
  children.push(h('div', { class: 'queue__controls' }, playBtn, stopBtn, cockpitBtn));

  // 队列项列表
  const list = h('ol', { class: 'queue__list', 'data-testid': 'queue-list' });
  let dragFrom = -1;
  entries.forEach((e, i) => {
    const checkbox = h('input', {
      type: 'checkbox',
      'data-testid': `queue-check-${i}`,
      ...(e.inQueue ? { checked: '' } : {}),
    }) as HTMLInputElement;
    on(checkbox, 'change', () => cb.onToggle(e.id, checkbox.checked));

    const labelText = `${e.label}${e.totalOccurrences > 1 ? `（第 ${e.occurrence} 轮）` : ''} · ${formatTime(e.start)}–${formatTime(e.end)} · ${e.rate}x`;

    const up = h('button', { class: 'fvp-btn fvp-btn--mini', 'data-testid': `queue-up-${i}`, title: '上移' }, '▲');
    on(up, 'click', () => cb.onMove(i, i - 1));
    const down = h('button', { class: 'fvp-btn fvp-btn--mini', 'data-testid': `queue-down-${i}`, title: '下移' }, '▼');
    on(down, 'click', () => cb.onMove(i, i + 1));
    const dup = h('button', { class: 'fvp-btn fvp-btn--mini', 'data-testid': `queue-dup-${i}`, title: '重复此段（同段再练一遍）' }, '重复');
    on(dup, 'click', () => cb.onDuplicate(i));
    const del = h('button', { class: 'fvp-btn fvp-btn--mini', 'data-testid': `queue-del-${i}`, title: '从队列移除（段配置保留）' }, '移除');
    on(del, 'click', () => cb.onRemove(i));

    const handle = h('span', { class: 'queue__handle', title: '拖拽排序' }, '⠿');

    // v0.3.2 · 项5：队列项内快捷调速 select（档位同详情单一事实源；
    // 3/4 跳过区带后缀；change → 既有 setRate，调速即停队列语义保留）
    const rateSelect = h('select', {
      class: 'queue__rate',
      'data-testid': `queue-rate-${i}`,
      title: '速度档位',
    }) as HTMLSelectElement;
    for (const r of [...RATE_PRESETS_NORMAL, ...RATE_PRESETS_SKIP]) {
      rateSelect.append(
        h('option', { value: String(r) }, r > 2 ? `${r}x（跳过区）` : `${r}x`),
      );
    }
    rateSelect.value = String(e.rate);
    on(rateSelect, 'change', () => {
      const r = Number(rateSelect.value);
      if (Number.isFinite(r) && r !== e.rate) cb.onRate(e.id, r);
    });

    // v0.3.2 · 项5 · UX-v1.1-C3：同段多处出现时常驻联动提示（改之前就需要知道）
    const rateGroup = e.totalOccurrences > 1
      ? h('span', { class: 'queue__rate-group' },
          rateSelect,
          h('span', { class: 'queue__rate-hint', 'data-testid': `queue-rate-hint-${i}` },
            `同段 ${e.totalOccurrences} 处一起变`),
        )
      : rateSelect;

    const item = h(
      'li',
      {
        class: `queue__item${e.inQueue ? '' : ' queue__item--off'}`,
        draggable: 'true',
        'data-testid': `queue-entry-${i}`,
        'data-seg-id': e.id,
      },
      handle,
      checkbox,
      h('span', { class: 'queue__label' }, labelText),
      rateGroup,
      h('span', { class: 'queue__ops' }, up, down, dup, del),
    );
    on(item, 'dragstart', (ev) => {
      dragFrom = i;
      ev.dataTransfer?.setData('text/plain', String(i));
    });
    on(item, 'dragover', (ev) => ev.preventDefault());
    on(item, 'drop', (ev) => {
      ev.preventDefault();
      const from = dragFrom >= 0 ? dragFrom : Number(ev.dataTransfer?.getData('text/plain'));
      if (Number.isInteger(from) && from !== i) cb.onMove(from, i);
      dragFrom = -1;
    });
    list.append(item);
  });
  children.push(list);

  // 循环设置（F5 AC3：整列循环 / 单段循环）
  const loop = config.loop;
  const modes: Array<{ value: PlayerConfig['loop']['mode']; label: string }> = [
    { value: 'off', label: '不循环' },
    { value: 'queue', label: '整列循环' },
    { value: 'segment', label: '单段循环' },
  ];
  const radioGroup = h('div', { class: 'queue__loop', 'data-testid': 'loop-modes' });
  for (const m of modes) {
    const radio = h('input', {
      type: 'radio',
      name: 'loop-mode',
      'data-testid': `loop-${m.value}`,
      ...(loop.mode === m.value ? { checked: '' } : {}),
    }) as HTMLInputElement;
    on(radio, 'change', () => {
      if (radio.checked) cb.onLoop(m.value, loop.count);
    });
    radioGroup.append(h('label', { class: 'queue__loop-label' }, radio, m.label));
  }
  children.push(radioGroup);

  if (loop.mode === 'queue') {
    const countInput = h('input', {
      type: 'number',
      min: '0',
      step: '1',
      value: String(loop.count ?? 0),
      'data-testid': 'loop-count',
    }) as HTMLInputElement;
    on(countInput, 'change', () => {
      const n = Math.max(0, Math.floor(Number(countInput.value) || 0));
      cb.onLoop('queue', n);
    });
    children.push(
      h('label', { class: 'queue__loop-count' }, '循环次数（0 = 无限）：', countInput),
    );
  }

  mount(container, ...children);
}
