/**
 * L4 · 应用状态类型定义（M0 骨架）。
 * 编辑器 / 驾驶舱两个模式（M1/M2 实现 UI），M0 仅有装配需要的最小形状。
 */

import type { PlayerConfig } from '../core/config/schema';
import type { Capabilities } from '../platform/capabilities';

export type AppMode = 'editor' | 'cockpit';

export interface AppState {
  mode: AppMode;
  /** 当前生效配置（来自 URL 密钥或本地恢复）；null = 初始空态 */
  config: PlayerConfig | null;
  /** 本地有草稿配置时又收到 URL 密钥 → 冲突待用户裁决（F7 AC3，M1 接线） */
  pendingKeyConfig: PlayerConfig | null;
  capabilities: Capabilities | null;
  /** 本地存储降级（文案 F 已提示） */
  storageDegraded: boolean;
}

export const initialState: AppState = {
  mode: 'editor',
  config: null,
  pendingKeyConfig: null,
  capabilities: null,
  storageDegraded: false,
};
