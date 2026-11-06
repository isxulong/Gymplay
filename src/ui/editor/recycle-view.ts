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
import { readUndoCounts, recycleHeadText } from './undo-counts';
import { buildUndoConfirmBanner } from './undo-confirm';

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

    // v0.3.3 · 项3 补丁：计数提到函数开头，空态判定与头部文案复用同一份口径。
    // 空态改按**计数**（排除反向记录）判断而非 `undoStack.length === 0`：
    // 栈里只剩一条反向记录时，后者会出现「头部说 0 条、列表空着却不报『回收站是空的』」。
    const counts = readUndoCounts(state);
    if (counts.total === 0) {
      rows.push(h('p', { class: 'fvp-muted', 'data-testid': 'recycle-empty' }, '回收站是空的。'));
    } else {
      // 新的在顶部（栈顶 = 最近删除，最常被恢复）
      for (let i = state.undoStack.length - 1; i >= 0; i -= 1) {
        const entry = state.undoStack[i];
        // v0.3.3 · 项3 补丁：反向记录不占列表行。
        // 它是 `confirmUndo` 提交恢复时写入的簿记（承载被覆盖的那份当前配置），
        // kind 仍为 'restore' 且不可点（`undoDelete` 的取条条件就是 `kind !== 'restore'`）。
        // 若照常渲染，它会与紧随其后的恢复记录显示成两条逐字相同的
        // 「恢复到删除「X」之前」——用户看到两行一样的条目、却都点不动，比不显示更困惑。
        // 计数口径（undoCounts / readUndoCounts）同步排除它，保证「头部 N 条」与列表行数一致。
        if (entry.reverse === true) continue;
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
    // v0.3.3 · 项3（3-f）：头部计数分两个口径——可恢复 > 0 时沿用原格式
    // 「（N 步可恢复）」；总数 > 0 但全部失效时改说「（N 条，均已失效）」，
    // 避免「入口按总数可见、头部却报 0 步」的自相矛盾。口径来自 undo-counts.ts。
    //
    // v0.3.3 · 项3 补丁：恢复前确认框的**面板内挂载位**。
    // 面板 `.recycle-root` 是 `inset: 0` 的全屏覆盖层（层级 60），高于贴底槽 58——
    // 从面板里点「恢复到删除前」时，落在 banner-stack 的确认框会被面板整块遮住，
    // 用户看到的仍是「什么都没发生」。故面板打开时把同一条横幅渲染进 sheet 文档流
    //（头部之下、列表之上，紧挨触发它的那排条目），与 editor.ts 的挂载位互斥
    //（那边 `!state.recycleOpen` 才挂），同一时刻 DOM 中只有一份 undo-confirm-*。
    const confirmBanner = buildUndoConfirmBanner(state, controller);
    el.replaceChildren(
      h('div', { class: 'recycle__sheet' },
        h('header', { class: 'recycle__head' }, h('h3', {}, recycleHeadText(counts)), closeBtn),
        ...(confirmBanner ? [confirmBanner] : []),
        list,
      ),
    );
  }

  return { el, render };
}
