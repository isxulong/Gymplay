#!/usr/bin/env node
/**
 * 密钥向后兼容对照脚本（v0.3.1 · R2 AC4 / R3 AC7；复核一 P2-3 补交）
 *
 * 双跑对照：在「基线树」与「当前树」分别加载各自的 src/core/config/codec.ts，
 * 对同一组固定配置跑 encodeConfig，逐字节比对密钥（长度 + SHA-256）；
 * 另做交叉解码：用当前树 decodeKey 解码基线产出的密钥，还原的规范化 JSON 须一致
 * （旧链接在新版本解码行为不变）。
 *
 * 用法：node scripts/key-compat.mjs <基线树路径> [当前树路径]
 *   - 基线树：如 GitHub main 74de1b2 的 tarball 解包目录（无需 node_modules）；
 *   - 当前树：缺省为本脚本所在仓库根（需已 npm ci，提供 esbuild 与 pako）。
 * 退出码：0 = 全部一致；1 = 任一不一致或加载失败。
 *
 * 实现说明：TS 源经 esbuild（devDependencies，随 npm ci 安装）打包为 ESM 后动态加载；
 * pako 一并打包进产物，但统一从当前树 node_modules 解析（nodePaths；两树 lockfile
 * 均锁定 1.0.11，与产线一致），因此比较的是两树 codec/schema/migrate 源码语义的差异。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/** 配置对象为纯 JSON，深拷贝避免 encodeConfig 就地变更污染后续调用。 */
const clone = (v) => JSON.parse(JSON.stringify(v));

const CURRENT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = process.argv[2] ? resolve(process.argv[2]) : null;
if (!BASELINE || !existsSync(join(BASELINE, 'src/core/config/codec.ts'))) {
  console.error('用法：node scripts/key-compat.mjs <基线树路径> [当前树路径]');
  console.error('基线树须包含 src/core/config/codec.ts（如 GitHub main 74de1b2 解包目录）');
  process.exit(1);
}

// ---- 固定配置样例（合法 Schema v1；覆盖单段/多段/循环/小时级时长/50 段边界） ----
function seg(id, start, end, rate, label = '', inQueue = true) {
  return { id, start, end, rate, label, inQueue };
}
const SAMPLES = [
  {
    name: 'minimal-1seg',
    cfg: {
      v: 1,
      video: { type: 'local', filename: 'workout.mp4', duration: 60 },
      segments: [seg('aaa000', 0, 10, 1)],
      sequence: ['aaa000'],
      loop: { mode: 'off' },
    },
  },
  {
    name: 'typical-3seg-loop-queue',
    cfg: {
      v: 1,
      video: { type: 'local', filename: '晨练.mp4', duration: 600 },
      segments: [
        seg('aaa000', 0, 120, 0.75, '热身'),
        seg('bbb111', 120, 480, 1.5, '主训练', false),
        seg('ccc222', 480, 600, 1, '放松'),
      ],
      sequence: ['aaa000', 'ccc222', 'aaa000'],
      loop: { mode: 'queue', count: 2 },
      meta: { createdAt: '2026-11-02T20:00:00+08:00', appVersion: '0.3.0' },
    },
  },
  {
    name: 'rich-hour-scale',
    cfg: {
      v: 1,
      video: { type: 'local', filename: 'long-run.mp4', duration: 3723.4 },
      segments: [
        seg('aaa000', 0, 100.25, 0.5, '慢速区'),
        seg('ccc222', 100.25, 200.75, 1.25),
        seg('bbb111', 200.75, 3723.4, 4, '跳过区'),
      ],
      sequence: ['ccc222', 'aaa000'],
      loop: { mode: 'segment' },
    },
  },
  {
    name: 'boundary-50seg',
    cfg: (() => {
      const segments = [];
      const sequence = [];
      for (let i = 0; i < 50; i++) {
        const id = i.toString(36).padStart(6, '0');
        segments.push(seg(id, i * 10, i * 10 + 10, 1 + (i % 4) * 0.25, `段${i + 1}`, i % 3 !== 0));
        sequence.push(id);
      }
      return {
        v: 1,
        video: { type: 'local', filename: 'full.mp4', duration: 500 },
        segments,
        sequence,
        loop: { mode: 'queue', count: 3 },
      };
    })(),
  },
];

async function loadCodec(tree, tag) {
  const entry = join(tree, 'src/core/config/codec.ts');
  if (!existsSync(entry)) throw new Error(`${tag} 缺少 src/core/config/codec.ts：${tree}`);
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    // pako 两树同版（lockfile 均锁 1.0.11）：打包进产物、统一从当前树解析
    nodePaths: [join(CURRENT, 'node_modules')],
    write: false,
    logLevel: 'silent',
  });
  // 临时产物放当前树 node_modules 下，使 bare import 'pako' 解析到当前树锁定版本
  const dir = join(CURRENT, 'node_modules', '.key-compat');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${tag}-codec.mjs`);
  writeFileSync(file, out.outputFiles[0].text);
  return import(file);
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

const base = await loadCodec(BASELINE, 'baseline');
const curr = await loadCodec(CURRENT, 'current');

let fail = 0;
console.log(`密钥兼容双跑对照：baseline=${BASELINE}`);
console.log(`                current =${CURRENT}\n`);
console.log('| 配置样例 | 基线密钥长度 | 当前密钥长度 | 字节一致 | sha256(前16) |');
console.log('| --- | --- | --- | --- | --- |');
for (const { name, cfg } of SAMPLES) {
  const keyB = base.encodeConfig(clone(cfg));
  const keyC = curr.encodeConfig(clone(cfg));
  const same = keyB === keyC;
  if (!same) fail++;
  console.log(
    `| ${name} | ${keyB.length} | ${keyC.length} | ${same ? '✅' : '❌'} | ${sha256(keyC)} |`,
  );

  // 交叉解码：当前树解基线密钥，还原配置的规范化 JSON 须与 canonicalize(原配置) 一致
  const decoded = curr.decodeKey(keyB);
  const roundTrip = decoded.ok && curr.canonicalize(decoded.value) === curr.canonicalize(cfg);
  if (!roundTrip) {
    fail++;
    console.log(`  ❌ ${name}：当前树 decodeKey(基线密钥) 未还原同一配置`);
  }
}

if (fail > 0) {
  console.error(`\nFAIL：${fail} 处不一致`);
  process.exit(1);
}
console.log('\nPASS：全部样例两树密钥字节一致，且基线密钥可被当前树解码还原（R2 AC4 / R3 AC7 闭合）');
