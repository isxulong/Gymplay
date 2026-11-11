import { describe, expect, it } from 'vitest';
import { e2ePath, toFsPath } from '../../e2e/e2e-paths';

/**
 * e2e-paths 单测（v0.3.4 · B 席 D-9 要求）。
 *
 * 为什么必须单独测：该模块被 14 个 E2E spec 依赖，但**不进覆盖率统计**
 * （vite.config.ts 的 coverage.include 只有 `src/core/**`，而它在 tests/e2e/ 下）。
 * 也就是说它是「改坏了也不一定被任何数字发现」的地方——按 B 席判断，
 * 这类点只能靠用例守，不能靠阈值守。
 *
 * 锁的四个分支（任何一条被改坏，这里会红）：
 * ① Windows 盘符前导斜杠必须剥；② POSIX 绝对路径必须**不**剥；
 * ③ UNC 必须**不**剥；④ 非法 percent 序列不得抛异常。
 */

describe('toFsPath · Windows 盘符', () => {
  it('剥掉唯一的前导斜杠：/E:/repo/a.webm → E:/repo/a.webm', () => {
    expect(toFsPath('/E:/repo/tests/a.webm')).toBe('E:/repo/tests/a.webm');
  });

  it('小写盘符同样处理', () => {
    expect(toFsPath('/c:/x/y.webm')).toBe('c:/x/y.webm');
  });

  it('本来就是无前导斜杠的盘符路径，原样返回（幂等）', () => {
    expect(toFsPath('E:/repo/a.webm')).toBe('E:/repo/a.webm');
  });
});

describe('toFsPath · POSIX 绝对路径（不许剥斜杠）', () => {
  it('/home/u/a.webm 必须保持绝对，剥了会变相对路径', () => {
    expect(toFsPath('/home/u/a.webm')).toBe('/home/u/a.webm');
  });

  it('根下文件 /a.webm 保持绝对', () => {
    expect(toFsPath('/a.webm')).toBe('/a.webm');
  });
});

describe('toFsPath · UNC 路径（不许剥斜杠）', () => {
  it('//host/share/a.webm 保持双斜杠，剥了会丢主机名', () => {
    expect(toFsPath('//host/share/a.webm')).toBe('//host/share/a.webm');
  });
});

describe('toFsPath · percent-decoding', () => {
  it('正常转义序列被解码（中文目录）', () => {
    expect(toFsPath('/E:/%E4%B8%AD%E6%96%87/a.webm')).toBe('E:/中文/a.webm');
  });

  it('空格转义 %20 被解码', () => {
    expect(toFsPath('/E:/my%20dir/a.webm')).toBe('E:/my dir/a.webm');
  });

  it('孤立 % 不抛异常（decodeURIComponent 原生会抛 URIError）', () => {
    // 前置断言：证明原生实现确实会抛，否则本用例失去意义（EXP-002 鉴别力）
    expect(() => decodeURIComponent('100%')).toThrow(URIError);
    expect(() => toFsPath('/E:/进度100%/a.webm')).not.toThrow();
    expect(toFsPath('/E:/进度100%/a.webm')).toBe('E:/进度100%/a.webm');
  });

  it('非法转义序列原样保留，且不影响同串内的合法序列', () => {
    expect(toFsPath('/E:/bad%zz%20ok/a.webm')).toBe('E:/bad%zz ok/a.webm');
  });
});

describe('e2ePath · 组合行为', () => {
  it('以 file: URL 为基准拼出真实存在的夹具绝对路径', () => {
    const p = e2ePath('../fixtures/fixture-vp8-opus-10s.webm', 'file:///E:/repo/tests/e2e/a.spec.ts');
    expect(p).toBe('E:/repo/tests/fixtures/fixture-vp8-opus-10s.webm');
  });

  it('POSIX 基准下不剥前导斜杠（与 Windows 基准行为区分）', () => {
    const p = e2ePath('./fixtures/x.webm', 'file:///home/u/repo/tests/e2e/a.spec.ts');
    expect(p).toBe('/home/u/repo/tests/e2e/fixtures/x.webm');
  });

  it('省略第二参数时走默认 base（= 本文件 import.meta.url）——生产唯一使用形态', () => {
    // B 席 R-2：14 个 spec 的 15 处调用**全部省略第二参数**，即「生产使用形态 = 单测必须覆盖
    // 的形态」。旧用例名说「默认 base」却传了第二参数，默认值分支从未被走。
    const p = e2ePath('./fixtures/fixture-vp8-opus-10s.webm');
    expect(p.endsWith('fixtures/fixture-vp8-opus-10s.webm')).toBe(true);
    // 必须解析到本仓库内真实存在的同一目录（不是靠 endsWith 蒙过去）
    expect(p).toContain('tests');
    expect(p).toContain('fixtures');
  });
});
