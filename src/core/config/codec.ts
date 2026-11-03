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

import { deflate, inflate } from 'pako';
import { migrate, detectVersion } from './migrate';
import {
  validate,
  type PlayerConfig,
  type Result,
  type SchemaError,
} from './schema';

/** URL 密钥长度判定线（定稿 §2.4：统一为 1500 字符，超阈值启用 exportConfig 降级） */
export const URL_KEY_CHAR_LIMIT = 1500;

export type CodecError =
  | { code: 'BAD_BASE64' | 'BAD_DEFLATE' | 'BAD_JSON'; message: string }
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

/** 解码密钥串。失败返回带诊断原因的错误；用户文案统一为 COPY_KEY_INVALID。 */
export function decodeKey(key: string): Result<PlayerConfig, CodecError> {
  const bad = (code: 'BAD_BASE64' | 'BAD_DEFLATE' | 'BAD_JSON', detail: string): Result<PlayerConfig, CodecError> => ({
    ok: false,
    error: { code, message: `${COPY_KEY_INVALID}（${code}: ${detail}）` },
  });
  const bytes = base64UrlToBytes(key);
  if (!bytes || bytes.length === 0) return bad('BAD_BASE64', '密钥不是合法 base64url');
  let json: string;
  try {
    json = inflate(bytes, { to: 'string' });
  } catch {
    return bad('BAD_DEFLATE', 'deflate 解压失败（密钥可能被截断或篡改）');
  }
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
