/**
 * L5 · 极简 DOM 工具（蓝图 §2.3，约 50 行）。M0 仅供空壳挂载使用；
 * 编辑器 / 驾驶舱组件在 M1 / M2 基于它实现。
 */

type Child = Node | string | null | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const child of children) {
    if (child === null || child === undefined) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

export function on<K extends keyof HTMLElementEventMap>(
  el: HTMLElement,
  type: K,
  listener: (ev: HTMLElementEventMap[K]) => void,
): () => void {
  el.addEventListener(type, listener);
  return () => el.removeEventListener(type, listener);
}

export function mount(root: HTMLElement, ...children: Child[]): void {
  root.replaceChildren(...children.filter((c): c is Node | string => c != null));
}
