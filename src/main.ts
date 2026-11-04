/**
 * 入口：装配（能力探测 / URL 密钥 / 本地恢复 / 冲突裁决）→ 构建编辑器与驾驶舱
 * 两个模式视图 → 绑定控制器 → 按 store.mode 切换挂载。
 *
 * M2 起编辑器 / 驾驶舱同页两模式（蓝图 §2.3）：
 * - 同一 <video> 元素在两个宿主间移动（引擎实例不变，播放状态不打断）；
 * - 驾驶舱进出由控制器动作（enterCockpit / exitCockpit）驱动；
 * - 误触隔离（F6 AC2）：驾驶舱内无编辑入口，编辑 DOM 整树隐藏。
 */

import './styles/base.css';
import './styles/editor.css';
import './styles/cockpit.css';
import { bootstrap } from './app/bootstrap';
import { createEditorController } from './app/controller';
import type { AppMode } from './app/state';
import { createEditorView } from './ui/editor';
import { createCockpitView } from './ui/cockpit';
import { setupSwUpdatePrompt } from './ui/sw-update';
import { h } from './ui/dom';

const { store, persistence } = bootstrap();

const rootEl = document.getElementById('app');
if (rootEl) {
  rootEl.replaceChildren();
  const editorHost = h('div', { class: 'fvp-mode-host fvp-mode-host--editor', 'data-testid': 'editor-host' });
  const cockpitHost = h('div', { class: 'fvp-mode-host fvp-mode-host--cockpit', 'data-testid': 'cockpit-host' });
  rootEl.append(editorHost, cockpitHost);

  const editorView = createEditorView(editorHost);
  const cockpitView = createCockpitView(cockpitHost);
  const controller = createEditorController({ store, persistence, video: editorView.video });
  editorView.bind(store, controller);
  cockpitView.bind(store, controller);

  // video 元素原位（编辑器播放器区第一个子元素），模式切换时在两个宿主间移动
  const editorVideoParent = editorView.video.parentElement;
  let currentMode: AppMode = store.get().mode;
  const applyMode = (mode: AppMode): void => {
    currentMode = mode;
    editorHost.hidden = mode !== 'editor';
    cockpitHost.hidden = mode !== 'cockpit';
    if (mode === 'cockpit') {
      cockpitView.videoHost.append(editorView.video);
    } else {
      editorVideoParent?.prepend(editorView.video);
    }
  };
  applyMode(currentMode);
  store.subscribe((state) => {
    if (state.mode !== currentMode) applyMode(state.mode);
  });

  // v0.3.2 · 项8（Phase 3）：960px 桌面断点接线——detailSheet 双宿主移动。
  // 复用上方 applyMode 的节点移动先例（同一节点实例在两个宿主间移动，绑定不重建）：
  // ≥960 → aside.editor-aside（grid 第二列 380px，无 scrim）；<960 → 主文档流
  //（queue 之后、share 之前）。断点值 960 为方案 D-2 设计值（与 720px 容器现状衔接）。
  const desktopQuery = window.matchMedia('(min-width: 960px)');
  const applyLayout = (): void => editorView.applyLayout(desktopQuery.matches);
  applyLayout();
  desktopQuery.addEventListener('change', applyLayout);
}

// PWA：注册 SW + 「刷新即更新」提示接线（定稿 §2.7，设计见 ADR-010）
setupSwUpdatePrompt();
