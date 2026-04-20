// progress-heartbeat.test.mjs — MCP progress notification 送信ロジック
//
// v0.3.4 fix: 長時間 tool (kioku_ingest_pdf / kioku_ingest_url) で Claude Desktop が
// 60s request timeout を切る問題の修正。client の progressToken に対して periodic に
// notifications/progress を送って idle timeout をリセットする機構。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startHeartbeat } from '../mcp/lib/progress-heartbeat.mjs';

describe('progress-heartbeat', () => {
  test('HB1 sendProgress=null → no-op, stop も即座に resolve', async () => {
    const stop = startHeartbeat(null, 'msg');
    assert.equal(typeof stop, 'function');
    await stop('final');
    // 例外なく完了すれば OK
  });

  test('HB2 sendProgress=undefined → no-op', async () => {
    const stop = startHeartbeat(undefined, 'msg');
    await stop();
  });

  test('HB3 initial message が即座に 1 回送信される', async () => {
    const calls = [];
    const fakeSend = async (msg) => { calls.push(msg); };
    const stop = startHeartbeat(fakeSend, 'initial');
    // startHeartbeat は同期で initial を呼ぶ (await しない) が、fakeSend は即返る
    // ので次のマイクロタスクで calls が埋まる
    await new Promise((r) => setImmediate(r));
    assert.ok(calls.includes('initial'), `initial が送られること (got: ${JSON.stringify(calls)})`);
    await stop();
  });

  test('HB4 interval 毎に periodic に送信される', async () => {
    const calls = [];
    const fakeSend = async (msg) => { calls.push(msg); };
    // 高速化のため intervalMs を 20ms に。initial 1 回 + 20ms 2 回 + stop 1 回 = 4 回想定
    const stop = startHeartbeat(fakeSend, 'tick', { intervalMs: 20 });
    await new Promise((r) => setTimeout(r, 55));
    await stop('done');
    // initial + interval 2 回 + stop
    assert.ok(calls.length >= 3, `最低 3 回呼ばれる (got: ${calls.length}, calls: ${JSON.stringify(calls)})`);
    assert.equal(calls[0], 'tick', 'initial message');
    assert.ok(calls.some((m) => m === 'tick (in progress)'), 'interval tick');
    assert.equal(calls[calls.length - 1], 'done', 'final stop message');
  });

  test('HB5 stop() 後は interval が走らない (leak 防止)', async () => {
    const calls = [];
    const fakeSend = async (msg) => { calls.push(msg); };
    const stop = startHeartbeat(fakeSend, 'tick', { intervalMs: 20 });
    await new Promise((r) => setTimeout(r, 25));
    await stop('done');
    const afterStopCount = calls.length;
    // さらに 60ms 待っても増えない
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(calls.length, afterStopCount,
      `stop 後に heartbeat が続いている (before: ${afterStopCount}, after: ${calls.length})`);
  });

  test('HB6 sendProgress が throw しても interval は継続する (resilience)', async () => {
    let count = 0;
    const fakeSend = async () => {
      count++;
      throw new Error('send failed');
    };
    const stop = startHeartbeat(fakeSend, 'tick', { intervalMs: 15 });
    // 2 回 interval 走らせる
    await new Promise((r) => setTimeout(r, 50));
    await stop('done');
    // initial + 少なくとも 1 回 interval + stop = 3 回以上呼ばれていること
    assert.ok(count >= 3, `resilient (got: ${count})`);
  });

  test('HB7 stop() を 2 回呼んでも安全 (冪等)', async () => {
    const calls = [];
    const fakeSend = async (msg) => { calls.push(msg); };
    const stop = startHeartbeat(fakeSend, 'tick');
    await stop('done-1');
    await stop('done-2');
    const doneCount = calls.filter((m) => m.startsWith('done')).length;
    assert.equal(doneCount, 1, `stop-message は 1 回だけ送られる (got: ${calls.join(',')})`);
  });
});
