import type { AppState } from '../../app/state';
import type { EditorController } from '../../app/controller';
import { h, on } from '../dom';

/**
 * v0.3.3 · 项3 补丁：恢复前显式确认的横幅构建器（P0 回归修复）。
 *
 * 背景：controller 侧的两步机制（`undoDelete` 只写 `state.undoConfirm`，`confirmUndo`
 * 才真正提交）是完整的，但 UI 层从未渲染过 `undoConfirm`，也没有任何控件调用
 * `confirmUndo()` / `cancelUndo()`——用户点「恢复」后界面毫无反应，看起来是按钮坏了。
 * 本文件补的就是这条断掉的接线。
 *
 * 为什么抽成独立构建器：确认框有**两个互斥的挂载位**（回收站面板打开时挂面板 sheet 内，
 * 否则挂 banner-stack），两处必须渲染完全相同的节点（同一 testid、同一文案、同一按钮行为）。
 * 抽一处构建函数，避免两个挂载位各写一份而漂移。
 *
 * 文案直接用 `prompt.message`：controller 已经拼好「这条记录之后还有 N 处改动……」，
 * UI 不再二次措辞，保证「确认框说什么」与「确认后实际会做什么」由同一处事实决定。
 */
export function buildUndoConfirmBanner(
  state: AppState,
  controller: EditorController,
): HTMLElement | null {
  const prompt = state.undoConfirm;
  if (!prompt) return null;

  const applyBtn = h('button', { class: 'fvp-btn fvp-btn--primary', 'data-testid': 'undo-confirm-apply' }, '确认恢复');
  on(applyBtn, 'click', () => controller.confirmUndo());

  const cancelBtn = h('button', { class: 'fvp-btn', 'data-testid': 'undo-confirm-cancel' }, '取消');
  on(cancelBtn, 'click', () => controller.cancelUndo());

  // 层级：横幅在文档流内（banner-stack / 面板 sheet 均为文档流原位），无 z-index 诉求。
  return h(
    'div',
    { class: 'fvp-banner fvp-banner--warn', 'data-testid': 'undo-confirm-banner' },
    h('p', {}, prompt.message),
    h('div', { class: 'fvp-banner__ops' }, applyBtn, cancelBtn),
  );
}
