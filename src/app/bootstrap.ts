/**
 * L4 · 装配：wire L0–L3 → store（M1 编辑器期）。
 *
 * 装配顺序：能力探测（L0）→ 读 URL 密钥并解码（L3 codec/hash）→
 * 本地恢复（L3 persistence）→ 冲突裁决（F7 AC3）→ 建 store。
 *
 * F7 AC3 冲突规则（定稿 §1.1）：
 * - 本地无配置 + 有密钥 → 密钥直接生效并落本地保存；
 * - 本地有配置 + 有密钥且内容不同 → 密钥以草稿态挂起（pendingKeyConfig），
 *   本地配置仍是生效配置，显式「应用」前不写本地存储；
 * - 密钥与本地内容一致（canonicalize 相等）→ 不触发冲突，视为同一份；
 * - 密钥解析失败 → 不落任何状态，仅提示「链接无效或不完整」（F8 AC4）。
 */

import { canonicalize, decodeKey, COPY_KEY_INVALID } from '../core/config/codec';
import { readKeyFromLocation } from '../core/config/hash';
import { createPersistence, type Persistence } from '../core/config/persistence';
import type { PlayerConfig } from '../core/config/schema';
import { detectCapabilities } from '../platform/capabilities';
import { restoreUndoStack, readUndoRaw, undoCounts } from './undo-store';
import { createStore, type Store } from './store';
import { initialState, type AppState, type Notice } from './state';

export interface AppContext {
  store: Store<AppState>;
  persistence: Persistence;
}

let noticeSeq = 0;
export function nextNoticeId(): number {
  noticeSeq += 1;
  return noticeSeq;
}

export function makeNotice(kind: Notice['kind'], text: string): Notice {
  return { id: nextNoticeId(), kind, text };
}

export function bootstrap(): AppContext {
  const capabilities = detectCapabilities();
  const persistence = createPersistence();
  const notices: Notice[] = [];

  let config: PlayerConfig | null = null;
  let configOrigin: AppState['configOrigin'] = null;
  let pendingKeyConfig: PlayerConfig | null = null;

  // 1. URL 密钥解码（F8 AC4：失败只提示、不落状态）
  const key = readKeyFromLocation();
  let keyConfig: PlayerConfig | null = null;
  if (key !== null) {
    const decoded = decodeKey(key);
    if (decoded.ok) keyConfig = decoded.value;
    else notices.push(makeNotice('error', COPY_KEY_INVALID));
  }

  // 2. 本地恢复（损坏 / 校验失败已被 persistence 静默丢弃，F7 AC2 外延）
  const restored = persistence.load();

  // 3. 冲突裁决（F7 AC3）
  if (restored !== null) {
    config = restored;
    configOrigin = 'restored';
    if (keyConfig !== null && canonicalize(keyConfig) !== canonicalize(restored)) {
      pendingKeyConfig = keyConfig;
    }
  } else if (keyConfig !== null) {
    config = keyConfig;
    configOrigin = 'key';
    persistence.saveNow(keyConfig); // 无本地配置：密钥直接生效并落盘
  }

  // 4. v0.3.2 · 项2+10：撤销栈启动恢复（规则 5）——逐条 validate + 栈顶世界线校验，
  //    任一失败 / 失配 → 整栈丢弃（数据层兜底；会话内的「置灰不清栈」分层在 controller）。
  //    草稿态挂起时本地配置仍是世界线基准（草稿应用 / 丢弃都会清栈，见 controller）。
  const undoRestored = restoreUndoStack(readUndoRaw(), config);
  const undoCountsInit = undoCounts(undoRestored.entries);

  const store = createStore<AppState>({
    ...initialState,
    capabilities,
    config,
    configOrigin,
    pendingKeyConfig,
    needsVideo: config !== null,
    notices,
    undoStack: undoRestored.entries,
    // 项3（判据 3-f）：入口可见性按**总条数**，可恢复条数只用于文案/角标
    undoTotal: undoCountsInit.total,
    undoRecoverable: undoCountsInit.recoverable,
    // 项3（判据 3-d）：上次会话留下的清栈痕迹（真断裂不得静默）
    undoBreak: undoRestored.lastBreak,
    // 重放横幅：栈里有可恢复的删除条目时恢复可见
    undoBannerVisible: undoRestored.entries.some((e) => !e.stale && e.kind !== 'restore'),
  });

  persistence.onDegraded(() => store.update({ storageDegraded: true }));

  return { store, persistence };
}
