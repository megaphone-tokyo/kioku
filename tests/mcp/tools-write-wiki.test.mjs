// tools-write-wiki.test.mjs — kioku_write_wiki ハンドラのユニットテスト

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_DIR = join(__dirname, '..', '..', 'mcp');
const TEMPLATES_DIR = join(__dirname, '..', '..', 'templates', 'notes');

const { handleWriteWiki } = await import(join(MCP_DIR, 'tools', 'write-wiki.mjs'));
const { parseFrontmatter } = await import(join(MCP_DIR, 'lib', 'frontmatter.mjs'));

let workspace, vault;

before(async () => {
  // テンプレを実プロジェクトから参照
  process.env.KIOKU_TEMPLATES_DIR = TEMPLATES_DIR;
});

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'kioku-mcp-ww-'));
  vault = join(workspace, 'vault');
  await mkdir(join(vault, 'wiki', 'concepts'), { recursive: true });
  await mkdir(join(vault, 'session-logs'), { recursive: true });
});

after(async () => {
  delete process.env.KIOKU_TEMPLATES_DIR;
});

async function cleanup() {
  if (workspace) await rm(workspace, { recursive: true, force: true });
}

describe('kioku_write_wiki', () => {
  test('MCP16 create with template=concept generates frontmatter and skeleton', async () => {
    try {
      const r = await handleWriteWiki(vault, {
        path: 'concepts/foo.md',
        title: 'Foo',
        body: 'Foo is a thing.',
        template: 'concept',
        tags: ['extra'],
      });
      assert.equal(r.action, 'created');
      assert.equal(r.path, 'wiki/concepts/foo.md');
      const content = await readFile(join(vault, 'wiki', 'concepts', 'foo.md'), 'utf8');
      const { data, body } = parseFrontmatter(content);
      assert.equal(data.title, 'Foo');
      // tags = template.concept tags ['concept'] union ['extra']
      assert.deepEqual(data.tags.sort(), ['concept', 'extra'].sort());
      assert.match(data.created, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(data.created, data.updated);
      assert.equal(data.source, 'mcp-write-wiki');
      assert.match(body, /## 概要/);
      assert.match(body, /Foo is a thing\./);
    } finally { await cleanup(); }
  });

  test('MCP17 create on existing file errors with file_exists', async () => {
    try {
      await writeFile(join(vault, 'wiki', 'a.md'), '---\ntitle: a\n---\nold\n');
      await assert.rejects(
        handleWriteWiki(vault, { path: 'a.md', title: 'A', body: 'x' }),
        (err) => err.code === 'file_exists',
      );
    } finally { await cleanup(); }
  });

  test('MCP18 append adds dated section, updates updated only', async () => {
    try {
      const original = '---\ntitle: A\ntags: [x]\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\n---\n\nfirst body\n';
      await writeFile(join(vault, 'wiki', 'a.md'), original);
      const r = await handleWriteWiki(vault, {
        path: 'a.md', title: 'ignored on append', body: 'second body', mode: 'append',
      });
      assert.equal(r.action, 'appended');
      const after = await readFile(join(vault, 'wiki', 'a.md'), 'utf8');
      const { data, body } = parseFrontmatter(after);
      assert.equal(data.created, '2026-01-01T00:00:00.000Z');
      assert.notEqual(data.updated, '2026-01-01T00:00:00.000Z');
      assert.match(body, /first body/);
      assert.match(body, /## \d{4}-\d{2}-\d{2}T/);
      assert.match(body, /second body/);
    } finally { await cleanup(); }
  });

  test('MCP19 merge unions tags, appends body', async () => {
    try {
      const original = '---\ntitle: A\ntags: [x, y]\n---\n\nfirst\n';
      await writeFile(join(vault, 'wiki', 'a.md'), original);
      await handleWriteWiki(vault, {
        path: 'a.md', title: 'A', body: 'second', mode: 'merge', tags: ['y', 'z'],
      });
      const after = await readFile(join(vault, 'wiki', 'a.md'), 'utf8');
      const { data, body } = parseFrontmatter(after);
      assert.deepEqual(data.tags.sort(), ['x', 'y', 'z'].sort());
      assert.match(body, /first/);
      assert.match(body, /second/);
    } finally { await cleanup(); }
  });

  test('MCP20 rejects path that escapes wiki/', async () => {
    try {
      await assert.rejects(
        handleWriteWiki(vault, {
          path: '../session-logs/x.md', title: 'X', body: 'y',
        }),
        (err) => err.code === 'path_traversal' || err.code === 'invalid_params',
      );
    } finally { await cleanup(); }
  });

  test('MCP21 related[] adds idempotent wikilink to existing pages', async () => {
    try {
      await writeFile(join(vault, 'wiki', 'parent.md'),
        '---\ntitle: Parent\n---\n\n# Parent\n');
      await handleWriteWiki(vault, {
        path: 'concepts/child.md', title: 'Child', body: 'c',
        related: ['Parent'],
      });
      const parent1 = await readFile(join(vault, 'wiki', 'parent.md'), 'utf8');
      assert.match(parent1, /\[\[Child\]\]/);
      // call again to verify idempotency
      await handleWriteWiki(vault, {
        path: 'concepts/child.md', title: 'Child', body: 'c2', mode: 'append',
        related: ['Parent'],
      });
      const parent2 = await readFile(join(vault, 'wiki', 'parent.md'), 'utf8');
      const occurrences = (parent2.match(/\[\[Child\]\]/g) ?? []).length;
      assert.equal(occurrences, 1);
    } finally { await cleanup(); }
  });

  test('MCP22 concurrent writes are serialized via lock', async () => {
    try {
      const t1 = handleWriteWiki(vault, { path: 'a.md', title: 'A', body: 'a' });
      const t2 = handleWriteWiki(vault, { path: 'b.md', title: 'B', body: 'b' });
      const [r1, r2] = await Promise.all([t1, t2]);
      assert.equal(r1.action, 'created');
      assert.equal(r2.action, 'created');
      const sa = await stat(join(vault, 'wiki', 'a.md'));
      const sb = await stat(join(vault, 'wiki', 'b.md'));
      assert.ok(sa.isFile());
      assert.ok(sb.isFile());
    } finally { await cleanup(); }
  });

  test('masks secrets in body', async () => {
    try {
      await handleWriteWiki(vault, {
        path: 'leak.md',
        title: 'Leak',
        body: 'token sk-ant-AAAAAAAAAAAAAAAAAAAAAAAA leaked',
      });
      const c = await readFile(join(vault, 'wiki', 'leak.md'), 'utf8');
      assert.match(c, /sk-ant-\*\*\*/);
    } finally { await cleanup(); }
  });

  test('MCP22b masks secrets in title and tags', async () => {
    try {
      await handleWriteWiki(vault, {
        path: 'leak2.md',
        title: 'Leak ghp_BBBBBBBBBBBBBBBBBBBBBBBB',
        body: 'safe body',
        tags: ['plain', 'sk-ant-CCCCCCCCCCCCCCCCCCCCCCCC'],
      });
      const c = await readFile(join(vault, 'wiki', 'leak2.md'), 'utf8');
      assert.doesNotMatch(c, /ghp_B/);
      assert.match(c, /ghp_\*\*\*/);
      assert.doesNotMatch(c, /sk-ant-C/);
      assert.match(c, /sk-ant-\*\*\*/);
    } finally { await cleanup(); }
  });
});
