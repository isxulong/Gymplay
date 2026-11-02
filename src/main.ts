/**
 * 入口：探测能力 → 装配 → 挂载（M0 空壳：只渲染地基自检信息，无业务 UI）。
 */

import './styles/base.css';
import { bootstrap } from './app/bootstrap';
import { h, mount } from './ui/dom';

const { store } = bootstrap();

function renderShell(): void {
  const root = document.getElementById('app');
  if (!root) return;
  const state = store.get();
  const caps = state.capabilities;
  mount(
    root,
    h('div', { class: 'fvp-shell__title' }, 'Gymplay · 健身分段变速播放器'),
    h(
      'div',
      { class: 'fvp-shell__meta' },
      `M0 地基骨架 · rVFC: ${caps?.rVFC ? '✓' : '✗'} · WakeLock: ${caps?.wakeLock ? '✓' : '✗'} · MediaSession: ${caps?.mediaSession ? '✓' : '✗'} · HEVC: ${caps?.hevc ?? 'unknown'}`,
    ),
    h(
      'div',
      { class: 'fvp-shell__meta' },
      state.config ? `已恢复本地配置（${state.config.segments.length} 段）` : '编辑器与驾驶舱将在 M1 / M2 到来',
    ),
  );
}

renderShell();
store.subscribe(renderShell);

// PWA：注册 Service Worker（仅 cache-first 缓存 app shell 静态资产，定稿 §2.7）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // 注册失败不阻塞使用（如隐私模式）
    });
  });
}
