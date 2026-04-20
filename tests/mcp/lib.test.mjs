// lib.test.mjs — mcp/lib/* の単体テスト
//
// 実行: node --test tools/claude-brain/tests/mcp/

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_DIR = join(__dirname, '..', '..', 'mcp');

const { assertInsideWiki, assertInsideSessionLogs, assertInsideRawSourcesSubdir, PathBoundaryError } =
  await import(join(MCP_DIR, 'lib', 'vault-path.mjs'));
const { parseFrontmatter, serializeFrontmatter, mergeFrontmatter } =
  await import(join(MCP_DIR, 'lib', 'frontmatter.mjs'));
const { findWikilinks, hasWikilink, appendRelatedLink } =
  await import(join(MCP_DIR, 'lib', 'wikilinks.mjs'));
const { withLock, LockTimeoutError } =
  await import(join(MCP_DIR, 'lib', 'lock.mjs'));
const { applyMasks, MASK_RULES } =
  await import(join(MCP_DIR, 'lib', 'masking.mjs'));
const { loadTemplate, VALID_TEMPLATES } =
  await import(join(MCP_DIR, 'lib', 'templates.mjs'));

async function makeVault() {
  const root = await mkdtemp(join(tmpdir(), 'kioku-mcp-lib-'));
  const vault = join(root, 'vault');
  await mkdir(join(vault, 'wiki'), { recursive: true });
  await mkdir(join(vault, 'wiki', '.archive'), { recursive: true });
  await mkdir(join(vault, 'session-logs'), { recursive: true });
  return { root, vault };
}

describe('vault-path', () => {
  let vault, root;
  before(async () => {
    const v = await makeVault();
    vault = v.vault;
    root = v.root;
    await writeFile(join(vault, 'wiki', 'index.md'), '# Index\n');
    await writeFile(join(vault, 'session-logs', 'sl.md'), 'log\n');
  });
  after(() => rm(root, { recursive: true, force: true }));

  test('LIB1 assertInsideWiki accepts existing file', async () => {
    const resolved = await assertInsideWiki(vault, 'index.md');
    assert.match(resolved, /\/wiki\/index\.md$/);
  });

  test('LIB2 assertInsideWiki accepts non-existent file (for write)', async () => {
    const resolved = await assertInsideWiki(vault, 'subdir/new.md');
    assert.match(resolved, /\/wiki\/subdir\/new\.md$/);
  });

  test('LIB3 assertInsideWiki rejects ../ traversal', async () => {
    await assert.rejects(
      assertInsideWiki(vault, '../session-logs/sl.md'),
      (err) => err instanceof PathBoundaryError && err.code === 'path_traversal',
    );
  });

  test('LIB4 assertInsideWiki rejects absolute path', async () => {
    await assert.rejects(
      assertInsideWiki(vault, '/etc/passwd'),
      (err) => err instanceof PathBoundaryError && err.code === 'absolute_path',
    );
  });

  test('LIB5 assertInsideWiki rejects null byte', async () => {
    await assert.rejects(
      assertInsideWiki(vault, 'a\0b.md'),
      (err) => err instanceof PathBoundaryError,
    );
  });

  test('LIB6 assertInsideWiki rejects symlink that escapes wiki/', async () => {
    const target = join(vault, 'session-logs', 'sl.md');
    const linkPath = join(vault, 'wiki', 'evil.md');
    await symlink(target, linkPath);
    await assert.rejects(
      assertInsideWiki(vault, 'evil.md'),
      (err) => err instanceof PathBoundaryError && err.code === 'path_outside_boundary',
    );
  });

  test('LIB7 assertInsideSessionLogs accepts session log path', async () => {
    const resolved = await assertInsideSessionLogs(vault, 'sl.md');
    assert.match(resolved, /\/session-logs\/sl\.md$/);
  });

  test('LIB7a assertInsideWiki accepts Japanese filename (hiragana + katakana + kanji)', async () => {
    const resolved = await assertInsideWiki(vault, 'メモ-日本語タイトル.md');
    assert.match(resolved, /メモ-日本語タイトル\.md$/);
  });

  test('LIB7b assertInsideWiki accepts mixed ASCII + Japanese path', async () => {
    const resolved = await assertInsideWiki(vault, 'concepts/プロジェクト-2026.md');
    assert.match(resolved, /\/wiki\/concepts\/プロジェクト-2026\.md$/);
  });

  test('LIB7c assertInsideSessionLogs accepts Japanese filename', async () => {
    const resolved = await assertInsideSessionLogs(vault, '20260417-143726-mcp-メモ.md');
    assert.match(resolved, /\/session-logs\/20260417-143726-mcp-メモ\.md$/);
  });

  test('LIB7d assertInsideWiki accepts Chinese characters', async () => {
    const resolved = await assertInsideWiki(vault, '中文笔记.md');
    assert.match(resolved, /中文笔记\.md$/);
  });

  test('LIB7e assertInsideWiki accepts Korean hangul', async () => {
    const resolved = await assertInsideWiki(vault, '한국어메모.md');
    assert.match(resolved, /한국어메모\.md$/);
  });

  test('LIB7f assertInsideWiki still rejects shell metacharacters even with Unicode enabled', async () => {
    // Shell metachars ($ ` ; | & < > etc) must still be rejected by SAFE_PATH_RE
    await assert.rejects(
      assertInsideWiki(vault, 'evil;rm-rf.md'),
      (err) => err instanceof PathBoundaryError && err.code === 'invalid_path',
    );
    await assert.rejects(
      assertInsideWiki(vault, 'evil`cmd`.md'),
      (err) => err instanceof PathBoundaryError && err.code === 'invalid_path',
    );
  });

  test('LIB7g assertInsideWiki still rejects traversal even with Japanese chars', async () => {
    await assert.rejects(
      assertInsideWiki(vault, '../session-logs/メモ.md'),
      (err) => err instanceof PathBoundaryError && err.code === 'path_traversal',
    );
  });
});

