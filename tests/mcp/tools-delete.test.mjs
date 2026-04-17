// tools-delete.test.mjs — kioku_delete ハンドラのユニットテスト

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readdir, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_DIR = join(__dirname, '..', '..', 'mcp');

const { handleDelete } = await import(join(MCP_DIR, 'tools', 'delete.mjs'));

let workspace, vault;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'kioku-mcp-del-'));
  vault = join(workspace, 'vault');
  await mkdir(join(vault, 'wiki', 'concepts'), { recursive: true });
  await writeFile(join(vault, 'wiki', 'index.md'), '# Index\n\n- [[Foo]]\n');
});

async function cleanup() {
  if (workspace) await rm(workspace, { recursive: true, force: true });
}

describe('kioku_delete', () => {
  test('MCP23 archives a wiki page to wiki/.archive/', async () => {
    try {
      await writeFile(join(vault, 'wiki', 'concepts', 'orphan.md'),
        '---\ntitle: Orphan\n---\n\n# Orphan\n');
      const r = await handleDelete(vault, { path: 'concepts/orphan.md' });
      assert.match(r.archivedPath, /^wiki\/\.archive\/concepts\/orphan-/);
      assert.deepEqual(r.brokenLinks, []);
      // 元ファイルがない
      await assert.rejects(stat(join(vault, 'wiki', 'concepts', 'orphan.md')));
      // .archive 配下に移動済み
      const archiveEntries = await readdir(join(vault, 'wiki', '.archive', 'concepts'));
      assert.equal(archiveEntries.length, 1);
      assert.match(archiveEntries[0], /^orphan-\d{4}-\d{2}-\d{2}T/);
      // .archive ディレクトリ permission
      const archSt = await stat(join(vault, 'wiki', '.archive'));
      assert.equal(archSt.mode & 0o777, 0o700);
    } finally { await cleanup(); }
  });

  test('MCP24 rejects deleting wiki/index.md', async () => {
    try {
      await assert.rejects(
        handleDelete(vault, { path: 'index.md' }),
        (err) => err.code === 'cannot_delete_index',
      );
      // also "wiki/index.md" form
      await assert.rejects(
        handleDelete(vault, { path: 'wiki/index.md' }),
        (err) => err.code === 'cannot_delete_index' || err.code === 'path_traversal' || err.code === 'invalid_path',
      );
    } finally { await cleanup(); }
  });

  test('MCP25 detects wikilink references and rejects when force=false', async () => {
    try {
      await writeFile(join(vault, 'wiki', 'foo.md'),
        '---\ntitle: Foo\n---\n\n# Foo\n');
      await writeFile(join(vault, 'wiki', 'bar.md'),
        'see [[Foo]] and [[Foo]] again\n');
      await assert.rejects(
        handleDelete(vault, { path: 'foo.md' }),
        (err) => {
          if (err.code !== 'broken_links_detected') return false;
          const links = err.data?.brokenLinks ?? [];
          return links.some((x) => x.sourcePath === 'wiki/bar.md' && x.occurrences === 2);
        },
      );
      // index.md は - [[Foo]] を持つので参照されているが、force=false なのでまだ archived にならない
      await assert.ok((await readdir(join(vault, 'wiki'))).includes('foo.md'));
    } finally { await cleanup(); }
  });

  test('MCP26 archives even with references when force=true', async () => {
    try {
      await writeFile(join(vault, 'wiki', 'foo.md'),
        '---\ntitle: Foo\n---\n\n# Foo\n');
      await writeFile(join(vault, 'wiki', 'bar.md'),
        'see [[Foo]]\n');
      // beforeEach の index.md にも [[Foo]] があるので、broken links は
      // bar.md と index.md の 2 ソース
      const r = await handleDelete(vault, { path: 'foo.md', force: true });
      assert.match(r.archivedPath, /^wiki\/\.archive\/foo-/);
      assert.equal(r.brokenLinks.length, 2);
      const sources = r.brokenLinks.map((x) => x.sourcePath).sort();
      assert.deepEqual(sources, ['wiki/bar.md', 'wiki/index.md']);
    } finally { await cleanup(); }
  });

  test('rejects non-existent file', async () => {
    try {
      await assert.rejects(
        handleDelete(vault, { path: 'no-such.md' }),
        (err) => err.code === 'file_not_found',
      );
    } finally { await cleanup(); }
  });

  test('rejects path traversal', async () => {
    try {
      await assert.rejects(
        handleDelete(vault, { path: '../session-logs/x.md' }),
        (err) => err.code === 'path_traversal' || err.code === 'invalid_path' || err.code === 'invalid_params',
      );
    } finally { await cleanup(); }
  });
});
