/**
 * 入口（M1 编辑器期）：装配（能力探测 / URL 密钥 / 本地恢复 / 冲突裁决）
 * → 构建编辑器骨架 → 绑定控制器。
 * 驾驶舱（mode: 'cockpit'）为 M2 交付物，本入口暂不挂载。
 */

import './styles/base.css';
import './styles/editor.css';
import { bootstrap } from './app/bootstrap';
import { createEditorController } from './app/controller';
import { createEditorView } from './ui/editor';

const { store, persistence } = bootstrap();

const rootEl = document.getElementById('app');
if (rootEl) {
  const view = createEditorView(rootEl);
  const controller = createEditorController({ store, persistence, video: view.video });
  view.bind(store, controller);
}

// PWA：注册 Service Worker（仅 cache-first 缓存 app shell 静态资产，定稿 §2.7）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // 注册失败不阻塞使用（如隐私模式）
    });
  });
}