describe('frontmatter', () => {
  test('LIB10 parses simple frontmatter', () => {
    const src = `---
title: Hello World
tags: [a, b, c]
created: 2026-04-17
ingested: false
count: 3
---

body text
`;
    const { data, body } = parseFrontmatter(src);
    assert.equal(data.title, 'Hello World');
    assert.deepEqual(data.tags, ['a', 'b', 'c']);
    assert.equal(data.ingested, false);
    assert.equal(data.count, 3);
    assert.equal(body.trim(), 'body text');
  });

  test('LIB11 returns body unchanged when no frontmatter', () => {
    const { data, body } = parseFrontmatter('# no fm\n');
    assert.deepEqual(data, {});
    assert.equal(body, '# no fm\n');
  });

  test('LIB12 serialize round-trip preserves keys', () => {
    const data = { title: 'T', tags: ['x', 'y'], n: 1 };
    const out = serializeFrontmatter(data, '\nbody\n');
    const parsed = parseFrontmatter(out);
    assert.equal(parsed.data.title, 'T');
    assert.deepEqual(parsed.data.tags, ['x', 'y']);
    assert.equal(parsed.data.n, 1);
  });

  test('LIB12b double-quoted JSON escapes round-trip (Unicode preserved)', () => {
    // Regression for code-quality HIGH-1 (2026-04-19): stripQuotes previously did
    // `s.slice(1, -1)` on double-quoted values, returning the literal escape
    // sequence instead of the decoded character. Now uses JSON.parse.
    const raw = '---\ntitle: "café"\nkey: "caf\\u00e9"\nnl: "line1\\nline2"\n---\n\nbody\n';
    const { data } = parseFrontmatter(raw);
    assert.equal(data.title, 'café');
    assert.equal(data.key, 'café');
    assert.equal(data.nl, 'line1\nline2');
  });

  test('LIB12c single-quoted handles doubled apostrophe escape', () => {
    const raw = "---\nq: 'it''s fine'\n---\n\nbody\n";
    const { data } = parseFrontmatter(raw);
    assert.equal(data.q, "it's fine");
  });

  test('LIB13 mergeFrontmatter unions array values', () => {
    const merged = mergeFrontmatter(
      { tags: ['a', 'b'], title: 'old' },
      { tags: ['b', 'c'], updated: '2026-04-17' },
    );
    assert.deepEqual(merged.tags, ['a', 'b', 'c']);
    assert.equal(merged.title, 'old');
    assert.equal(merged.updated, '2026-04-17');
  });
});

describe('wikilinks', () => {
  test('LIB20 findWikilinks extracts unique targets, normalizes alias/section', () => {
    const c = 'see [[Page A]] and [[Page A|alias]] and [[Page B#sec]] and [[Page A]] again';
    assert.deepEqual(findWikilinks(c).sort(), ['Page A', 'Page B'].sort());
  });

  test('LIB21 hasWikilink true/false', () => {
    assert.equal(hasWikilink('foo [[X]] bar', 'X'), true);
    assert.equal(hasWikilink('foo bar', 'X'), false);
  });

  test('LIB22 appendRelatedLink creates section when missing', () => {
    const out = appendRelatedLink('# H1\n\ntext\n', 'New Page');
    assert.match(out, /## 関連ページ\n\n- \[\[New Page\]\]\n$/);
  });

  test('LIB23 appendRelatedLink appends to existing section', () => {
    const src = '# H1\n\n## 関連ページ\n\n- [[Existing]]\n';
    const out = appendRelatedLink(src, 'New Page');
    assert.match(out, /- \[\[Existing\]\]\n- \[\[New Page\]\]\n/);
  });

  test('LIB24 appendRelatedLink is idempotent', () => {
    const src = '# H1\n\n## 関連ページ\n\n- [[X]]\n';
    const once = appendRelatedLink(src, 'X');
    const twice = appendRelatedLink(once, 'X');
    assert.equal(once, src);
    assert.equal(twice, src);
  });
});

describe('lock', () => {
  let vault, root;
  before(async () => {
    const v = await makeVault();
    vault = v.vault;
    root = v.root;
  });
  after(() => rm(root, { recursive: true, force: true }));

  test('LIB30 withLock serializes concurrent fns', async () => {
    const order = [];
    const t1 = withLock(vault, async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 50));
      order.push('a-end');
      return 'a';
    });
    // Slight delay so t1 acquires first
    await new Promise((r) => setTimeout(r, 10));
    const t2 = withLock(vault, async () => {
      order.push('b-start');
      order.push('b-end');
      return 'b';
    });
    const [r1, r2] = await Promise.all([t1, t2]);
    assert.equal(r1, 'a');
    assert.equal(r2, 'b');
    assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
  });

  test('LIB31 withLock removes lockfile after completion', async () => {
    await withLock(vault, async () => {});
    await assert.rejects(stat(join(vault, '.kioku-mcp.lock')));
  });

  test('LIB32 withLock removes lockfile even on throw', async () => {
    await assert.rejects(
      withLock(vault, async () => { throw new Error('boom'); }),
      /boom/,
    );
    await assert.rejects(stat(join(vault, '.kioku-mcp.lock')));
  });
});

