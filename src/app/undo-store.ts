/**
 * L4 · 撤销世界线栈（v0.3.2 · 项2 + 项10：多段撤销历史回收站）。
 *
 * 方案依据：v1.1 融合稿「项 2 + 项 10 · 多段撤销历史回收站（合并设计）」——
 * - 范围：只收删除类（removeSegment / removeEntry）。调速 / 改名 / 边界 / 队列顺序等
 *   编辑不入栈，且按规则 2 在这些编辑发生时清栈（世界线断裂即重启）。
 * - 栈顶世界线门禁（规则 3）：任一恢复入口前置 top.post === canonicalize(activeConfig())；
 *   失配 → 会话内全栈置灰 + 提示（不清栈）；跨会话启动层失配 → 整栈丢弃。
 * - 恢复即编辑（规则 4）：编辑即停 → validate → 经 controller 包装层走既有 commitEdit
 *   （不旁路 store.update + persist）→ 截断被消费的条目（保留只读展示）→ push 恢复记录。
 * - 护栏（规则 6）：QuotaExceeded 丢最旧重试一次；单条序列化 > 64KB 降容为 1 条。
 *
 * 本模块只做纯逻辑 + localStorage 读写，零 DOM、零 core 源码改动。
 */

import { canonicalize } from '../core/config/codec';
import { validate } from '../core/config/schema';
import type { PlayerConfig } from '../core/config/schema';

/** localStorage 键（fvp: 主族，与 fvp:config / fvp:playback 同族；不进分享密钥 / .json 导出） */
export const UNDO_STORAGE_KEY = 'fvp:undo-history';
/** 栈容量上限（超出丢最旧） */
export const UNDO_CAP = 10;
/** 单条序列化字节上限（规则 6 字节护栏） */
export const UNDO_ENTRY_MAX_BYTES = 64 * 1024;

/** 条目类型：删除段 / 删除队列项 / 恢复记录 */
export type UndoKind = 'delete-segment' | 'remove-entry' | 'restore';

export interface UndoEntry {
  /** 自增序号（栈内唯一） */
  id: number;
  /** 毫秒时间戳 */
  createdAt: number;
  kind: UndoKind;
  /** 被删对象的可读标签（段名） */
  segLabel: string;
  /** 删除前 canonicalize(cfg) 字符串（= 恢复目标） */
  pre: string;
  /** 删除后 canonicalize(cfg) 字符串 */
  post: string;
  /** 已随更早的恢复一并回退 → 只读展示、不可再恢复 */
  stale?: boolean;
}

/** localStorage 的最小结构抽象（便于测试注入假存储）。 */
export interface UndoStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): UndoStorage | undefined {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

function isUndoKind(x: unknown): x is UndoKind {
  return x === 'delete-segment' || x === 'remove-entry' || x === 'restore';
}

/** 单条结构校验（结构漂移 / 外部篡改 → 丢弃该条，不让脏数据进栈）。 */
export function isUndoEntry(x: unknown): x is UndoEntry {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    Number.isInteger(e.id) &&
    typeof e.createdAt === 'number' &&
    Number.isFinite(e.createdAt) &&
    isUndoKind(e.kind) &&
    typeof e.segLabel === 'string' &&
    typeof e.pre === 'string' &&
    typeof e.post === 'string' &&
    (e.stale === undefined || typeof e.stale === 'boolean')
  );
}

/** 解析存储载体 `{ v: 1, entries: [...] }`；版本不符 / 损坏 → 空栈。 */
export function parseUndoEntries(raw: string | null): UndoEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const rec = parsed as Record<string, unknown>;
  if (rec.v !== 1) return [];
  if (!Array.isArray(rec.entries)) return [];
  const out: UndoEntry[] = [];
  for (const e of rec.entries) {
    if (isUndoEntry(e)) out.push(e);
  }
  return out;
}

/** 序列化（版本字段前置，防结构漂移）。 */
export function serializeUndoEntries(entries: UndoEntry[]): string {
  return JSON.stringify({ v: 1, entries });
}

