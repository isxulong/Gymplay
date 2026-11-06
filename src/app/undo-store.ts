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
 * - 护栏（规则 6，v0.3.3 · 项3 修订）：单条序列化 UTF-8 > 64KB → 拒收该条、原栈保留（见 push 注释）；
 *   QuotaExceeded → **渐进降容**（二分找出「能写完的最大保留条数」，按需丢最旧），
 *   丢弃条数经返回值 `dropped` 回报调用方；一条都写不进才降级会话内内存历史。
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
  /**
   * v0.3.3 · 项3：本条入栈时与上一条的链不连续（中间发生过不入栈的编辑）。
   * 仅为可追溯标记，不影响逐条适用性；旧版本代码忽略之（向后兼容的可选字段）。
   */
  chainBroken?: boolean;
  /**
   * v0.3.3 · 项3：反向记录标记——本条记录承载的是「被恢复覆盖掉的那份当前配置」，
   * 供用户再撤回这次恢复。kind 仍为 'restore'（旧版本读到时按普通恢复记录只读展示，不抛错）。
   */
  reverse?: boolean;
  /** v0.3.3 · 项3：损坏原因（按条置灰时写入，供展示与审计）。 */
  invalidReason?: string;
}

/** 清栈原因分类（项3 三分类 + 容量/链断两个补充来源）。 */
export type UndoBreakKind = 'total' | 'broken' | 'capacity';

/**
 * 清栈痕迹（项3 判据 3-d「真断裂仍清栈且有痕迹」）。
 * 落在存储载体的顶层可选字段 `lastBreak` 上：旧版本 parseUndoEntries 只认 v 与 entries，
 * 不认识该字段即忽略，不抛错（3-i 向后兼容）。
 */
export interface UndoBreakRecord {
  kind: UndoBreakKind;
  /** 可读原因（展示 / 审计） */
  reason: string;
  /** 发生时刻（毫秒） */
  at: number;
  /** 被清掉的条数 */
  dropped: number;
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
    (e.stale === undefined || typeof e.stale === 'boolean') &&
    // v0.3.3 · 项3：三个新增字段均为可选；出现时必须是正确类型（脏值 → 丢弃该条）
    (e.chainBroken === undefined || typeof e.chainBroken === 'boolean') &&
    (e.reverse === undefined || typeof e.reverse === 'boolean') &&
    (e.invalidReason === undefined || typeof e.invalidReason === 'string')
  );
}

/**
 * 解析存储载体 `{ v: 1, entries: [...], lastBreak?: {...} }`；版本不符 / 损坏 → 空栈。
 *
 * 硬校验 `rec.v === 1`：**不许升级版本号**——旧代码（v0.3.2）读到 v≠1 会整栈丢弃，
 * 任何 v:2 升级都会让回滚变成静默数据丢失。项3 的新增内容全部走 entries 内的可选字段
 * 与顶层可选字段 `lastBreak`，旧代码对二者一律忽略（判据 3-i）。
 */
export function parseUndoEntries(raw: string | null): UndoEntry[] {
  return parseUndoRecord(raw).entries;
}

/** 解析完整载体（含清栈痕迹）；旧代码只认 `v` 与 `entries`，多出的 `lastBreak` 被忽略。 */
export function parseUndoRecord(raw: string | null): { entries: UndoEntry[]; lastBreak: UndoBreakRecord | null } {
  if (!raw) return { entries: [], lastBreak: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [], lastBreak: null };
  }
  if (typeof parsed !== 'object' || parsed === null) return { entries: [], lastBreak: null };
  const rec = parsed as Record<string, unknown>;
  if (rec.v !== 1) return { entries: [], lastBreak: null };
  if (!Array.isArray(rec.entries)) return { entries: [], lastBreak: null };
  const out: UndoEntry[] = [];
  for (const e of rec.entries) {
    if (isUndoEntry(e)) out.push(e);
  }
  return { entries: out, lastBreak: isUndoBreakRecord(rec.lastBreak) ? rec.lastBreak : null };
}

