/**
 * L3 · 配置密钥编解码（载体一：URL hash 密钥）
 *
 * 编码管线（定稿 §2.4）：规范化 JSON（键名字典序、UTF-8、无空白）
 *   → pako deflate（level 9）→ base64url → 拼入 URL hash（#c=…）。
 * 解码为完全逆过程；任何一步失败返回带原因的可诊断错误，不静默兜底（F8 AC4）。
 *
 * P10 结论（2026-11-03 产线管线重跑，canonicalize＋deflate level 9，pako 锁定 1.0.11）：
 *   80 段配置密钥 1852 字符 > 1500 判定线 → URL 密钥适用 ≤50 段（1271 字符）；
 *   >50 段走 .json 导出/导入降级（M3 已接线 UI）。旧 1911/1359 为旧探针管线数值，已作废（见 ADR-001）。
 *   两种载体共享同一数据模型：.json 载体即本模块的规范化 JSON 文本。
 */

import { deflate, Inflate } from 'pako';
import { migrate, detectVersion } from './migrate';
import {
  validate,
  type PlayerConfig,
  type Result,
  type SchemaError,
} from './schema';

/** URL 密钥长度判定线（定稿 §2.4：统一为 1500 字符，超阈值启用 exportConfig 降级） */
export const URL_KEY_CHAR_LIMIT = 1500;

/**
 * v0.3.3 · 项4 · 解码双闸的具名上限常量。
 *
 * 与 `URL_KEY_CHAR_LIMIT`（1500）**并列但不同职责**：
 * - `URL_KEY_CHAR_LIMIT` 是**编码侧**降级判定线——超线不生成 URL 密钥、改走 .json 载体；
 * - `KEY_CHAR_MAX` 是**解码侧**入口安全闸——只有明显超出任何合法密钥量级的输入才在入口被拒。
 *   两者不能合并：产线口径（ADR-001 / P10）本就允许 80–150 段走 .json，而解码侧仍需能
 *   解 150 段档位密钥（3150 字符）；若把解码入口压在 1500，等于用安全闸废掉既有档位回归。
 *
 * 取值依据（方案 §2.4「关键数字」）：300 段配置密钥 5,976 字符、解压后 41,562–50,562 B，
 * 相对 1MB 输出上限余量 20.7–25.2 倍；合法配置远达不到上限。
 */
export const KEY_CHAR_MAX = 8192;
export const KEY_INFLATE_MAX_BYTES = 1024 * 1024;
/** 解压后 JSON 文本体积上限（按 UTF-16 码元计；与字节闸同为「解压产物体积」口径） */
export const KEY_JSON_MAX_CHARS = 1024 * 1024;

/**
 * 真中止哨兵（模块级 Symbol，不导出）：解压数据回调里越过上限时抛出它，
 * 由 `decodeKey` 就地捕获转成解码失败结果。用 Symbol 而非 Error，是为了让
 * 「我们自己主动中止」与「pako 内部抛出的真实解压错误」在 catch 处可判别，
 * 且不会被误当成业务异常传播到调用方。
 */
const INFLATE_ABORT = Symbol('codec.inflateAbort');


export type CodecError =
  | { code: 'BAD_BASE64' | 'BAD_DEFLATE' | 'BAD_JSON' | 'BAD_SIZE'; message: string }
  | SchemaError;

/** 用户可见文案（定稿 §2.6 错误分类 → 文案映射表） */
export const COPY_KEY_INVALID = '链接无效或不完整，请向分享者重新获取';

/** 规范化序列化：键名字典序、无空白。同一配置必产出同一字符串（可测、可比对）。 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(rec[k])}`).join(',')}}`;
}

const B64_CHUNK = 0x8000;

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlToBytes(key: string): Uint8Array | null {
  if (!/^[A-Za-z0-9\-_]*$/.test(key)) return null;
  const b64 = key.replaceAll('-', '+').replaceAll('_', '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  let bin: string;
  try {
    bin = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * 编码为完整密钥串（#c= 之后的主体部分）。
 * 输入必须先过 validate；非法配置直接抛错（编码侧是我们自己的编辑器，属编程错误）。
 */
export function encodeConfig(cfg: PlayerConfig): string {
  const checked = validate(cfg);
  if (!checked.ok) throw new Error(`encodeConfig 收到非法配置：${checked.error.message}`);
  return bytesToBase64Url(deflate(canonicalize(checked.value), { level: 9 }));
}

