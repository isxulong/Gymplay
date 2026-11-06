#!/usr/bin/env node
/* global btoa, performance */
/**
 * 项4 解码双闸 · 双树对照（判据 4-a / 4-b 的「旧树红 → 新树绿」实证）
 *
 * 用法：node scripts/gate-decode.mjs <基线树路径> [当前树路径]
 * 退出码：0 = 新树全部拒绝且旧树在同样输入上放行（对照组成立）；1 = 任一不符合。
 *
 * 口径说明（为什么不复用 vitest 跑旧树）：旧树没有本批新增的用例文件，也没有
 * 同名的具名常量；用 esbuild 把两树的 codec.ts 各自打包后喂同一组输入，
 * 比较的是「同一输入、两树 decodeKey 的结果」，这正是判据要的语义。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const CURRENT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = process.argv[2] ? resolve(process.argv[2]) : null;
if (!BASELINE || !existsSync(join(BASELINE, 'src/core/config/codec.ts'))) {
  console.error('用法：node scripts/gate-decode.mjs <基线树路径> [当前树路径]');
  process.exit(1);
}

const require_ = createRequire(import.meta.url);
const pako = require_('pako');

async function loadCodec(tree, tag) {
  const out = await build({
    entryPoints: [join(tree, 'src/core/config/codec.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    // 基线树没有 node_modules：pako 统一从当前树解析（两树 lockfile 均锁 1.0.11）
    nodePaths: [join(CURRENT, 'node_modules')],
    write: false,
    logLevel: 'silent',
  });
  const dir = join(CURRENT, 'node_modules', '.gate-decode');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${tag}-codec.cjs`);
  writeFileSync(file, out.outputFiles[0].text);
  return require_(file);
}

const b64 = (bytes) => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};
const base = await loadCodec(BASELINE, 'baseline');
const curr = await loadCodec(CURRENT, 'current');

const OVERLONG = b64(pako.deflate('a'.repeat(47 * 1024 * 1024), { level: 9 })); // 60938 字符 > 入口闸
// 炸弹载荷用高压缩比字符重复：deflate 后仅数 KB，密钥可落在入口闸之内，
// 于是只有「函数内闸」能区分两树——这正是 4-b 要测的。
const bombKey = (payloadChars) => b64(pako.deflate('a'.repeat(payloadChars), { level: 9 }));
const BOMB_SMALL = bombKey(4 * 1024 * 1024); // ≈5198 字符，在入口闸内
const BOMB_LARGE = bombKey(6 * 1024 * 1024); // ≈7798 字符，仍在入口闸内（<8192）
if (process.env.DEBUG_KEY_LEN) {
  console.log(`keyChars: overlong=${OVERLONG.length} small=${BOMB_SMALL.length} large=${BOMB_LARGE.length}`);
}

const CASE_TABLE = [
  // 4-a：超长密钥。旧树照样走完 base64+inflate（因此耗时长、错误码是解压类）；
  //      新树在入口直接 BAD_SIZE、0ms，且不进入解压。
  { name: '4-a 超长密钥（≈60938 字符，解压产物 47MB）', key: OVERLONG, criterion: '4-a' },
  { name: '4-b 短密钥炸弹（≈5198 字符，解压产物 4MB）', key: BOMB_SMALL, criterion: '4-b' },
  { name: '4-b 短密钥炸弹（≈7798 字符，解压产物 6MB）', key: BOMB_LARGE, criterion: '4-b' },
];

const rows = [];
// 热身后取中位：单次计时会被固定开销（base64 解码 + 建流/初始化，约 20–30ms）稀释，
// 小档（4MiB）尤其明显（864ms 级不再成立，会退到 2.5~3x 边界，偶发判负）。
// 热身后三次取中位，反映的是「解压是否被中止」，而不是进程冷启动噪声。
const REPS = 3;
const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const timeDecode = (codec, k) => {
  const samples = [];
  for (let i = 0; i < REPS; i += 1) {
    const t = performance.now();
    codec.decodeKey(k);
    samples.push(performance.now() - t);
  }
  return median(samples);
};

for (const { name, key, criterion } of CASE_TABLE) {
  // 堆增量只在「本进程内首次冷调用」上读：热身后 GC 会回收，读数反而漂移。
  // 耗时则相反——冷调用被固定开销稀释，取热身后 3 次中位。
  const heap0 = process.memoryUsage().heapUsed;
  const b = base.decodeKey(key);
  const heapBase = process.memoryUsage().heapUsed - heap0;
  const heap1 = process.memoryUsage().heapUsed;
  const c = curr.decodeKey(key);
  const heapCurr = process.memoryUsage().heapUsed - heap1;

  const tBase = timeDecode(base, key);
  const tCurr = timeDecode(curr, key);

  // 判定口径（机器可判，不依赖「ok=false」这种两树都成立的事）：
  // - 新树必须报新引入的 BAD_SIZE（旧树根本没有这个码）；
  // - 旧树不得报 BAD_SIZE（证明它确实走了 base64+解压路径）；
  // - 旧树耗时须显著高于新树（4-a 入口闸 0ms vs 旧树完整解压；4-b 真中止 vs 解压到底）。
  //   倍数取 2x（不是 3x）：4-b 小档（4MiB）的绝对耗时只有几十毫秒，其中约 20ms 是两树
  //   都要付的固定开销（base64 编码/解码 + 建流初始化），3x 会把「真实差异」误判成负；
  //   决定性证据是**错误码**（旧树 BAD_JSON / 新树独占的 BAD_SIZE），耗时与堆只作佐证。
  const currCoded = !c.ok && c.error.code === 'BAD_SIZE';
  const baseCoded = !b.ok && b.error.code === 'BAD_SIZE';
  const slower = tBase > Math.max(tCurr * 2, 20);
  const verdict =
    currCoded && !baseCoded && slower
      ? '✅ 旧树红 → 新树绿'
      : !currCoded
        ? '❌ 新树未在闸上拒绝'
        : baseCoded
          ? '❌ 旧树已有该闸（对照组不成立）'
          : '❌ 旧树未被真正拖慢（缺陷未复现）';

  rows.push({
    criterion,
    name,
    keyChars: key.length,
    baseline: b.ok
      ? `ok=true（放行，${tBase.toFixed(0)}ms）`
      : `ok=false（${b.error.code}，${tBase.toFixed(0)}ms，Δheap ${(heapBase / 1048576).toFixed(1)}MB）`,
    current: c.ok
      ? `ok=true（放行，${tCurr.toFixed(0)}ms）`
      : `ok=false（${c.error.code}，${tCurr.toFixed(0)}ms，Δheap ${(heapCurr / 1048576).toFixed(1)}MB）`,
    verdict,
  });
}

// 回归保护：合法配置在新树必须仍可解码，且与旧树结果一致
const legal = base.encodeConfig({
  v: 1,
  video: { type: 'local', filename: 'x.mp4', duration: 60 },
  segments: [{ id: 'aaa000', start: 0, end: 10, rate: 1, label: '', inQueue: true }],
  sequence: ['aaa000'],
  loop: { mode: 'off' },
});
const legalCurr = curr.decodeKey(legal);
const legalBase = base.decodeKey(legal);
rows.push({
  name: '回归 · 合法配置（旧树产出的密钥）',
  keyChars: legal.length,
  baseline: legalBase.ok ? 'ok=true' : `ok=false（${legalBase.error.code}）`,
  current: legalCurr.ok ? 'ok=true' : `ok=false（${legalCurr.error.code}）`,
  verdict: legalBase.ok && legalCurr.ok ? '✅ 两树一致（未误伤）' : '❌ 误伤合法密钥',
});

console.log('项4 解码双闸 · 双树对照');
console.log(`baseline = ${BASELINE}`);
console.log(`current  = ${CURRENT}\n`);
console.log('| 输入 | 密钥字符 | 基线树结果 | 当前树结果 | 判定 |');
console.log('| --- | --- | --- | --- | --- |');
for (const r of rows) {
  console.log(`| ${r.name} | ${r.keyChars} | ${r.baseline} | ${r.current} | ${r.verdict} |`);
}

const failed = rows.filter((r) => r.verdict.startsWith('❌') || r.verdict === '旧树已绿（对照组不成立）');
if (failed.length > 0) {
  console.error(`\nFAIL：${failed.length} 行不符合双树对照预期`);
  process.exit(1);
}
console.log('\nPASS：4-a / 4-b 均为「旧树放行（红）→ 新树拒绝（绿）」，且合法密钥未误伤');
