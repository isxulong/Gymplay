/**
 * L4 · 应用状态类型定义（M1 编辑器）。
 * 编辑器 / 驾驶舱两个模式（驾驶舱 UI 在 M2，M1 仅有字段占位）。
 */

import type { PlayerConfig } from '../core/config/schema';
import type { Capabilities } from '../platform/capabilities';

export type AppMode = 'editor' | 'cockpit';

/** 当前生效配置的来源：本地编辑 / 本地恢复 / 分享密钥 */
export type ConfigOrigin = 'local-edit' | 'restored' | 'key';

export type NoticeKind = 'info' | 'warn' | 'error';

export interface Notice {
  id: number;
  kind: NoticeKind;
  text: string;
}

export interface AppState {
  mode: AppMode;
  /** 当前生效配置（本地编辑 / 本地恢复 / 已应用的密钥）；null = 初始空态 */
  config: PlayerConfig | null;
  configOrigin: ConfigOrigin | null;
  /**
   * 本地已有保存配置时又收到 URL 密钥 → 密钥配置以草稿态挂起，
   * 可预览、可试排，显式「应用」后才覆盖本地保存（F7 AC3）；未确认前不写本地存储。
   */
  pendingKeyConfig: PlayerConfig | null;
  capabilities: Capabilities | null;
  /** 本地存储降级为会话内内存保存（文案 F 已提示，R14） */
  storageDegraded: boolean;
  /** 视频已装载进播放器（File 句柄不可持久化，刷新后必为 false） */
  videoReady: boolean;
  videoName: string | null;
  videoDuration: number | null;
  /** 有配置但视频未装载 → 引导重新选择同一文件 */
  needsVideo: boolean;
  selectedSegmentId: string | null;
  /** 队列播放中（SegmentScheduler 持有播放权） */
  queuePlaying: boolean;
  /** F1 AC3：已装载视频时再选新文件 → 待确认「导入新视频将清空当前分段配置」 */
  confirmReplaceOpen: boolean;
  /** 分享面板：文案 B 确认 → 生成链接 */
  shareConfirmOpen: boolean;
  shareLink: string | null;
  notices: Notice[];
}

export const initialState: AppState = {
  mode: 'editor',
  config: null,
  configOrigin: null,
  pendingKeyConfig: null,
  capabilities: null,
  storageDegraded: false,
  videoReady: false,
  videoName: null,
  videoDuration: null,
  needsVideo: false,
  selectedSegmentId: null,
  queuePlaying: false,
  confirmReplaceOpen: false,
  shareConfirmOpen: false,
  shareLink: null,
  notices: [],
};
