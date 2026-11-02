/**
 * L0 · iOS 手势解锁管理。
 *
 * P7-A 结论（2026-11 iPhone 实测）：无手势 play() 被拒（预期行为）——
 * 播放器所有交互以用户点击起手。本模块提供一次性手势监听：首个
 * pointerdown / touchend / click 到达时触发 unlock（如预热媒体元素、
 * 恢复 AudioContext），触发后自动摘除。
 */

export type GestureEventName = 'pointerdown' | 'touchend' | 'click';

const GESTURE_EVENTS: GestureEventName[] = ['pointerdown', 'touchend', 'click'];

/**
 * 在 target 上挂一次性手势监听。返回摘除函数（unlock 触发后自动摘除）。
 */
export function armGestureUnlock(target: EventTarget, unlock: () => void): () => void {
  let fired = false;
  const handler = (): void => {
    if (fired) return;
    fired = true;
    disarm();
    unlock();
  };
  const disarm = (): void => {
    for (const type of GESTURE_EVENTS) target.removeEventListener(type, handler);
  };
  for (const type of GESTURE_EVENTS) target.addEventListener(type, handler, { passive: true });
  return disarm;
}