/**
 * 解压并返回 JSON 文本（项4 函数内闸：真中止）。
 *
 * 为什么必须自己实现中止：pako 1.0.11 的 `Inflate.prototype.push(data, mode)` **没有**
 * abort / stop / passthrough 参数（见 node_modules/pako/lib/inflate.js: push 只接受
 * `data` 与 `mode`，内部 do/while 一直解到 `Z_STREAM_END`）。因此只能在数据回调
 * `onData(chunk)` 里自己数：累计输出长度 / `strm.total_out` 越过上限即抛出模块级哨兵，
 * 让 push 立即中断返回，不再继续吃输入。
 *
 * ⚠ 为什么「真中止」不等于「只停止累加」（方案 §2.4 核心论证，必须保留在注释里）：
 * 若只在回调里停止累加（`if (chars <= CAP) chars += ...`）而仍然让 pako 解压到底，
 * 压缩炸弹仍会被完整解开——耗时与「完全不修」几乎相同。
 *
 * 斜率口径实测（2026-11-06，本沙箱 2C4G，测量脚本为一次性工具 `bench-4c.mjs`，
 * **未随本补丁交付、仓库内不存在该文件**，故下表数据无法按本注释直接复现；
 * 原始测量过程与输出记录见 v0.3.3 验证日志「第 6 次追加」的 4-c 段）：
 * | 实现 | 8MiB 档 | 47MiB 档 | 档间增量（斜率） |
 * | 真中止 | 15.4ms | 14.5ms | ≈ -0.9ms（与输入规模无关） |
 * | 只停止累加 | 114.8ms | 685.1ms | 570.3ms |
 * | 完全不修 | 132.2ms | 784.4ms | 652.1ms |
 * 即：真中止的斜率≈0，只停止累加的斜率随规模线性放大且与「完全不修」同量级 ——
 * **只停止累加 ≈ 没修**。判据 4-c 取「只停止累加 / 真中止」的斜率比，
 * 用例里对分母加了 0.5ms 下限（避免≈0 时除爆），本次实测比值约 1140。
 *
 * ⚠ **阈值 1.2 = 2C4G 本机标定值，换机器须重标，不是通用常数。**
 * 它依赖本机（2 核 4G 沙箱）在该输入规模下的实测斜率，CI 冷启动、GC 时机、核数与内存
 * 不同都会改变这个比值，因此只能作「本机回归信号」，不得当跨机器、跨环境的判据。
 *
 * 内存侧同理由：覆盖 `onData` 后不再把每个 chunk 压进 `this.chunks`
 * （默认实现 `Inflate.prototype.onData = function (chunk) { this.chunks.push(chunk) }`），
 * 因此中止后驻留内存不随输出线性增长（判据 4-b 的「内存不随输入线性增长」由此成立）。
 */
/**
 * pako 的运行时实例带有 `strm`（zlib 流状态，含 `total_out`），但 `@types/pako`
 * 的 `Inflate` 声明未导出该字段。这里用局部结构化类型读取它，避免 `any` 逃逸，
 * 也避免改动第三方类型声明。
 */
interface InflateInternals {
  strm: { total_out: number };
}

function inflateWithLimit(bytes: Uint8Array): string | typeof INFLATE_ABORT {
  const inf = new Inflate({ to: 'string' });
  // 覆盖默认 onData（默认实现是把每个 chunk 压进 this.chunks，内存随输出增长）。
  // 此处按 chunk 累计，一旦越过任一上限立即抛哨兵 → push 立即中断，不再吃后续输入。
  const parts: string[] = [];
  let outChars = 0;
  inf.onData = (chunk: unknown): void => {
    const text = typeof chunk === 'string' ? chunk : '';
    parts.push(text);
    outChars += text.length;
    // 双口径：JSON 文本码元数（体积闸）+ zlib 真实输出字节（解压字节闸）
    const totalOut = (inf as unknown as InflateInternals).strm.total_out;
    if (outChars > KEY_JSON_MAX_CHARS || totalOut > KEY_INFLATE_MAX_BYTES) {
      throw INFLATE_ABORT;
    }
  };
  try {
    inf.push(bytes, true);
  } catch (e) {
    if (e === INFLATE_ABORT) return INFLATE_ABORT;
    throw e;
  }
  if (inf.err) throw new Error(inf.msg || 'inflate error');
  // 注意：覆盖 onData 后 pako 的 onEnd 不再能拼出 result（chunks 为空），
  // 必须用自己累计的片段；累计量已被上限约束（≤ 上限 + 一个 chunk）。
  return parts.join('');
}

