/**
 * v0.3.1 · R3 时间格式纯函数单测（验收标准 R3 AC1–AC5、AC8 的 Node 侧断言）。
 */

import { describe, expect, it } from 'vitest';
import { formatClock, parseTimeInput } from '../../../src/ui/editor/time-input';

describe('formatClock（R3 AC1/AC3 显示换算）', () => {
  it('AC1：754.5s → "12:34.5"', () => {
    expect(formatClock(754.5)).toBe('12:34.5');
  });

  it('整数秒也带一位小数：754s → "12:34.0"', () => {
    expect(formatClock(754)).toBe('12:34.0');
  });

  it('0 → "0:00.0"；非法值按 0 处理', () => {
    expect(formatClock(0)).toBe('0:00.0');
    expect(formatClock(Number.NaN)).toBe('0:00.0');
    expect(formatClock(-3)).toBe('0:00.0');
  });

  it('AC3：视频满 1 小时时用 h:mm:ss.s——3723.4s → "1:02:03.4"', () => {
    expect(formatClock(3723.4, 3723.4)).toBe('1:02:03.4');
    expect(formatClock(3723.4, 4000)).toBe('1:02:03.4');
  });

  it('小时位不补零、分秒补零：3661.0 → "1:01:01.0"', () => {
    expect(formatClock(3661, 3661)).toBe('1:01:01.0');
  });

  it('时长满 1 小时时，不足 1 小时的值也用 h 格式（0:12:34.5）', () => {
    expect(formatClock(754.5, 3723.4)).toBe('0:12:34.5');
  });

  it('显示统一一位小数：754.56s → "12:34.6"', () => {
    expect(formatClock(754.56)).toBe('12:34.6');
  });
});

describe('parseTimeInput（R3 AC2/AC4/AC5/AC8 宽容解析）', () => {
  it('AC2："12:34.5" → 754.5', () => {
    expect(parseTimeInput('12:34.5')).toBe(754.5);
  });

  it('AC3："1:02:03.4" → 3723.4', () => expect(parseTimeInput('1:02:03.4')).toBe(3723.4));

  it('AC4：纯秒 "754.5" → 754.5；无小数位 "12:34" → 754.0', () => {
    expect(parseTimeInput('754.5')).toBe(754.5);
    expect(parseTimeInput('12:34')).toBe(754);
  });

  it('AC8：精度四舍五入到 0.1s——"12:34.56" → 754.6', () => {
    expect(parseTimeInput('12:34.56')).toBe(754.6);
  });

  it('AC5：非法输入返回 null（abc / 12:99 / 空串）', () => {
    expect(parseTimeInput('abc')).toBeNull();
    expect(parseTimeInput('12:99')).toBeNull();
    expect(parseTimeInput('')).toBeNull();
    expect(parseTimeInput('   ')).toBeNull();
  });

  it('h:mm:ss.s 中 mm ≥ 60 非法；"1:60:00" → null', () => {
    expect(parseTimeInput('1:60:00')).toBeNull();
  });

  it('拒绝负值与多段冒号', () => {
    expect(parseTimeInput('-5')).toBeNull();
    expect(parseTimeInput('-1:30')).toBeNull();
    expect(parseTimeInput('1:2:3:4')).toBeNull();
  });

  it('前后空白宽容；mm 段允许 ≥60（"62:03.4" = 3723.4）', () => {
    expect(parseTimeInput('  12:34.5  ')).toBe(754.5);
    expect(parseTimeInput('62:03.4')).toBe(3723.4);
  });
});
