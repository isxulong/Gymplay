/**
 * L5 · 回收站视图（v0.3.2 · 项2+10：多段撤销历史回收站）。
 *
 * 方案口径（v1.1 · 项2+10 UI 节）：
 * - 每条「删除了段『X』 · HH:MM · [恢复到删除前]」，testid recycle-item-{i} /
 *   recycle-restore-{i} / recycle-close（i = 栈数组下标）；
 * - 截断 / 失配条目置灰只读（「已随更早的恢复一并回退」），恢复钮禁用；
 * - storageDegraded 时顶部常驻 warn 行「历史仅本次会话有效」；
 * - Phase 3 前为简化内联面板（底部弹层化与 sheet 组件复用在项 8）。
 */

import type { AppState } from '../../app/state';
import type { EditorController } from '../../app/controller';
import { h, on } from '../dom';

export interface RecycleView {
  el: HTMLElement;
  render(state: AppState): void;
}

function formatClockHM(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function createRecycleView(controller: EditorController): RecycleView {
  const el = h('div', { class: 'recycle', 'data-testid': 'recycle-panel', hidden: '' });

  function render(state: AppState): void {
    el.hidden = !state.recycleOpen;
    if (!state.recycleOpen) return;

    const rows: HTMLElement[] = [];
    // 顶部降级提示（规则 6：存储降级 → 历史仅本次会话有效）
    if (state.storageDegraded) {
      rows.push(h('p', { class: 'recycle__warn fvp-muted', 'data-testid': 'recycle-degraded' }, '⚠ 历史仅本次会话有效'));
    }

    if (state.undoStack.length === 0) {
      rows.push(h('p', { class: 'fvp-muted', 'data-testid': 'recycle-empty' }, '回收站是空的。'));
    } else {
      // 新的在顶部（栈顶 = 最近删除，最常被恢复）
      for (let i = state.undoStack.length - 1; i >= 0; i -= 1) {
        const entry = state.undoStack[i];
        const time = formatClockHM(entry.createdAt);
        const baseText =
          entry.kind === 'remove-entry'
            ? `删除了队列项「${entry.segLabel}」 · ${time}`
            : `删除了段「${entry.segLabel}」 · ${time}`;
        if (entry.stale) {
          // 截断保留只读展示（BA-F-10）：置灰 + 禁用
          rows.push(
            h(
              'li',
              { class: 'recycle__item recycle__item--stale', 'data-testid': `recycle-item-${i}` },
              h('span', { class: 'recycle__label' }, baseText),
              h('span', { class: 'recycle__note', 'data-testid': `recycle-note-${i}` }, '已随更早的恢复一并回退'),
            ),
          );
          continue;
        }
        if (entry.kind === 'restore') {
          rows.push(
            h(
              'li',
              { class: 'recycle__item recycle__item--restore', 'data-testid': `recycle-item-${i}` },
              h('span', { class: 'recycle__label' }, `恢复到删除「${entry.segLabel}」之前 · ${time}`),
            ),
          );
          continue;
        }
        const restoreBtn = h(
          'button',
          { class: 'fvp-btn', 'data-testid': `recycle-restore-${i}` },
          '恢复到删除前',
        );
        on(restoreBtn, 'click', () => controller.undoDelete(entry.id));
        rows.push(
          h(
            'li',
            { class: 'recycle__item', 'data-testid': `recycle-item-${i}` },
            h('span', { class: 'recycle__label' }, baseText),
            restoreBtn,
          ),
        );
      }
    }

    const closeBtn = h('button', { class: 'fvp-btn', 'data-testid': 'recycle-close' }, '关闭');
    on(closeBtn, 'click', () => controller.closeRecycle());
    // 每次全量重挂（条目小频次低，无焦点保留诉求）
    const list = h('ul', { class: 'recycle__list' }, ...rows);
    el.replaceChildren(
      h('div', { class: 'recycle__sheet' },
        h('header', { class: 'recycle__head' }, h('h3', {}, `回收站（${state.undoStack.filter((e) => !e.stale && e.kind !== 'restore').length} 步可恢复）`), closeBtn),
        list,
      ),
    );
  }

  return { el, render };
}
