/**
 * v0.3.2 · 项5（BA-F-8）：速度档位单一事实源。
 * 详情面板（editor.ts）与队列项 select（queue-view.ts）同源引用，
 * 避免两处档位集合漂移。行为不变纯提取。
 */

/** F4 AC1 听感跟练区档位 */
export const RATE_PRESETS_NORMAL = [0.5, 0.75, 1, 1.25, 1.5, 2];
/** >2x 跳过区（P4 听测结论，M-1 约束入 UI） */
export const RATE_PRESETS_SKIP = [3, 4];
