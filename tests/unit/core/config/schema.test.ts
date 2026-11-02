import { describe, expect, it } from 'vitest';
import { validate } from '../../../../src/core/config/schema';
import { asRaw, makeConfig, makeSegment } from '../../helpers';

describe('schema v1 · 正例', () => {
  it('最小合法配置通过并补齐缺省（label→""、inQueue→true）', () => {
    const r = validate(
      asRaw({
        v: 1,
        video: { type: 'local', filename: 'a.mp4', duration: 60 },
        segments: [{ id: 'abc123', start: 0, end: 10, rate: 1.5 }],
        sequence: ['abc123'],
        loop: { mode: 'off' },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.segments[0].label).toBe('');
      expect(r.value.segments[0].inQueue).toBe(true);
    }
  });

  it('完整配置通过（含 inQueue=false、meta、loop.count）', () => {
    const cfg = makeConfig({
      segments: [
        makeSegment({ id: 'aaa000', start: 0, end: 10, rate: 0.5, label: '热身', inQueue: true }),
        makeSegment({ id: 'bbb111', start: 10, end: 20, rate: 4, inQueue: false }),
      ],
      sequence: ['aaa000', 'bbb111', 'aaa000'], // 重复引用合法（同段练两遍）
      loop: { mode: 'queue', count: 2 },
      meta: { createdAt: '2026-11-02T00:00:00+08:00', appVersion: '0.0.0' },
    });
    const r = validate(asRaw(cfg));
    expect(r.ok).toBe(true);
  });

  it('空 sequence 合法（队列空 = 播放禁用，定稿 §2.4）', () => {
    const r = validate(asRaw(makeConfig({ sequence: [] })));
    expect(r.ok).toBe(true);
  });

  it('前向宽容：未知字段被忽略并记入 warnings（版本演进五条 · 2）', () => {
    const raw = asRaw(makeConfig()) as Record<string, unknown>;
    raw.futureField = { anything: true };
    (raw.video as Record<string, unknown>).futureVideoField = 1;
    const r = validate(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings.some((w) => w.includes('futureField'))).toBe(true);
      expect(r.warnings.some((w) => w.includes('futureVideoField'))).toBe(true);
    }
  });

  it('meta 未知子字段不影响校验', () => {
    const cfg = makeConfig({ meta: { createdAt: '2026-11-02' } });
    (cfg.meta as Record<string, unknown>).futureMeta = 1;
    const r = validate(asRaw(cfg));
    expect(r.ok).toBe(true);
  });

  it('loop.count 在非 queue 模式下被忽略（警告而非失败）', () => {
    const cfg = makeConfig({ loop: { mode: 'segment', count: 3 } });
    const r = validate(asRaw(cfg));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.loop.count).toBeUndefined();
      expect(r.warnings.some((w) => w.includes('loop.count'))).toBe(true);
    }
  });
});

describe('schema v1 · 反例', () => {
  const cases: Array<[string, (raw: Record<string, unknown>) => void, string]> = [
    ['v 缺失', (r) => delete r.v, 'v'],
    ['v=0 非法', (r) => (r.v = 0), 'v'],
    ['v=2 后向拒绝', (r) => (r.v = 2), '更新版本'],
    ['video.type=url 移出 MVP', (r) => ((r.video as Record<string, unknown>).type = 'url'), 'local'],
    ['duration=0', (r) => ((r.video as Record<string, unknown>).duration = 0), 'duration'],
    ['duration 非数字', (r) => ((r.video as Record<string, unknown>).duration = 'x'), 'duration'],
    ['filename 缺失', (r) => delete (r.video as Record<string, unknown>).filename, 'filename'],
    ['segments 空数组', (r) => (r.segments = []), '至少'],
    ['id 非 6 位 base36', (r) => ((r.segments as Record<string, unknown>[])[0].id = 'ABC-1'), 'base36'],
    ['id 重复', (r) => {
      const segs = r.segments as Record<string, unknown>[];
      segs.push({ ...segs[0] });
    }, '重复'],
    ['start >= end', (r) => {
      const s = (r.segments as Record<string, unknown>[])[0];
      s.start = 10;
      s.end = 10;
    }, 'start'],
    ['end 超过 duration', (r) => ((r.segments as Record<string, unknown>[])[0].end = 61), 'duration'],
    ['start 为负', (r) => ((r.segments as Record<string, unknown>[])[0].start = -1), 'start'],
    ['rate < 0.5', (r) => ((r.segments as Record<string, unknown>[])[0].rate = 0.4), 'rate'],
    ['rate > 4', (r) => ((r.segments as Record<string, unknown>[])[0].rate = 4.1), 'rate'],
    ['label 超 30 字', (r) => ((r.segments as Record<string, unknown>[])[0].label = 'x'.repeat(31)), '30'],
    ['inQueue 非布尔', (r) => ((r.segments as Record<string, unknown>[])[0].inQueue = 'yes'), 'inQueue'],
    ['sequence 引用不存在的 id', (r) => (r.sequence = ['zzz999']), '不存在'],
    ['sequence 非数组', (r) => (r.sequence = 'aaa000'), 'sequence'],
    ['loop.mode 非法', (r) => ((r.loop as Record<string, unknown>).mode = 'forever'), 'loop.mode'],
    ['loop.count 为负', (r) => ((r.loop as Record<string, unknown>).count = -1), 'count'],
    ['loop.count 非整数', (r) => ((r.loop as Record<string, unknown>).count = 1.5), 'count'],
    ['meta 非对象', (r) => (r.meta = 1), 'meta'],
    ['整体不是对象', () => {}, ''],
  ];

  for (const [name, mutate, msgPart] of cases) {
    it(name, () => {
      const raw = name === '整体不是对象' ? ('not-an-object' as unknown as Record<string, unknown>) : asRaw(makeConfig()) as Record<string, unknown>;
      mutate(raw);
      const r = validate(raw);
      expect(r.ok).toBe(false);
      if (!r.ok && msgPart !== '') expect(r.error.message).toContain(msgPart);
    });
  }
});