describe('masking', () => {
  test('LIB40 masks sk-ant token', () => {
    const out = applyMasks('use sk-ant-AAAAAAAAAAAAAAAAAAAAA in body');
    assert.match(out, /sk-ant-\*\*\*/);
    assert.doesNotMatch(out, /sk-ant-A/);
  });

  test('LIB41 masks Bearer header', () => {
    const out = applyMasks('Authorization: Bearer abcdef.ghijkl_-mn');
    assert.match(out, /Bearer \*\*\*/);
  });

  test('LIB42 leaves non-secret content unchanged', () => {
    assert.equal(applyMasks('hello world\nno secrets'), 'hello world\nno secrets');
  });

  test('LIB43 MASK_RULES is non-empty array of [RegExp, string]', () => {
    assert.ok(MASK_RULES.length > 10);
    for (const rule of MASK_RULES) {
      assert.ok(rule[0] instanceof RegExp);
      assert.equal(typeof rule[1], 'string');
    }
  });
});

describe('assertInsideRawSourcesSubdir', () => {
  let vault, root;
  before(async () => {
    const v = await makeVault();
    vault = v.vault;
    root = v.root;
    await mkdir(join(vault, 'raw-sources', 'articles', 'fetched'), { recursive: true });
  });
  after(() => rm(root, { recursive: true, force: true }));

  test('LIB53 accepts articles/fetched path (does not need to exist yet)', async () => {
    const abs = await assertInsideRawSourcesSubdir(vault, 'articles', 'fetched/foo.md');
    assert.match(abs, /raw-sources\/articles\/fetched\/foo\.md$/);
  });

  test('LIB54 rejects traversal out of subdir', async () => {
    await assert.rejects(
      () => assertInsideRawSourcesSubdir(vault, 'articles', '../other/foo.md'),
      (e) => e instanceof PathBoundaryError && e.code === 'path_traversal',
    );
  });

  test('LIB55 rejects subdir containing path separator', async () => {
    await assert.rejects(
      () => assertInsideRawSourcesSubdir(vault, 'articles/fetched', 'foo.md'),
      (e) => e instanceof PathBoundaryError && e.code === 'invalid_path',
    );
  });

  test('LIB56 rejects subdir starting with dot', async () => {
    await assert.rejects(
      () => assertInsideRawSourcesSubdir(vault, '.hidden', 'foo.md'),
      (e) => e instanceof PathBoundaryError && e.code === 'invalid_path',
    );
  });
});

describe('templates', () => {
  test('LIB50 loads built-in concept template', async () => {
    const t = await loadTemplate('concept');
    assert.deepEqual(t.data.tags, ['concept']);
    assert.match(t.body, /## 概要/);
  });

  test('LIB51 rejects unknown template', async () => {
    await assert.rejects(loadTemplate('unknown'), /unknown template/);
  });

  test('LIB52 honors KIOKU_TEMPLATES_DIR override', async () => {
    const overrideDir = await mkdtemp(join(tmpdir(), 'tpl-'));
    await writeFile(
      join(overrideDir, 'concept.md'),
      '---\ntitle:\ntags: [override]\n---\n\n## Custom\n',
    );
    const prev = process.env.KIOKU_TEMPLATES_DIR;
    process.env.KIOKU_TEMPLATES_DIR = overrideDir;
    try {
      const t = await loadTemplate('concept');
      assert.deepEqual(t.data.tags, ['override']);
      assert.match(t.body, /## Custom/);
    } finally {
      if (prev === undefined) delete process.env.KIOKU_TEMPLATES_DIR;
      else process.env.KIOKU_TEMPLATES_DIR = prev;
      await rm(overrideDir, { recursive: true, force: true });
    }
  });
});
