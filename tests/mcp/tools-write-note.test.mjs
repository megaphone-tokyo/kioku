// tools-write-note.test.mjs — kioku_write_note ハンドラのユニットテスト

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_DIR = join(__dirname, '..', '..', 'mcp');

const { handleWriteNote } = await import(join(MCP_DIR, 'tools', 'write-note.mjs'));
const { parseFrontmatter } = await import(join(MCP_DIR, 'lib', 'frontmatter.mjs'));

let workspace, vault;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'kioku-mcp-wn-'));
  vault = join(workspace, 'vault');
  await mkdir(join(vault, 'wiki'), { recursive: true });
});

after(() => rm(workspace, { recursive: true, force: true }));

describe('kioku_write_note', () => {
  test('MCP13 creates session-logs/<...>-mcp-<slug>.md with required frontmatter', async () => {
    const r = await handleWriteNote(vault, {
      title: 'Hello World',
      body: 'A note from desktop',
      tags: ['demo', 'mcp'],
    });
    assert.match(r.path, /^session-logs\/\d{8}-\d{6}-mcp-Hello-World\.md$/);
    assert.equal(r.action, 'created');
    const abs = join(vault, r.path);
    const st = await stat(abs);
    assert.equal(st.mode & 0o777, 0o600);
    const content = await readFile(abs, 'utf8');
    const { data, body } = parseFrontmatter(content);
    assert.equal(data.type, 'mcp-note');
    assert.equal(data.ingested, false);
    assert.equal(data.source, 'claude-desktop');
    assert.deepEqual(data.tags, ['demo', 'mcp']);
    assert.match(data.created, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(body, /# Hello World/);
    assert.match(body, /A note from desktop/);
  });

  test('MCP14 masks secrets in body before writing', async () => {
    const r = await handleWriteNote(vault, {
      title: 'leak',
      body: 'token sk-ant-AAAAAAAAAAAAAAAAAAAAAAAA more',
    });
    const abs = join(vault, r.path);
    const content = await readFile(abs, 'utf8');
    assert.match(content, /sk-ant-\*\*\*/);
    assert.doesNotMatch(content, /sk-ant-A/);
  });

  test('MCP14b masks secrets in title and tags before writing', async () => {
    const r = await handleWriteNote(vault, {
      title: 'leak ghp_BBBBBBBBBBBBBBBBBBBBBBBB',
      body: 'safe body',
      tags: ['plain', 'sk-ant-CCCCCCCCCCCCCCCCCCCCCCCC'],
    });
    const abs = join(vault, r.path);
    const content = await readFile(abs, 'utf8');
    assert.doesNotMatch(content, /ghp_B/);
    assert.match(content, /ghp_\*\*\*/);
    assert.doesNotMatch(content, /sk-ant-C/);
    assert.match(content, /sk-ant-\*\*\*/);
  });

  test('MCP15 disambiguates colliding filenames with -2/-3 suffix', async () => {
    const before = (await readdir(join(vault, 'session-logs'))).length;
    const r1 = await handleWriteNote(vault, { title: 'samename', body: 'x' });
    const r2 = await handleWriteNote(vault, { title: 'samename', body: 'y' });
    const r3 = await handleWriteNote(vault, { title: 'samename', body: 'z' });
    const after = await readdir(join(vault, 'session-logs'));
    assert.equal(after.length, before + 3);
    assert.notEqual(r1.path, r2.path);
    assert.notEqual(r2.path, r3.path);
  });

  test('rejects empty title', async () => {
    await assert.rejects(
      handleWriteNote(vault, { title: '   ', body: 'x' }),
      (err) => err.code === 'invalid_params',
    );
  });

  test('rejects missing body', async () => {
    await assert.rejects(
      handleWriteNote(vault, { title: 'x' }),
      (err) => err.code === 'invalid_params',
    );
  });

  test('strips path-separator chars from slug', async () => {
    const r = await handleWriteNote(vault, {
      title: '../../etc/passwd evil',
      body: 'x',
    });
    assert.doesNotMatch(r.path, /\.\./);
    assert.doesNotMatch(r.path, /passwd\//);
  });
});
