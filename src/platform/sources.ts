/**
 * L0 · 视频源装载（定稿 §2.3：仅 File API；HEVC 预判引导）。
 *
 * P9 结论（2026-11 iPhone 实测）：hev1 与 hvc1 双样本均可直读、出画面出声
 * → M1 起 HEVC 不需要转码引导，仅做提示；仅当平台探测不支持 HEVC 时
 * 才走 R9 fallback 文案（定稿 §2.6）。
 */

import type { VideoSource } from '../core/player/engine';

/** 用户可见文案（定稿 §2.6 错误分类 → 文案映射表） */
export const COPY_FORMAT_UNSUPPORTED = '该格式无法播放，请转换为 mp4 后重试';
export const COPY_HEVC_UNSUPPORTED = '该视频为 HEVC 编码，当前浏览器不支持，请转 H.264 后导入';
export const COPY_LOAD_FAILED = '视频加载失败，可能是文件过大或设备内存不足。建议分段录制或压缩后重试。';

export type SourceLoadResult =
  | { ok: true; source: VideoSource; revoke: () => void; hint: 'hevc-passthrough' | null }
  | { ok: false; message: string };

const HEVC_HINT = /h[ev]c1|hev1/i;

function looksHevc(file: File): boolean {
  return HEVC_HINT.test(file.type) || /\.(hevc|h265)/i.test(file.name);
}

/**
 * 装载本地文件为可播放源。
 * - canPlayType 否定 → F1 AC2 文案；
 * - HEVC 且平台探测不支持 → R9 fallback 文案；HEVC 且可播 → 直读并带提示标记（P9）。
 */
export function loadLocalSource(
  file: File,
  probe: (file: File) => string,
  hevcSupported: boolean,
): SourceLoadResult {
  const verdict = probe(file);
  if (verdictRejected(verdict, file)) {
    if (looksHevc(file) && !hevcSupported) return { ok: false, message: COPY_HEVC_UNSUPPORTED };
    return { ok: false, message: COPY_FORMAT_UNSUPPORTED };
  }
  const url = URL.createObjectURL(file);
  return {
    ok: true,
    source: { kind: 'local', url, filename: file.name },
    revoke: () => URL.revokeObjectURL(url),
    hint: looksHevc(file) ? 'hevc-passthrough' : null,
  };
}

/** canPlayType 返回 '' 即否定；file.type 为空（部分系统不给 MIME）时放行交给解码阶段判定。 */
function verdictRejected(verdict: string, file: File): boolean {
  if (file.type === '') return false;
  return verdict === '';
}

/** 供 UI 层使用的默认探测函数签名适配。 */
export function canPlayTypeProbe(video: HTMLVideoElement): (file: File) => string {
  return (file) => video.canPlayType(file.type);
}