/** 读取原始存储串（bootstrap 启动校验用）。 */
export function readUndoRaw(storage: UndoStorage | undefined = defaultStorage()): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(UNDO_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** 读栈（不校验配置合法性，仅结构过滤）。 */
export function loadUndoStack(storage: UndoStorage | undefined = defaultStorage()): UndoEntry[] {
  return parseUndoEntries(readUndoRaw(storage));
}

export type UndoSaveResult = { ok: true } | { ok: false; degraded: true };

/**
 * 写栈（规则 6）：QuotaExceeded → 丢最旧重试一次 → 仍失败 → 降级会话内内存历史
 * （由调用方置 storageDegraded，既有 storage-banner 通道联动）。
 */
export function saveUndoStack(
  entries: UndoEntry[],
  storage: UndoStorage | undefined = defaultStorage(),
): UndoSaveResult {
  if (!storage) return { ok: false, degraded: true };
  try {
    storage.setItem(UNDO_STORAGE_KEY, serializeUndoEntries(entries));
    return { ok: true };
  } catch {
    // 丢最旧重试一次（容量场景：只留最新一条）
    const trimmed = entries.length > 1 ? entries.slice(entries.length - 1) : entries;
    try {
      storage.setItem(UNDO_STORAGE_KEY, serializeUndoEntries(trimmed));
      return { ok: true };
    } catch {
      return { ok: false, degraded: true };
    }
  }
}

/** 栈顶条目（世界线基准）。 */
export function topEntry(entries: UndoEntry[]): UndoEntry | null {
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

/** 栈顶世界线门禁（规则 3）：top.post === 当前生效配置的 canonical。 */
export function undoGate(entries: UndoEntry[], currentCanonical: string | null): boolean {
  const top = topEntry(entries);
  if (!top || currentCanonical === null) return false;
  return top.post === currentCanonical;
}

/** 单条序列化字节数（规则 6 字节护栏）。 */
export function undoEntryBytes(entry: UndoEntry): number {
  return serializeUndoEntries([entry]).length;
}

/**
 * push（规则 1）：
 * - 删除类：栈空 ‖ newEntry.pre === top.post → 追加；否则清栈后 push（世界线断裂即重启）；
 * - restore 类：豁免链式 push 条件（维护 top.post === current 不变量，连按可连续回退）。
 * - 容量：超过 UNDO_CAP 丢最旧。
 */
export function pushUndoEntry(entries: UndoEntry[], entry: UndoEntry): UndoEntry[] {
  // 规则 6：单条超 64KB → 降容为 1 条（只留这条）
  const base = undoEntryBytes(entry) > UNDO_ENTRY_MAX_BYTES ? [] : entries;
  const top = topEntry(base);
  const chainOk = entry.kind === 'restore' || top === null || entry.pre === top.post;
  const next = chainOk ? [...base, entry] : [entry];
  return next.length > UNDO_CAP ? next.slice(next.length - UNDO_CAP) : next;
}

/** 截断保留只读展示（规则 4）：entries[index..] 置灰（stale），不删除。 */
export function markStaleFrom(entries: UndoEntry[], index: number): UndoEntry[] {
  return entries.map((e, i) => (i >= index && !e.stale ? { ...e, stale: true } : e));
}

/** 全栈置灰（规则 3 失配：会话内呈现层——置灰不清栈）。 */
export function markAllStale(entries: UndoEntry[]): UndoEntry[] {
  return entries.map((e) => (e.stale ? e : { ...e, stale: true }));
}

/** 可恢复条目（未置灰）。 */
export function activeUndoEntries(entries: UndoEntry[]): UndoEntry[] {
  return entries.filter((e) => !e.stale);
}

/** 顶部可恢复的「删除类」条目（撤销横幅的指向目标）。 */
export function topActiveDeletion(entries: UndoEntry[]): UndoEntry | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (!e.stale && e.kind !== 'restore') return e;
  }
  return null;
}

export interface UndoRestoreResult {
  /** 通过校验的栈（失败时为空数组） */
  entries: UndoEntry[];
  /** 整栈丢弃（结构损坏 / 逐条校验失败 / 栈顶世界线失配） */
  discarded: boolean;
}

/**
 * 启动恢复（规则 5）：逐条 validate（entry.pre 必须是合法编排）+ 栈顶世界线校验；
 * 任一失败 / 失配 → 整栈丢弃（数据层兜底，与会话内「置灰不清栈」分层）。
 */
export function restoreUndoStack(raw: string | null, currentConfig: PlayerConfig | null): UndoRestoreResult {
  const entries = parseUndoEntries(raw);
  if (entries.length === 0) return { entries: [], discarded: false };
  for (const e of entries) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(e.pre);
    } catch {
      return { entries: [], discarded: true };
    }
    const res = validate(parsed);
    if (!res.ok) return { entries: [], discarded: true };
  }
  if (currentConfig === null) return { entries: [], discarded: true };
  const top = topEntry(entries);
  if (!top || top.post !== canonicalize(currentConfig)) return { entries: [], discarded: true };
  return { entries, discarded: false };
}
