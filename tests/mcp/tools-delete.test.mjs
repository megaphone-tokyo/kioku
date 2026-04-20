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

  test('MCP26b detects wikilink references from raw-sources/fetched/ (HIGH-a1)', async () => {
    // 2026-04-20 HIGH-a1 regression test: kioku_delete の broken-link scan は
    // wiki/ のみを走査していたため、`raw-sources/<subdir>/fetched/*.md` から
    // wiki ページへの wikilink が silent orphan 化する経路があった。
    // 本テストは fetched/ 配下の MD に [[Foo]] があれば検知されることを確認する。
    try {
      await writeFile(join(vault, 'wiki', 'foo.md'),
        '---\ntitle: Foo\n---\n\n# Foo\n');
      const fetchedDir = join(vault, 'raw-sources', 'articles', 'fetched');
      await mkdir(fetchedDir, { recursive: true });
      await writeFile(join(fetchedDir, 'evil.com-article.md'),
        '---\nsource_url: "https://evil.com/"\n---\n\n# evil article\n\nsee [[Foo]]\n');
      await assert.rejects(
        handleDelete(vault, { path: 'foo.md' }),
        (err) => {
          if (err.code !== 'broken_links_detected') return false;
          const links = err.data?.brokenLinks ?? [];
          const fetchedLink = links.find(
            (x) => x.sourcePath === 'raw-sources/articles/fetched/evil.com-article.md'
          );
          if (!fetchedLink) return false;
          assert.equal(fetchedLink.occurrences, 1);
          assert.equal(fetchedLink.inWiki, false, 'fetched/ は inWiki: false で区別される');
          return true;
        },
      );
    } finally { await cleanup(); }
  });

  test('MCP26c excludes .cache / session-logs / .git from scanReferences', async () => {
    // 2026-04-20: HIGH-a1 fix で scanReferences を vault ルートに広げたので、
    // 除外ディレクトリ (.cache / session-logs / .git / node_modules) が誤って
    // 走査対象に入らないことを確認する (attacker-controlled cache HTML が
    // broken-link スキャンに乗ると DoS / 誤動作の原因になる)。
    try {
      await writeFile(join(vault, 'wiki', 'foo.md'),
        '---\ntitle: Foo\n---\n\n# Foo\n');
      const cacheDir = join(vault, '.cache', 'html');
      await mkdir(cacheDir, { recursive: true });
      // .cache/html/ に [[Foo]] を含む HTML-like MD を置いても検知されないこと
      await writeFile(join(cacheDir, 'noise.md'), 'cache [[Foo]] noise\n');
      const logsDir = join(vault, 'session-logs');
      await mkdir(logsDir, { recursive: true });
      await writeFile(join(logsDir, '2026-04-20.md'), 'log [[Foo]]\n');
      // wiki/ 内の既存 index.md の [[Foo]] があるので broken_links_detected は発火する想定
      await assert.rejects(
        handleDelete(vault, { path: 'foo.md' }),
        (err) => {
          if (err.code !== 'broken_links_detected') return false;
          const links = err.data?.brokenLinks ?? [];
          // .cache / session-logs 由来の link は含まれていない
          const bogus = links.find(
            (x) => x.sourcePath.startsWith('.cache/') || x.sourcePath.startsWith('session-logs/')
          );
          return bogus === undefined;
        },
      );
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
