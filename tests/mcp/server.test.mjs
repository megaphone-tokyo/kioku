// server.test.mjs — kioku-mcp サーバーの JSON-RPC E2E テスト
//
// stdio に initialize → initialized → tools/list → tools/call をパイプして応答を検証。

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, '..', '..', 'mcp', 'server.mjs');

let workspace, vault;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'kioku-mcp-srv-'));
  vault = join(workspace, 'vault');
  await mkdir(join(vault, 'wiki', 'concepts'), { recursive: true });
  await mkdir(join(vault, 'session-logs'), { recursive: true });
  await writeFile(join(vault, 'wiki', 'index.md'), '# Index\n');
  await writeFile(join(vault, 'wiki', 'concepts', 'foo.md'), '# Foo\nbody\n');
});

after(() => rm(workspace, { recursive: true, force: true }));

function startServer(extraEnv = {}) {
  const child = spawn('node', [SERVER_PATH], {
    env: { ...process.env, OBSIDIAN_VAULT: vault, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return child;
}

function send(child, msg) {
  child.stdin.write(JSON.stringify(msg) + '\n');
}

function collectResponses(child, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const responses = [];
    let buffer = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try { child.kill('SIGTERM'); } catch {}
        resolve(responses);
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          responses.push(JSON.parse(line));
        } catch {
          // skip malformed
        }
      }
    });
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(responses);
    });
  });
}

async function rpc(child, requests) {
  const collector = collectResponses(child);
  for (const req of requests) send(child, req);
  // Give server time to respond, then close stdin
  setTimeout(() => {
    try { child.stdin.end(); } catch {}
  }, 200);
  return collector;
}

describe('kioku-mcp server', () => {
  test('MCP1 initialize returns serverInfo', async () => {
    const child = startServer();
    const responses = await rpc(child, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '0.0.0' },
        },
      },
    ]);
    const init = responses.find((r) => r.id === 1);
    assert.ok(init, `expected initialize response, got: ${JSON.stringify(responses)}`);
    assert.equal(init.result?.serverInfo?.name, 'kioku-wiki');
  });

  test('MCP2 tools/list returns 6 kioku_ tools', async () => {
    const child = startServer();
    const responses = await rpc(child, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]);
    const list = responses.find((r) => r.id === 2);
    assert.ok(list, `tools/list response missing: ${JSON.stringify(responses)}`);
    const names = (list.result?.tools ?? []).map((t) => t.name).sort();
    assert.deepEqual(names, [
      'kioku_delete',
      'kioku_list',
      'kioku_read',
      'kioku_search',
      'kioku_write_note',
      'kioku_write_wiki',
    ]);
  });

  test('tools/call kioku_read returns wiki content', async () => {
    const child = startServer();
    const responses = await rpc(child, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'kioku_read', arguments: { path: 'index.md' } },
      },
    ]);
    const callResp = responses.find((r) => r.id === 2);
    assert.ok(callResp, `tools/call response missing: ${JSON.stringify(responses)}`);
    assert.ok(!callResp.result?.isError, JSON.stringify(callResp.result));
    const text = callResp.result?.content?.[0]?.text;
    assert.match(text, /# Index/);
  });

  test('MCP12 tools/call invalid args returns error result', async () => {
    const child = startServer();
    const responses = await rpc(child, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'kioku_read', arguments: { path: '../../etc/passwd' } },
      },
    ]);
    const callResp = responses.find((r) => r.id === 2);
    assert.ok(callResp);
    assert.equal(callResp.result?.isError, true);
    const errText = callResp.result?.content?.[0]?.text;
    assert.match(errText, /path/);
  });

  test('stdout is JSON-RPC only (no console.log noise)', async () => {
    const child = startServer({ KIOKU_DEBUG: '1' });
    let stderrOut = '';
    child.stderr.on('data', (d) => (stderrOut += d.toString()));
    const responses = await rpc(child, [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      },
    ]);
    // Every collected response must be valid JSON
    for (const r of responses) {
      assert.equal(r.jsonrpc, '2.0');
    }
    // Debug output went to stderr, not stdout
    assert.match(stderrOut, /kioku-mcp/);
  });

  test('exits 1 when OBSIDIAN_VAULT is unset', async () => {
    const child = spawn('node', [SERVER_PATH], {
      env: { ...process.env, OBSIDIAN_VAULT: '' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderrOut = '';
    child.stderr.on('data', (d) => (stderrOut += d.toString()));
    const exitCode = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(exitCode, 1);
    assert.match(stderrOut, /OBSIDIAN_VAULT/);
  });
});
