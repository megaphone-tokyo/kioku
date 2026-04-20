// tests/url-extract-cli.test.mjs — url-extract-cli.mjs の spawn smoke テスト
//
// CLI 層は shell wrapper (extract-url.sh) と MCP tool (Phase 7) から呼ばれる。
// ここでは最低限の契約 (exit code / stdout JSON / stderr message) を検証する。

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './helpers/fixture-server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'mcp', 'lib', 'url-extract-cli.mjs');

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('url-extract-cli', () => {
  let server, workspace, vault;
  before(async () => {
    server = await startFixtureServer();
    workspace = await mkdtemp(join(tmpdir(), 'kioku-uec-'));
    vault = join(workspace, 'vault');
    await mkdir(join(vault, 'raw-sources', 'articles', 'fetched'), { recursive: true });
    await mkdir(join(vault, '.cache', 'html'), { recursive: true });
  });
  after(async () => {
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  });

  test('CLI normal URL → exit 0 + JSON on stdout', async () => {
    const r = await runCli(
      [
        '--url', `${server.url}/article-normal.html`,
        '--vault', vault,
        '--subdir', 'articles',
        '--robots-override', `${server.url}/robots.txt?variant=allow`,
      ],
      { KIOKU_URL_ALLOW_LOOPBACK: '1' },
    );
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    const json = JSON.parse(r.stdout);
    assert.ok(json.status);
    assert.ok(json.source_sha256);
    assert.match(json.path, /raw-sources\/articles\/fetched\//);
  });

  test('CLI missing --url → exit 2 + stderr', async () => {
    const r = await runCli(['--vault', vault]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--url required/i);
  });

  test('CLI missing --vault → exit 2 + stderr', async () => {
    const r = await runCli(['--url', 'https://example.com/']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--vault required/i);
  });

  test('CLI robots Disallow → exit 3', async () => {
    const r = await runCli(
      [
        '--url', `${server.url}/article-normal.html`,
        '--vault', vault,
        '--subdir', 'articles',
        '--robots-override', `${server.url}/robots.txt?variant=disallow`,
      ],
      { KIOKU_URL_ALLOW_LOOPBACK: '1' },
    );
    assert.equal(r.code, 3, `stderr=${r.stderr}`);
    assert.match(r.stderr, /robots_disallow/);
  });

  test('CLI fetch failure (non-http scheme in validated mode) → exit 4', async () => {
    const r = await runCli(
      [
        '--url', 'file:///etc/passwd',
        '--vault', vault,
        '--subdir', 'articles',
      ],
      {}, // intentionally no KIOKU_URL_ALLOW_LOOPBACK, no KIOKU_URL_IGNORE_ROBOTS
    );
    // robots check will fail first (file:// scheme rejected by validateUrl).
    // The fetch error propagates as code=url_scheme or similar → exit 4.
    assert.equal(r.code, 4, `stdout=${r.stdout} stderr=${r.stderr}`);
  });

  test('CLI security-code error message is scrubbed (red M-2)', async () => {
    // red M-2 fix (2026-04-20): FetchError の raw message に解決済み内部 IP や
    // attacker-controlled hostname がそのまま embed された状態で cron log に
    // leak する経路を塞ぐ。security code (url_scheme / dns_private / ...) では
    // err.message を出さず "blocked by security policy" のみ stderr に出力。
    const r = await runCli(
      [
        '--url', 'file:///etc/passwd',
        '--vault', vault,
        '--subdir', 'articles',
      ],
    );
    assert.equal(r.code, 4);
    assert.match(r.stderr, /blocked by security policy/, 'scrubbed generic message expected');
    // 内部パスや URL 文字列が stderr に leak していないこと
    assert.doesNotMatch(r.stderr, /\/etc\/passwd/, 'attacker-controlled URL path must not leak');
    assert.doesNotMatch(r.stderr, /file:\/\//, 'raw scheme must not leak');
    // code は出す (operator 側の debug 情報として必要)
    assert.match(r.stderr, /\((url_scheme|url_parse)\)/, 'code is still surfaced for ops visibility');
  });

  test('CLI tags flag parses comma-separated list', async () => {
    // 別 subdir で fresh 書込み (orchestrator の idempotency で以前の file が skip を
    // 返してしまうため、テスト単位で isolate する)。
    const r = await runCli(
      [
        '--url', `${server.url}/article-normal.html`,
        '--vault', vault,
        '--subdir', 'tags-test',
        '--robots-override', `${server.url}/robots.txt?variant=allow`,
        '--tags', 'foo, bar ,baz',
      ],
      { KIOKU_URL_ALLOW_LOOPBACK: '1' },
    );
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    const json = JSON.parse(r.stdout);
    assert.ok(json.status);
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(join(vault, json.path), 'utf8');
    assert.match(content, /tags: \["foo", "bar", "baz"\]/);
  });

  test('CLI --refresh-days=never → passed through', async () => {
    const r = await runCli(
      [
        '--url', `${server.url}/article-normal.html`,
        '--vault', vault,
        '--subdir', 'never-test',
        '--robots-override', `${server.url}/robots.txt?variant=allow`,
        '--refresh-days', 'never',
      ],
      { KIOKU_URL_ALLOW_LOOPBACK: '1' },
    );
    assert.equal(r.code, 0, `stderr=${r.stderr}`);
    const json = JSON.parse(r.stdout);
    assert.ok(json.status);
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(join(vault, json.path), 'utf8');
    assert.match(content, /refresh_days: "never"/);
  });
});
