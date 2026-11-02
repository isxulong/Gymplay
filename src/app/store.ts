/**
 * L4 · 手写迷你 Store（蓝图 §2.3，约 50 行）：单一不可变状态容器 + 发布订阅。
 * state 是普通对象，更新走显式 action 函数，UI 订阅快照渲染。
 */

export type Listener<T> = (state: Readonly<T>) => void;

export interface Store<T> {
  get(): Readonly<T>;
  /** 以补丁对象更新（浅合并），随后通知全部订阅者。 */
  update(patch: Partial<T>): void;
  subscribe(listener: Listener<T>): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = Object.freeze({ ...initial });
  const listeners = new Set<Listener<T>>();
  return {
    get: () => state,
    update(patch) {
      state = Object.freeze({ ...state, ...patch });
      for (const listener of listeners) listener(state);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