/**
 * 解码密钥串。失败返回带诊断原因的错误；用户文案统一为 COPY_KEY_INVALID。
 *
 * 项4 双闸（v0.3.3）：
 * 1. **入口闸**：密钥字符长度 > KEY_CHAR_MAX → 直接拒绝，**不进解压**（4-a）；
 * 2. **函数内闸**：`inflateWithLimit` 的数据回调里累计字节/输出长度，超阈值抛哨兵真中止（4-b/4-c）。
 *    双闸的必要性：入口闸只挡「明面上超长的密钥」，短密钥同样可以是压缩炸弹
 *    （实测 1.1MB 载荷可压成 1478 字符密钥，仍在入口线内），所以函数内闸不能省掉。
 *
 * 4-e 文案纪律：拒绝路径的用户可见文案**只用常量** `COPY_KEY_INVALID`（`bad()` 已固定该前缀），
 * 括号内 detail 是给开发者看的诊断串；**段校验器 warnings 一律不拼进 message**——
 * warnings 会带出不可信输入里的键名（如 `忽略未知字段 xxx`），不得进入界面。
 */
export function decodeKey(key: string): Result<PlayerConfig, CodecError> {
  const bad = (
    code: 'BAD_BASE64' | 'BAD_DEFLATE' | 'BAD_JSON' | 'BAD_SIZE',
    detail: string,
  ): Result<PlayerConfig, CodecError> => ({
    ok: false,
    error: { code, message: `${COPY_KEY_INVALID}（${code}: ${detail}）` },
  });
  // —— 入口闸（4-a）：字符长度。超限即拒，不 base64 解码、不解压。
  if (key.length > KEY_CHAR_MAX) return bad('BAD_SIZE', '密钥长度超出上限，已拒绝解码');
  const bytes = base64UrlToBytes(key);
  if (!bytes || bytes.length === 0) return bad('BAD_BASE64', '密钥不是合法 base64url');
  let json: string;
  try {
    const out = inflateWithLimit(bytes);
    // —— 函数内闸触发（真中止）：转成「解码失败」结果，异常不外抛给调用方。
    if (out === INFLATE_ABORT) return bad('BAD_SIZE', '解压产物体积超出上限，已中止解码');
    json = out;
  } catch {
    return bad('BAD_DEFLATE', 'deflate 解压失败（密钥可能被截断或篡改）');
  }
  // 函数内闸的第二道（体积）：真中止在流式回调里已覆盖，这里兜底非流式路径的口径一致性
  if (json.length > KEY_JSON_MAX_CHARS) return bad('BAD_SIZE', '解压后 JSON 体积超出上限');
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return bad('BAD_JSON', 'JSON 解析失败');
  }
  const version = detectVersion(raw);
  if (version === null) return bad('BAD_JSON', '缺少版本字段 v');
  const migrated = migrate(raw, version);
  if (!migrated.ok) return { ok: false, error: migrated.error };
  return validate(migrated.value);
}

/** 载体二：.json 文件导出（P10 降级路径，M3 已接线 UI：controller.exportConfigFile）。 */
export function exportConfig(cfg: PlayerConfig): Blob {
  const checked = validate(cfg);
  if (!checked.ok) throw new Error(`exportConfig 收到非法配置：${checked.error.message}`);
  return new Blob([canonicalize(checked.value)], { type: 'application/json' });
}

/** 载体二：.json 文件导入。与 URL 密钥共用同一数据模型与校验链。 */
export async function importConfig(file: Blob): Promise<Result<PlayerConfig, CodecError>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    return {
      ok: false,
      error: { code: 'BAD_JSON', message: '配置文件不是合法 JSON，请重新导出后再试' },
    };
  }
  const version = detectVersion(raw);
  if (version === null) {
    return { ok: false, error: { code: 'BAD_JSON', message: '配置文件缺少版本字段 v' } };
  }
  const migrated = migrate(raw, version);
  if (!migrated.ok) return { ok: false, error: migrated.error };
  return validate(migrated.value);
}

/** 密钥长度（字符数），用于 P10 判定线比较。 */
export function keyLength(key: string): number {
  return key.length;
}
