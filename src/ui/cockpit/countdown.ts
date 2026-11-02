/**
 * L5 · 驾驶舱超大倒计时（F6 AC1/AC4）。
 *
 * 显示当前段剩余时间：随播放实时递减，已按段倍速折算
 * （调度器 remainingMs = (end - currentTime) / rate）。
 * 纯函数格式化 + 极简 DOM 更新，帧级刷新（rVFC/50ms 轮询）直接改文本，不经 store。
 */

/** ms → "M:SS.d"（十分位秒；练时远距离可读性优先于毫秒精度） */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.round(ms / 100) * 100);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const d = Math.floor((total % 1000) / 100);
  return `${m}:${String(s).padStart(2, '0')}.${d}`;
}

export interface Countdown {
  el: HTMLElement;
  update(ms: number): void;
}

export function createCountdown(): Countdown {
  const el = document.createElement('div');
  el.className = 'cockpit__countdown';
  el.setAttribute('data-testid', 'cockpit-countdown');
  let last = '';
  return {
    el,
    update(ms: number): void {
      const text = formatCountdown(ms);
      if (text !== last) {
        last = text;
        el.textContent = text;
      }
    },
  };
}