/** 清栈痕迹结构校验（脏痕迹 → 忽略，不影响栈本体）。 */
export function isUndoBreakRecord(x: unknown): x is UndoBreakRecord {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    (r.kind === 'total' || r.kind === 'broken' || r.kind === 'capacity') &&
    typeof r.reason === 'string' &&
    typeof r.at === 'number' &&
    Number.isFinite(r.at) &&
    typeof r.dropped === 'number' &&
    Number.isFinite(r.dropped)
  );
}

/**
 * 序列化（版本字段前置，防结构漂移）。
 * `lastBreak` 为可选第二参：不传时输出与 v0.3.2 完全相同的 `{ v: 1, entries }`。
 */
export function serializeUndoEntries(entries: UndoEntry[], lastBreak?: UndoBreakRecord | null): string {
  return lastBreak
    ? JSON.stringify({ v: 1, entries, lastBreak })
    : JSON.stringify({ v: 1, entries });
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

/**
 * 写栈结果（v0.3.3 · 项3 扩展）：
 * - `ok: true` 时带 `dropped`——配额不足、按需丢弃的最旧条数（0 = 整栈原样落盘）。
 *   **调用方必须在 dropped > 0 时给用户明确提示**，不允许再出现「ok:true 却悄悄少了几条」。
 * - `ok: false, degraded: true`——连「只留最新一条」都写不进，降级会话内内存历史。
 */
export type UndoSaveResult = { ok: true; dropped: number } | { ok: false; degraded: true };

/**
 * 写栈（规则 6，v0.3.3 · 项3 修订）：QuotaExceeded → **渐进降容** → 仍写不进 → 降级会话内内存历史。
 *
 * 旧实现「丢最旧重试一次」直接 `entries.slice(entries.length - 1)`：一次配额失败就把 10 条历史
 * 砍成 1 条，且返回 `{ ok: true }` 不报丢弃条数——与项3「不静默丢历史」直接冲突。
 *
 * 现实现：配额失败说明「整栈体积超了」，能写完的最大保留条数一定落在 [1, n) 内；
 * 栈是**按时间顺序的**、丢弃只会从最旧一侧发生，于是「保留末尾 k 条」的写入体积随 k 单调递增，
 * 可对 k 二分（O(log n) 次写入）求出最大可行 k，再按需丢弃最旧的 n-k 条。
 * 二分上界先用「只留最新一条」探测：连它都写不进 → 直接降级（保持既有降级通道）。
 */
export function saveUndoStack(
  entries: UndoEntry[],
  storage: UndoStorage | undefined = defaultStorage(),
  lastBreak?: UndoBreakRecord | null,
): UndoSaveResult {
  if (!storage) return { ok: false, degraded: true };
  // tryWrite(keep)：只保留末尾 keep 条写入，返回是否成功
  const tryWrite = (keep: number): boolean => {
    const trimmed = keep >= entries.length ? entries : entries.slice(entries.length - keep);
    try {
      storage.setItem(UNDO_STORAGE_KEY, serializeUndoEntries(trimmed, lastBreak));
      return true;
    } catch {
      return false;
    }
  };
  if (tryWrite(entries.length)) return { ok: true, dropped: 0 };
  if (entries.length === 0) return { ok: false, degraded: true };
  // 最小可行解：只留最新一条。写不进 → 无容量可用，降级。
  if (!tryWrite(1)) return { ok: false, degraded: true };
  // 二分最大可行的保留条数（不变式：lo 可行、hi+1 不可行）
  let lo = 1;
  let hi = entries.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (tryWrite(mid)) lo = mid;
    else hi = mid - 1;
  }
  return { ok: true, dropped: entries.length - lo };
}

