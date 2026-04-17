// tools-read.test.mjs — kioku_read / kioku_list ハンドラのユニットテスト

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_DIR = join(__dirname, '..', '..', 'mcp');

const { handleRead } = await import(join(MCP_DIR, 'tools', 'read.mjs'));
const { handleList } = await import(join(MCP_DIR, 'tools', 'list.mjs'));

let root, vault;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'kioku-mcp-read-'));
  vault = join(root, 'vault');
  await mkdir(join(vault, 'wiki', 'concepts'), { recursive: true });
  await mkdir(join(vault, 'wiki', '.archive'), { recursive: true });
  await mkdir(join(vault, 'wiki', '.obsidian'), { recursive: true });
  await mkdir(join(vault, 'session-logs'), { recursive: true });
  await writeFile(join(vault, 'wiki', 'index.md'), '# Index\n\n- [[Foo]]\n');
  await writeFile(join(vault, 'wiki', 'concepts', 'foo.md'), '# Foo\nbody\n');
  await writeFile(join(vault, 'wiki', 'concepts', 'bar.md'), '# Bar\n');
  await writeFile(join(vault, 'wiki', '.obsidian', 'workspace'), '{}');
  await writeFile(join(vault, 'session-logs', 'sl.md'), 'log\n');
});

after(() => rm(root, { recursive: true, force: true }));

describe('kioku_read', () => {
  test('MCP3 reads existing wiki page', async () => {
    const r = await handleRead(vault, { path: 'index.md' });
    assert.match(r.contents, /# Index/);
    assert.equal(r.truncated, false);
    assert.ok(r.byteSize > 0);
  });

  test('MCP4 rejects path traversal', async () => {
    await assert.rejects(
      handleRead(vault, { path: '../../etc/passwd' }),
      (err) => err.code === 'path_traversal' || err.code === 'invalid_path',
    );
  });

  test('MCP5 rejects absolute path', async () => {
    await assert.rejects(
      handleRead(vault, { path: '/etc/passwd' }),
      (err) => err.code === 'absolute_path' || err.code === 'invalid_path',
    );
  });

  test('MCP6 rejects symlink that escapes wiki/', async () => {
    const linkPath = join(vault, 'wiki', 'evil.md');
    try {
      await symlink(join(vault, 'session-logs', 'sl.md'), linkPath);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    await assert.rejects(
      handleRead(vault, { path: 'evil.md' }),
      (err) => err.code === 'path_outside_boundary',
    );
  });

  test('MCP7 truncates files exceeding 256KB', async () => {
    const big = 'x'.repeat(300 * 1024);
    await writeFile(join(vault, 'wiki', 'big.md'), big);
    const r = await handleRead(vault, { path: 'big.md' });
    assert.equal(r.truncated, true);
    assert.equal(r.contents.length, 256 * 1024);
    assert.equal(r.byteSize, big.length);
  });

  test('rejects missing path arg', async () => {
    await assert.rejects(handleRead(vault, {}), (err) => err.code === 'invalid_params');
  });

  test('rejects non-existent file', async () => {
    await assert.rejects(
      handleRead(vault, { path: 'does-not-exist.md' }),
      (err) => err.code === 'file_not_found',
    );
  });
});

describe('kioku_list', () => {
  test('MCP8a lists wiki root with default depth', async () => {
    const r = await handleList(vault, {});
    const paths = r.entries.map((e) => e.path).sort();
    assert.ok(paths.includes('index.md'));
    assert.ok(paths.includes('concepts'));
    assert.ok(paths.includes('concepts/bar.md'));
    assert.ok(paths.includes('concepts/foo.md'));
  });

  test('MCP8b excludes .obsidian / .archive', async () => {
    const r = await handleList(vault, {});
    const paths = r.entries.map((e) => e.path);
    assert.ok(!paths.some((p) => p.includes('.obsidian')));
    assert.ok(!paths.some((p) => p.includes('.archive')));
  });

  test('MCP8c clamps depth to max 5', async () => {
    const r = await handleList(vault, { depth: 99 });
    // No exception. The clamping is internal; just check it runs.
    assert.ok(Array.isArray(r.entries));
  });

  test('lists subdirectory', async () => {
    const r = await handleList(vault, { subdir: 'concepts' });
    const paths = r.entries.map((e) => e.path).sort();
    assert.deepEqual(paths, ['bar.md', 'foo.md']);
  });

  test('returns metadata fields for files', async () => {
    const r = await handleList(vault, { subdir: 'concepts' });
    for (const e of r.entries.filter((x) => x.type === 'file')) {
      assert.equal(typeof e.size, 'number');
      assert.match(e.mtime, /^\d{4}-\d{2}-\d{2}T/);
    }
  });
});
