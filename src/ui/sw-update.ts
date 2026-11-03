/**
 * M3 收口 · SW「刷新即更新」接线（定稿 §2.7，设计见 ADR-010）。
 *
 * 页面侧职责：
 * - 注册 SW（失败不阻塞使用，如隐私模式）；
 * - 监听 SW 的 GYMPLAY_SW_UPDATED 消息（新 SW activate 且检测到旧缓存 = 升级），
 *   弹「刷新即更新」提示条，提供「刷新 / 稍后」交互；
 * - 主动探测新版：浏览器默认只在导航或约 24h 后检查 SW 更新，蹲守中的旧 tab
 *   感知不到发版，故页面在可见时立即查、之后每 5 分钟轮询 reg.update()。
 */

import { h } from './dom';

const UPDATE_MSG = 'GYMPLAY_SW_UPDATED';
const POLL_INTERVAL_MS = 5 * 60 * 1000;

interface SwUpdateMessage {
  type: string;
  buildId: string;
}

let notifiedBuildId = '';
let toastEl: HTMLElement | null = null;

function showUpdateToast(buildId: string): void {
  if (toastEl) return; // 提示条已展示，去重
  notifiedBuildId = buildId;
  const version = /-v(.+)$/.exec(buildId)?.[1] ?? buildId;
  const refreshBtn = h('button', { class: 'fvp-sw-toast__btn', type: 'button' }, '刷新');
  const laterBtn = h(
    'button',
    { class: 'fvp-sw-toast__btn fvp-sw-toast__btn--ghost', type: 'button' },
    '稍后',
  );
  toastEl = h(
    'div',
    { class: 'fvp-sw-toast', 'data-testid': 'sw-update-toast', role: 'status' },
    h('span', { class: 'fvp-sw-toast__text' }, `新版本已就绪（v${version}），刷新即更新`),
    refreshBtn,
    laterBtn,
  );
  refreshBtn.addEventListener('click', () => window.location.reload());
  laterBtn.addEventListener('click', () => {
    toastEl?.remove();
    toastEl = null;
  });
  document.body.append(toastEl);
}

export function setupSwUpdatePrompt(): void {
  if (!('serviceWorker' in navigator)) return;
  // 监听器必须在 register() 之前同步挂载在 navigator.serviceWorker 容器上（容器监听不依赖
  // registration）：发版瞬间打开的 tab，导航触发的 SW 更新可能在页面 load 之前就完成
  // activate→postMessage，监听器晚挂则该消息丢失，该 tab 整个发版周期收不到更新提示。
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as Partial<SwUpdateMessage> | null;
    if (data?.type === UPDATE_MSG && data.buildId && data.buildId !== notifiedBuildId) {
      showUpdateToast(data.buildId);
    }
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('sw.js')
      .then((reg) => {
        // 旧 tab 蹲守感知新版：回前台立即查 + 周期轮询
        const checkForUpdate = (): void => {
          reg.update().catch(() => {
            // 更新检查失败（如瞬断）不打扰，下轮再查
          });
        };
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') checkForUpdate();
        });
        window.setInterval(checkForUpdate, POLL_INTERVAL_MS);
      })
      .catch(() => {
        // 注册失败不阻塞使用（如隐私模式）
      });
  });
}
