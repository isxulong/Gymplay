/**
 * L4 · 装配：wire L0–L3 → store → UI（M0 骨架，不含业务 UI）。
 *
 * 装配顺序：能力探测（L0）→ 读 URL 密钥并解码（L3 codec/hash）→
 * 本地恢复（L3 persistence）→ 建 store。F7 AC3 冲突（本地有配置 + 打开分享链接）
 * 在 M0 只落状态（pendingKeyConfig），冲突 UI 在 M1 接线。
 */

import { decodeKey } from '../core/config/codec';
import { readKeyFromLocation } from '../core/config/hash';
import { createPersistence, type Persistence } from '../core/config/persistence';
import { detectCapabilities } from '../platform/capabilities';
import { createStore, type Store } from './store';
import { initialState, type AppState } from './state';

export interface AppContext {
  store: Store<AppState>;
  persistence: Persistence;
}

export function bootstrap(): AppContext {
  const capabilities = detectCapabilities();
  const persistence = createPersistence();

  const store = createStore<AppState>({ ...initialState, capabilities });

  persistence.onDegraded(() => store.update({ storageDegraded: true }));

  // URL 密钥优先解码；与本地草稿的冲突裁决留给 M1（F7 AC3）
  const key = readKeyFromLocation();
  if (key !== null) {
    const decoded = decodeKey(key);
    if (decoded.ok) store.update({ pendingKeyConfig: decoded.value });
    // 解码失败：F8 AC4 文案由 M1 UI 呈现，M0 仅不落状态
  }

  const restored = persistence.load();
  if (restored !== null) store.update({ config: restored });

  return { store, persistence };
}