/** 栈顶条目（世界线基准）。 */
export function topEntry(entries: UndoEntry[]): UndoEntry | null {
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

/**
 * 栈顶世界线门禁（规则 3）：top.post === 当前生效配置的 canonical。
 *
 * v0.3.3 · 项3 起**恢复入口不再用这条**（判定对象改为「被点击条目」，见 undoGateFor）；
 * 本函数保留给启动层（restoreUndoStack）与不变量断言使用，语义不变。
 */
export function undoGate(entries: UndoEntry[], currentCanonical: string | null): boolean {
  const top = topEntry(entries);
  if (!top || currentCanonical === null) return false;
  return top.post === currentCanonical;
}

/**
 * 逐条门禁（v0.3.3 · 项3）：判定对象是**被点击的那一条**，不再是栈顶。
 *
 * true = 该条记录之后没有发生任何改动，可直接恢复（仍会走恢复前确认，但为「无需回退其它改动」形态）；
 * false = 该条已不是当前世界线末端 → 必须走**恢复前显式确认**并把被覆盖的当前配置存成反向记录。
 *
 * 与 undoGate 的区别正是判据 3-a 的缺陷点：只比栈顶时，栈顶失效会让更早的、仍有效的条目被一并挡掉。
 */
export function undoGateFor(entry: UndoEntry | null | undefined, currentCanonical: string | null): boolean {
  if (!entry || currentCanonical === null) return false;
  return entry.post === currentCanonical;
}

/** 单条序列化字节数（规则 6 字节护栏，**UTF-8 字节**而非 UTF-16 码元）。 */
export function undoEntryBytes(entry: UndoEntry): number {
  // 旧实现 `serializeUndoEntries([entry]).length` 取的是 JS 字符串的 UTF-16 码元数：
  // 中文 / emoji 一个字符只算 1，而 UTF-8 实际占 3～4 字节，导致中文段名下最多低估 30%+，
  // 本该拦下的条目被放行、写存储时撞配额。护栏口径必须是「落盘体积」，故用 TextEncoder。
  return utf8Bytes(serializeUndoEntries([entry]));
}

/** 字符串的 UTF-8 字节数（按字节计；TextEncoder 浏览器与 Node 均原生支持）。 */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** 该条是否触发字节护栏（单条序列化 > UNDO_ENTRY_MAX_BYTES）。 */
export function isUndoEntryOversized(entry: UndoEntry): boolean {
  return undoEntryBytes(entry) > UNDO_ENTRY_MAX_BYTES;
}

/**
 * push（规则 1，v0.3.3 · 项3 修订）：
 * - 栈空 ‖ newEntry.pre === top.post → 追加；
 * - **链不连续**（中间发生过不入栈的编辑）→ **不再清栈**，改为追加并把该条标 `chainBroken`；
 *   旧行为 `[entry]`（整栈替换）是项3 要消除的第 2 个清栈点（它把「调速」也变成清栈）。
 * - restore 类：豁免链式条件（维护 top.post === current 不变量，连按可连续回退）。
 * - 容量：超过 UNDO_CAP 丢最旧。
 * - **单条超限**：不塌栈（旧行为把整个栈塌成 1 条，与项3 目的直接冲突）——由调用方先查
 *   `isUndoEntryOversized`，超限条目不入栈、原栈原样保留（见 controller 的 notify）。
 */
export function pushUndoEntry(entries: UndoEntry[], entry: UndoEntry): UndoEntry[] {
  const top = topEntry(entries);
  const chainOk = entry.kind === 'restore' || top === null || entry.pre === top.post;
  const next = chainOk ? [...entries, entry] : [...entries, { ...entry, chainBroken: true }];
  return next.length > UNDO_CAP ? next.slice(next.length - UNDO_CAP) : next;
}

/** 清栈痕迹构造（3-d：真断裂仍清栈，但不得静默）。 */
export function makeBreakRecord(
  kind: UndoBreakKind,
  reason: string,
  dropped: number,
  at: number = Date.now(),
): UndoBreakRecord {
  return { kind, reason, at, dropped };
}

/**
 * 栈计数拆分（3-f）：入口可见性按**总条数**，文案按可恢复条数区分。
 *
 * v0.3.3 · 项3 补丁（P0 回归修复的连带口径）：`reverse` 记录**不计入总条数**。
 * 理由：反向记录是 `confirmUndo` 提交恢复时顺手写入的簿记（承载「被覆盖的那份当前配置」，
 * 见 controller.ts 的 restoreContext.reversePre），它不是用户能点的「一步」——
 * `undoDelete` 的取条条件就写着 `kind !== 'restore'`，反向记录永远不可恢复。
 * 把它算进「回收站里还有 N 条」会让用户以为多了一步可操作的历史：实测恢复最早一步后，
 * 栈内是 3 条置灰删除 + 1 条恢复记录 + 1 条反向记录，旧口径报 5、面板也列 5 行，
 * 而真正与用户语义对应的只有 4 条（3-f 的判据期望也正是 4）。因此 total 排除 reverse，
 * 与「可恢复」口径同源。
 *
 * 注意边界：本函数只改 `total` 的分子，不碰 `undoEntryBytes` / `isUndoEntryOversized` /
 * `saveUndoStack`（那三处归项 10 的并行任务，本补丁不触碰）。
 */
export function undoCounts(entries: UndoEntry[]): { total: number; recoverable: number } {
  return {
    total: entries.filter((e) => e.reverse !== true).length,
    recoverable: entries.filter((e) => !e.stale && e.kind !== 'restore').length,
  };
}

/** 适用性判定结果的失败原因码（机器可判、可本地化展示）。 */
export type UndoInapplicableReason =
  | 'NO_CONFIG'
  | 'BAD_PRE_JSON'
  | 'SCHEMA_INVALID'
  | 'OUT_OF_DURATION'
  | 'DUPLICATE_ID'
  | 'ID_CONFLICT';

export type UndoApplicability = { ok: true } | { ok: false; reason: UndoInapplicableReason; message: string };

/**
 * 「记录自身损坏」的原因码判定（与当前配置无关、恢复必然失败）。
 *
 * 与 `isEntryApplicable` 的其它原因码区分：`OUT_OF_DURATION` / `ID_CONFLICT` 属于
 * 「恢复会顺带回退别处的改动」——那是**恢复前确认**要解决的问题，不是记录坏了。
 * 把二者混为一谈会导致：用户点了确认，却因为重新判定又把该条置灰，历史等于白丢
 * （判据 3-b「删除 → 改速率 → 点恢复」因此不可用）。
 */
export function isEntryDamagedReason(reason: UndoInapplicableReason): boolean {
  return reason === 'NO_CONFIG' || reason === 'BAD_PRE_JSON' || reason === 'SCHEMA_INVALID' || reason === 'DUPLICATE_ID';
}

/**
 * 轻量重复 id 扫描（仅用于让 DUPLICATE_ID 原因可被定位）。
 *
 * 只认「结构化到足以比较」的输入：`parsed` 必须是对象、`segments` 必须是数组、
 * 数组项必须是带字符串 `id` 的对象。任何一条不满足都不在这里报错，交给 `validate` 判
 * SCHEMA_INVALID——本函数不做结构校验，只回答「有没有重复 id」。
 */
function findDuplicateSegmentId(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const segs = (parsed as Record<string, unknown>).segments;
  if (!Array.isArray(segs)) return null;
  const seen = new Set<string>();
  for (const s of segs) {
    if (typeof s !== 'object' || s === null) return null;
    const id = (s as Record<string, unknown>).id;
    if (typeof id !== 'string') return null;
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
}


/**
 * 逐条适用性（v0.3.3 · 项3，纯函数，**返回结果不抛异常**）。
 *
 * 三条谓词（方案 §2.3 第 5 条）：
 * ① **段 id 一致性**：记录指向的配置 `pre` 内不得有重复 id；若某 id 同时存在于当前配置，
 *    两处的段区间/速率必须一致（id 被复用给了另一段 = 恢复会覆盖别人的段）。
 *    口径说明：方案原文写「记录引用的所有段 id 仍存在于当前段列表」，但删除类记录的
 *    被删段**按定义已不在当前配置**，若按字面判定则任何删除都无法恢复（与判据 3-a 冲突）；
 *    因此这里取「id 不冲突」这一可执行的等价约束，并在 `message` 中区分。
 * ② **区间在总时长内**：每段 0 ≤ start < end ≤ 当前视频总时长。
 * ③ **校验器解析无错误**：`validate(pre)` 通过（含 schema 版本、字段范围等）。
 */
export function isEntryApplicable(entry: UndoEntry, current: PlayerConfig | null): UndoApplicability {
  if (!current) return { ok: false, reason: 'NO_CONFIG', message: '当前没有可恢复的配置' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.pre);
  } catch {
    return { ok: false, reason: 'BAD_PRE_JSON', message: '撤销记录已损坏（不是合法 JSON）' };
  }
  // ①-a 重复 id 预检（必须先于 validate）：
  // `validate` 对 segments[].id 重复也判 BAD_SEGMENTS，若先跑 validate，
  // 本原因码会被 SCHEMA_INVALID 吞掉、永远不可达（DUPLICATE_ID 就成死码）。
  // 这里在结构校验前先做一次轻量扫描，只为让「重复 id」这一具体原因可被定位；
  // 类型/结构不合法的输入仍落到下方 validate（不在此处越权判定）。
  const dupId = findDuplicateSegmentId(parsed);
  if (dupId) {
    return { ok: false, reason: 'DUPLICATE_ID', message: `撤销记录内段 id 重复：${dupId}` };
  }
  const res = validate(parsed);
  if (!res.ok) {
    return { ok: false, reason: 'SCHEMA_INVALID', message: `撤销记录配置校验未通过：${res.error.message}` };
  }
  const target = res.value;
  const duration = current.video.duration;
  const byId = new Map(current.segments.map((s) => [s.id, s]));
  for (const s of target.segments) {
    if (!(0 <= s.start && s.start < s.end && s.end <= duration)) {
      return {
        ok: false,
        reason: 'OUT_OF_DURATION',
        message: `段「${s.label || s.id}」区间超出当前视频时长（${duration}s）`,
      };
    }
    const live = byId.get(s.id);
    // 只把**区间**不同视为「id 被另一段占用」：id 的身份由区间界定。
    // 速率不同不算 id 冲突——那是同一段被改过速率，恢复会顺带回退这次改动，
    // 属于「恢复前确认」的范畴（判据 3-b「删除 → 改速率 → 点恢复」正是这种场景）；
    // 若在这里判成 ID_CONFLICT，该场景会被当成不可恢复。
    if (live && (live.start !== s.start || live.end !== s.end)) {
      return {
        ok: false,
        reason: 'ID_CONFLICT',
        message: `段 id ${s.id} 已被另一段占用（区间不一致）`,
      };
    }
  }
  return { ok: true };
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
  /** 整栈丢弃（结构损坏 / 栈顶世界线失配） */
  discarded: boolean;
  /** 上次会话留下的清栈痕迹（供 3-d 追溯展示） */
  lastBreak: UndoBreakRecord | null;
  /** 启动时被判损坏并置灰的条数（项3：损坏按条置灰，不再整栈丢弃） */
  damaged: number;
}

/**
 * 启动恢复（规则 5，v0.3.3 · 项3 修订）：
 * - 单条 `pre` 非法（JSON 坏 / 校验失败）→ **只把该条置灰（stale + invalidReason）**，其余保留；
 *   旧行为是整栈丢弃，会把「一条坏了」放大成「全部历史消失」，正是项3 要收窄的损伤面。
 * - 栈顶世界线失配 / 当前无配置 → **整栈丢弃**（跨会话层兜底不变：配置已换，旧记录无处落地）。
 */
export function restoreUndoStack(raw: string | null, currentConfig: PlayerConfig | null): UndoRestoreResult {
  const { entries: parsedEntries, lastBreak } = parseUndoRecord(raw);
  if (parsedEntries.length === 0) {
    return { entries: [], discarded: false, lastBreak, damaged: 0 };
  }
  let damaged = 0;
  const entries = parsedEntries.map((e) => {
    const verdict = isEntryApplicable(e, currentConfig ?? null);
    // 只对「记录自身损坏」置灰；与当前配置的 id/时长冲突留给点击时的逐条判定（会话内可修复）
    if (!verdict.ok && (verdict.reason === 'BAD_PRE_JSON' || verdict.reason === 'SCHEMA_INVALID' || verdict.reason === 'DUPLICATE_ID')) {
      damaged += 1;
      return { ...e, stale: true, invalidReason: verdict.message };
    }
    return e;
  });
  if (currentConfig === null) return { entries: [], discarded: true, lastBreak, damaged };
  const live = entries.filter((e) => !e.stale);
  const top = topEntry(live);
  if (!top || top.post !== canonicalize(currentConfig)) {
    return { entries: [], discarded: true, lastBreak, damaged };
  }
  return { entries, discarded: false, lastBreak, damaged };
}
