/**
 * L3 · URL hash 读写。密钥形如 #c=eyJ2Ijox...。
 * hash 不上行服务器（天然安全，定稿 §2.7 显式纪律）。
 * 纯函数为主，便于 Node 侧单测；location/history 访问集中在底部两个函数。
 */

export const HASH_PARAM = 'c';

/** 从 hash 字符串（含或不含前导 #）中提取密钥；无密钥返回 null。 */
export function extractKeyFromHash(hash: string): string | null {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  if (body === '') return null;
  for (const pair of body.split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    if (pair.slice(0, eq) === HASH_PARAM) {
      const value = pair.slice(eq + 1);
      return value === '' ? null : value;
    }
  }
  return null;
}

/** 由密钥构造 hash 字符串（含 # 前缀）。 */
export function buildHashWithKey(key: string): string {
  return `#${HASH_PARAM}=${key}`;
}

export interface HashLocation {
  hash: string;
}

/** 读取地址栏密钥（浏览器环境下默认取 window.location）。 */
export function readKeyFromLocation(loc?: HashLocation): string | null {
  const target = loc ?? (typeof window !== 'undefined' ? window.location : undefined);
  if (!target) return null;
  return extractKeyFromHash(target.hash);
}

/**
 * 把密钥写回地址栏（replaceState，不触发导航、不产生历史记录）。
 * key 为 null 时清除 #c 参数、保留其余 hash 参数。
 */
export function writeKeyToLocation(key: string | null): void {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  const current = window.location.hash;
  const body = current.startsWith('#') ? current.slice(1) : current;
  const kept = body.split('&').filter((pair) => {
    if (pair === '') return false;
    const eq = pair.indexOf('=');
    return (eq === -1 ? pair : pair.slice(0, eq)) !== HASH_PARAM;
  });
  if (key !== null) kept.push(`${HASH_PARAM}=${key}`);
  const nextHash = kept.length > 0 ? `#${kept.join('&')}` : '';
  const url = `${window.location.pathname}${window.location.search}${nextHash}`;
  window.history.replaceState(null, '', url);
}
