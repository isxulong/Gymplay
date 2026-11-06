/**
 * L4 · 应用状态类型定义（M1 编辑器）。
 * 编辑器 / 驾驶舱两个模式（驾驶舱 UI 在 M2，M1 仅有字段占位）。
 */

import type { PlayerConfig } from '../core/config/schema';
import type { Capabilities } from '../platform/capabilities';
import type { UndoEntry, UndoBreakRecord } from './undo-store';

export type AppMode = 'editor' | 'cockpit';

/** 当前生效配置的来源：本地编辑 / 本地恢复 / 分享密钥 */
export type ConfigOrigin = 'local-edit' | 'restored' | 'key';

export type NoticeKind = 'info' | 'warn' | 'error';

/**
 * v0.3.3 · 项3：恢复前显式确认载荷。
 * 用户点了一条「不是当前世界线末端」的记录时先落到这里，确认后才提交恢复；
 * `overwritten` 是即将被覆盖的当前配置（会存成一条反向记录，把数据丢失降级为可再撤回）。
 */
export interface UndoConfirmPrompt {
  /** 被点击的条目 id */
  entryId: number;
  /** 该条目的可读标签 */
  segLabel: string;
  /** 恢复会一并回退的、栈内更靠后的可恢复条数 */
  superseded: number;
  /** 当前配置与目标不一致的说明（展示用） */
  message: string;
  /** 被覆盖的当前配置（反向记录的 pre） */
  overwritten: string;
  /** 目标配置（反向记录的 post） */
  targetPost: string;
  /** 截断起点（= 被点击条目在栈中的下标，复用既有 restoreContext.truncateFrom） */
  truncateFrom: number;
}

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
  /**
   * v0.3.2 · 项9：单段试听中的段 id（audit 态运行时字段，不进配置/密钥/快照）。
   * 与 playMode='audit' 同生命周期维护。
   */
  auditSegmentId: string | null;
  /** F1 AC3：已装载视频时再选新文件 → 待确认「导入新视频将清空当前分段配置」 */
  confirmReplaceOpen: boolean;
  /** 分享面板：文案 B 确认 → 生成链接 */
  shareConfirmOpen: boolean;
  shareLink: string | null;
  /** P10 降级：链接超 1500 判定线 → 不生成长链，引导走 .json 导出（M3 接线） */
  shareExportPrompt: boolean;
  notices: Notice[];
  /** 驾驶舱顶部一次性提示（定稿 §1.2 文案 D）：Wake Lock API 缺失 / 请求被拒 */
  wakeLockHint: boolean;
  /** 驾驶舱一次性提示（R13 降级路径）：Media Session 线控不可用 */
  lineControlHint: boolean;
  /**
   * v0.3.2 · 项2+10：撤销世界线栈（运行时镜像，持久化在独立键 fvp:undo-history，
   * 不进分享密钥 / .json 导出；草稿态与存储降级时仅内存）。
   */
  undoStack: UndoEntry[];
  /**
   * v0.3.3 · 项3：栈计数拆分（判据 3-f）。
   * `undoTotal` = 总条数（**入口可见性按它**：哪怕都失效，也要让用户看到「有 N 条历史但均已失效」）；
   * `undoRecoverable` = 可恢复条数（仅用于文案与角标，不再决定入口是否可见）。
   * 与 undoStack 由同一处同步写入（syncUndoStack），避免 UI 自己 filter 造成口径漂移。
   */
  undoTotal: number;
  undoRecoverable: number;
  /**
   * v0.3.3 · 项3：最近一次清栈痕迹（真断裂不得静默，判据 3-d）。
   * null = 本会话未发生清栈（或已被用户确认）。
   */
  undoBreak: UndoBreakRecord | null;
  /**
   * v0.3.3 · 项3：恢复前显式确认（方案 §2.3 第 4 条）。
   * 非 null 时表示「用户点了一条不是当前世界线末端的记录，需确认后才会真正提交」。
   */
  undoConfirm: UndoConfirmPrompt | null;
  /** v0.3.3 · 项2：回收站弹层开合（与段详情面板配对计数用） */
  recycleOpen: boolean;
  /** v0.3.2 · 项2+10：撤销横幅可见性（删除 push → true；dismissUndo / 清栈 / 恢复 → false） */
  undoBannerVisible: boolean;
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
  auditSegmentId: null,
  confirmReplaceOpen: false,
  shareConfirmOpen: false,
  shareLink: null,
  shareExportPrompt: false,
  notices: [],
  wakeLockHint: false,
  lineControlHint: false,
  undoStack: [],
  undoTotal: 0,
  undoRecoverable: 0,
  undoBreak: null,
  undoConfirm: null,
  recycleOpen: false,
  undoBannerVisible: false,
};
