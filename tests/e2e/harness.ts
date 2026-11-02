/**
 * E2E 承载页脚本：在真实浏览器里运行 NativeEngine 契约用例。
 *
 * 定稿 §2.5：jsdom 的 HTMLMediaElement 是 stub，NativeEngine 契约一致性
 * 在 Playwright 真实浏览器层执行。本页把引擎操作暴露到 window.__harness，
 * 用例与 Node 侧 FakeEngine 契约（tests/unit/fakes/fake-engine.ts 记录
 * 指令序列）保持同一组输入序列：load → setRate → play → seek → pause → ended。
 *
 * 本页只经 vite dev server 服务，不进 dist 构建产物。
 */

import { createNativeEngine } from '../../src/core/player/native-engine';
import type { EngineEvent, PlayerEngine } from '../../src/core/player/engine';

const FIXTURE_URL = '/tests/e2e/fixtures/fixture-vp8-opus-10s.webm';

export interface ContractResult {
  loadOk: boolean;
  durationSec: number;
  rateApplied: number;
  rateClamped: number;
  preservesPitch: boolean;
  played: boolean;
  tickCount: number;
  seekedTo3: number;
  pausedOk: boolean;
  endedFired: boolean;
  ticksStoppedAfterDestroy: boolean;
  events: string[];
  error?: string;
}

interface Harness {
  runContract(): Promise<ContractResult>;
}

declare global {
  interface Window {
    __harness?: Harness;
    __harnessReady?: boolean;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await wait(50);
  }
  return cond();
}

window.__harness = {
  async runContract(): Promise<ContractResult> {
    const events: string[] = [];
    const result: ContractResult = {
      loadOk: false,
      durationSec: 0,
      rateApplied: 0,
      rateClamped: 0,
      preservesPitch: false,
      played: false,
      tickCount: 0,
      seekedTo3: -1,
      pausedOk: false,
      endedFired: false,
      ticksStoppedAfterDestroy: false,
      events,
    };
    let engine: PlayerEngine | null = null;
    try {
      const blob = await (await fetch(FIXTURE_URL)).blob();
      const file = new File([blob], 'fixture-vp8-opus-10s.webm', { type: 'video/webm' });
      const video = document.createElement('video');
      video.muted = true;
      document.getElementById('harness')!.append(video);

      engine = createNativeEngine(video, { rVFC: true });
      let tickCount = 0;
      engine.onTick(() => {
        tickCount += 1;
      });
      engine.onEvent((e: EngineEvent) => events.push(e.type));

      // load
      const url = URL.createObjectURL(file);
      await engine.load({ kind: 'local', url, filename: file.name });
      result.loadOk = true;
      result.durationSec = video.duration;

      // setRate：正常值 + 超界钳制 + preservesPitch 默认开
      engine.setRate(2);
      result.rateApplied = video.playbackRate;
      result.preservesPitch = video.preservesPitch;
      engine.setRate(8);
      result.rateClamped = video.playbackRate;
      engine.setRate(2);

      // play + ticks
      await engine.play();
      result.played = !video.paused;
      const ticksBefore = tickCount;
      await wait(700);
      result.tickCount = tickCount - ticksBefore;

      // seek(3)：等 seeked 后读回
      const seeked = new Promise<void>((r) => video.addEventListener('seeked', () => r(), { once: true }));
      engine.seek(3);
      await Promise.race([seeked, wait(3000)]);
      result.seekedTo3 = engine.getTime();

      // pause
      engine.pause();
      result.pausedOk = video.paused;

      // ended：跳到末尾附近播放至结束
      engine.seek(video.duration - 0.4);
      engine.setRate(4);
      await engine.play();
      result.endedFired = await waitFor(() => events.includes('ended'), 8000);

      // destroy：tick 停止
      engine.destroy();
      const ticksAtDestroy = tickCount;
      await wait(300);
      result.ticksStoppedAfterDestroy = tickCount === ticksAtDestroy;
      engine = null;
      URL.revokeObjectURL(url);
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    } finally {
      engine?.destroy();
    }
    return result;
  },
};
window.__harnessReady = true;
