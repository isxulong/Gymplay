/**
 * v0.3.1 · R3 起止时间的展示与输入格式（mm:ss.s / h:mm:ss.s）。
 *
 * 纯函数模块（无 DOM 依赖），Node 侧 vitest 直接覆盖：
 * - formatClock：秒 → 「mm:ss.s」（duration 满 1 小时时用「h:mm:ss.s」），统一一位小数；
 * - parseTimeInput：宽容解析三种写法（mm:ss.s / h:mm:ss.s / 纯秒），精度到 0.1s
 *   （更多小数位四舍五入），非法输入返回 null（不落库由调用方保证）。
 *
 * 内部存储与 Schema v1 保持「秒（number）」不变——本模块只改展示与输入解析层。
 */

/** 输入解析粒度：0.1s（R3 方案要点 4）。 */
const INPUT_PRECISION = 0.1;

/** 四舍五入到 0.1s；加 1e-9 抵消二进制浮点误差（如 754.56*10 = 7545.5999…）。 */
function roundToTenth(sec: number): number {
  return Math.round((sec + 1e-9) * (1 / INPUT_PRECISION)) * INPUT_PRECISION;
}

/**
 * 秒 → 展示字符串。
 * - durationSec（视频总时长）≥ 3600 时用 h:mm:ss.s；否则 mm:ss.s。
 * - 缺省 durationSec 时按 sec 自身是否满 1 小时判定。
 * - 分钟 / 秒两位补零，小时不补零；小数位恒为一位。
 */
export function formatClock(sec: number, durationSec?: number): string {
  const safe = Number.isFinite(sec) && sec > 0 ? sec : 0;
  const rounded = roundToTenth(safe);
  const withHours = (durationSec ?? safe) >= 3600;
  const totalSec = Math.floor(rounded);
  const tenth = Math.round((rounded - totalSec) * 10);
  // 处理 59.96 → 60.0 这类进位：tenth 进位后 totalSec 需 +1
  const carry = tenth >= 10 ? 1 : 0;
  const t = totalSec + carry;
  const d = tenth >= 10 ? 0 : tenth;
  const s = t % 60;
  const m = Math.floor(t / 60) % 60;
  const hr = Math.floor(t / 3600);
  const ss = `${String(s).padStart(2, '0')}.${d}`;
  if (withHours) return `${hr}:${String(m).padStart(2, '0')}:${ss}`;
  return `${Math.floor(t / 60)}:${ss}`;
}

/**
 * 宽容解析用户输入为秒（精度 0.1s）；非法输入返回 null。
 * 接受三种写法：
 * - 「754.5」纯秒（兼容旧习惯）；
 * - 「12:34.5」mm:ss.s（ss < 60；小数位可省，「12:34」= 754.0）；
 * - 「1:02:03.4」h:mm:ss.s（mm < 60 且 ss < 60）。
 * 拒绝：空串、非数字、负值、mm/ss 越界（≥60）、多于两段冒号。
 */
export function parseTimeInput(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  if (!trimmed.includes(':')) {
    // 纯秒
    if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
    const v = Number(trimmed);
    if (!Number.isFinite(v) || v < 0) return null;
    return roundToTenth(v);
  }

  const parts = trimmed.split(':');
  if (parts.length < 2 || parts.length > 3) return null;

  // 最后一段允许一位及以上小数（将四舍五入到 0.1s），其余段必须为非负整数
  const last = parts[parts.length - 1];
  if (!/^\d+(\.\d+)?$/.test(last)) return null;
  const secPart = Number(last);
  if (!Number.isFinite(secPart) || secPart >= 60) return null;

  const intParts = parts.slice(0, -1);
  for (const p of intParts) {
    if (!/^\d+$/.test(p)) return null;
  }
  const nums = intParts.map((p) => Number(p));

  let total: number;
  if (nums.length === 1) {
    // mm:ss.s
    const mm = nums[0];
    total = mm * 60 + secPart;
  } else {
    // h:mm:ss.s
    const [hr, mm] = nums;
    if (mm >= 60) return null;
    total = hr * 3600 + mm * 60 + secPart;
  }
  if (!Number.isFinite(total) || total < 0) return null;
  return roundToTenth(total);
}
