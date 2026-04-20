// detached-spawn.test.mjs — mcp/lib/detached-spawn.mjs の単体テスト
//
// v0.3.5 Option B で新設した spawnDetached ヘルパの動作確認。
// 設計書: plan/claude/26042004_feature-v0-3-5-early-return-design.md §実装詳細
//
// 検証項目:
//   DS1 spawnDetached が PID (number) を返す
//   DS2 親プロセスが exit しても子が生き続ける (grandchild 生存テスト)
//   DS3 stdout / stderr が logFile に書き込まれる
//   DS4 opts.env が子に propagate される
//   DS5 spawn 失敗 (ENOENT) は例外で報告される

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DETACHED_SPAWN_PATH = join(__dirname, '..', 'mcp', 'lib', 'detached-spawn.mjs');

const { spawnDetached } = await import(DETACHED_SPAWN_PATH);

let workspace;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'kioku-dspawn-'));
});

after(() => rm(workspace, { recursive: true, force: true }));

// ヘルパ: PID が live か (signal 0 で OS 問い合わせ)
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ヘルパ: short sleep
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('spawnDetached', () => {
  test('DS1 returns a positive integer PID', async () => {
    const logFile = join(workspace, 'ds1.log');
    const pid = await spawnDetached('/bin/sleep', ['2'], {
      logFile,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      cwd: workspace,
    });
    try {
      assert.equal(typeof pid, 'number');
      assert.ok(Number.isInteger(pid) && pid > 0, `expected positive int pid, got ${pid}`);
      assert.ok(isAlive(pid), `PID ${pid} should be alive right after spawn`);
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
    }
  });

  test('DS2 detached child survives parent (helper) process exit', async () => {
    const logFile = join(workspace, 'ds2.log');
    // Helper script spawns a long-running detached /bin/sleep via spawnDetached,
    // prints the grandchild pid, then exits. We verify the grandchild survives
    // the helper's exit (that's what detached + unref guarantees).
    const helperPath = join(workspace, 'ds2-helper.mjs');
    const helperSrc = `
import { spawnDetached } from ${JSON.stringify(DETACHED_SPAWN_PATH)};
const pid = await spawnDetached('/bin/sleep', ['8'], {
  logFile: ${JSON.stringify(logFile)},
  env: { PATH: process.env.PATH },
  cwd: ${JSON.stringify(workspace)},
});
process.stdout.write(String(pid));
`;
    await writeFile(helperPath, helperSrc);
    const r = spawnSync(process.execPath, [helperPath], { encoding: 'utf8' });
    assert.equal(r.status, 0, `helper exited non-zero: stderr=${r.stderr}`);
    const grandchildPid = Number.parseInt(r.stdout.trim(), 10);
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0,
      `helper should print pid, got: ${JSON.stringify(r.stdout)}`);

    // Helper has exited. The grandchild should still be alive because we unref'd.
    // Tiny sleep to let OS settle post-fork.
    await sleep(50);
    try {
      assert.ok(isAlive(grandchildPid),
        `grandchild ${grandchildPid} should be alive after helper exit`);
    } finally {
      try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* already dead */ }
    }
  });

  test('DS3 stdout and stderr are redirected to logFile', async () => {
    const logFile = join(workspace, 'ds3.log');
    const pid = await spawnDetached(
      '/bin/sh',
      ['-c', 'echo LINE_STDOUT; echo LINE_STDERR >&2'],
      { logFile, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, cwd: workspace },
    );
    // Wait for the child to finish and flush stdio.
    // Poll for logFile content (detached child's exit is not observable from parent).
    let content = '';
    for (let i = 0; i < 40; i++) {
      await sleep(25);
      try {
        content = await readFile(logFile, 'utf8');
        if (content.includes('LINE_STDOUT') && content.includes('LINE_STDERR')) break;
      } catch { /* not yet */ }
      if (!isAlive(pid)) break;
    }
    assert.match(content, /LINE_STDOUT/, `stdout should be captured, got: ${content}`);
    assert.match(content, /LINE_STDERR/, `stderr should be captured, got: ${content}`);
  });

  test('DS4 opts.env is propagated to the child', async () => {
    const logFile = join(workspace, 'ds4.log');
    const sentinel = 'KIOKU_DS4_SENTINEL_VALUE_12345';
    const pid = await spawnDetached(
      '/bin/sh',
      ['-c', 'echo "MARKER=${KIOKU_DS4_SENTINEL}"'],
      {
        logFile,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          KIOKU_DS4_SENTINEL: sentinel,
        },
        cwd: workspace,
      },
    );
    let content = '';
    for (let i = 0; i < 40; i++) {
      await sleep(25);
      try {
        content = await readFile(logFile, 'utf8');
        if (content.includes(sentinel)) break;
      } catch { /* not yet */ }
      if (!isAlive(pid)) break;
    }
    assert.match(content, new RegExp(`MARKER=${sentinel}`),
      `custom env var should reach child, got: ${content}`);
  });

  test('DS5 spawn failure (missing binary) rejects with an Error', async () => {
    const logFile = join(workspace, 'ds5.log');
    await assert.rejects(
      () => spawnDetached(
        '/nonexistent/path/to/binary-does-not-exist-xyz',
        [],
        { logFile, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, cwd: workspace },
      ),
      (err) => err instanceof Error,
    );
  });

  test('DS6 opts.logFile is required', async () => {
    await assert.rejects(
      () => spawnDetached('/bin/true', [], { env: {}, cwd: workspace }),
      (err) => err instanceof Error && /logFile/.test(err.message),
    );
  });

  test('DS7 logFile parent directory is created if missing', async () => {
    const nestedLog = join(workspace, 'ds7-nested', 'deep', 'dir', 'ds7.log');
    const pid = await spawnDetached('/bin/sh', ['-c', 'echo HELLO_NESTED'], {
      logFile: nestedLog,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      cwd: workspace,
    });
    let content = '';
    for (let i = 0; i < 40; i++) {
      await sleep(25);
      try {
        content = await readFile(nestedLog, 'utf8');
        if (content.includes('HELLO_NESTED')) break;
      } catch { /* not yet */ }
      if (!isAlive(pid)) break;
    }
    assert.match(content, /HELLO_NESTED/);
  });
});
