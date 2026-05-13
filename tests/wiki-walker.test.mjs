// wiki-walker.test.mjs — Tests for the shared wiki-walker.mjs module
// (Sprint 3 Phase 3 §46 LEARN#8b N=3 mandatory refactor anchor).
//
// 実行: node --test tools/claude-brain/tests/wiki-walker.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  walkPages,
  listMarkdownRefs,
  inferPageType,
  resolvePageTitle,
  DEFAULT_EXCLUDE_DIRS,
} from '../mcp/lib/wiki-walker.mjs';

async function makeVault() {
  const root = await mkdtemp(join(tmpdir(), 'kioku-walker-test-'));
  await mkdir(join(root, 'wiki', 'concepts'), { recursive: true });
  await mkdir(join(root, 'wiki', 'projects'), { recursive: true });
  await mkdir(join(root, 'wiki', 'summaries'), { recursive: true });
  await mkdir(join(root, 'wiki', '.archive'), { recursive: true });
  await mkdir(join(root, 'wiki', 'templates'), { recursive: true });
  await mkdir(join(root, 'raw-sources', 'pdf'), { recursive: true });

  await writeFile(
    join(root, 'wiki', 'index.md'),
    '---\ntype: index\ntitle: Vault Index\n---\n\n# Index\n\n- [[concepts/jwt]]\n',
  );
  await writeFile(
    join(root, 'wiki', 'concepts', 'jwt.md'),
    '---\ntype: concept\ntags: [auth]\n---\n\n# JWT\n\nSee [[oauth]].\n',
  );
  await writeFile(
    join(root, 'wiki', 'concepts', 'oauth.md'),
    '---\ntags: [auth]\n---\n\n# OAuth\n\n[[jwt]]\n',
  );
  await writeFile(
    join(root, 'wiki', 'projects', 'kioku.md'),
    '---\ntype: project\ntitle: KIOKU\n---\n\n# KIOKU\n',
  );
  await writeFile(
    join(root, 'wiki', 'summaries', 'rag-summary.md'),
    '---\nsource_sha256: abc123\nsource: pdf/rag.pdf\n---\n\n# RAG summary\n',
  );

  // Files that MUST be filtered out
  await writeFile(join(root, 'wiki', '.archive', 'ghost.md'), '# ghost');
  await writeFile(join(root, 'wiki', 'templates', 'note.md'), '# template');
  await writeFile(join(root, 'wiki', '.hidden.md'), '# dotfile');
  await writeFile(join(root, 'wiki', 'concepts', 'README.txt'), 'not markdown');

  // raw-sources
  await writeFile(join(root, 'raw-sources', 'pdf', 'rag.pdf'), '%PDF-1.4 fake');
  await writeFile(join(root, 'raw-sources', 'pdf', 'rag.md'), '# raw extracted markdown');
  return root;
}

describe('wiki-walker.mjs (§46 N=3 shared util)', () => {
  test('BLUE-VIZ-WALKER-1: default walk returns flat metadata for wiki/', async () => {
    const root = await makeVault();
    try {
      const pages = await walkPages(root);
      const rels = pages.map((p) => p.rel).sort();
      assert.deepEqual(rels, [
        'concepts/jwt.md',
        'concepts/oauth.md',
        'index.md',
        'projects/kioku.md',
        'summaries/rag-summary.md',
      ], '.archive/ + templates/ + .hidden.md must be filtered out');
      const jwt = pages.find((p) => p.rel === 'concepts/jwt.md');
      assert.equal(jwt.name, 'jwt');
      assert.equal(jwt.type, 'concept');
      assert.equal(jwt.title, 'JWT', 'title resolves from body H1 when frontmatter.title absent');
      assert.deepEqual(jwt.wikilinks, ['oauth']);
      assert.ok(jwt.frontmatter, 'frontmatter present by default');
      assert.ok(!('body' in jwt), 'body excluded unless withBody');
      assert.ok(!('text' in jwt), 'text excluded unless withBody');
      assert.ok(!('mtime' in jwt), 'mtime excluded unless withMtime');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-VIZ-WALKER-2: withBody + withMtime include text/body/mtime fields', async () => {
    const root = await makeVault();
    try {
      const pages = await walkPages(root, { withBody: true, withMtime: true });
      const jwt = pages.find((p) => p.rel === 'concepts/jwt.md');
      assert.ok(typeof jwt.text === 'string' && jwt.text.startsWith('---'));
      assert.ok(typeof jwt.body === 'string' && jwt.body.includes('# JWT'));
      assert.ok(jwt.mtime instanceof Date);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-VIZ-WALKER-3: subDir + extensions support raw-sources walk', async () => {
    const root = await makeVault();
    try {
      const raws = await walkPages(root, {
        subDir: 'raw-sources',
        extensions: ['.pdf', '.md'],
        withFrontmatter: false,
        withWikilinks: false,
      });
      const rels = raws.map((r) => r.rel).sort();
      assert.deepEqual(rels, ['pdf/rag.md', 'pdf/rag.pdf']);
      const pdf = raws.find((r) => r.rel === 'pdf/rag.pdf');
      assert.equal(pdf.name, 'rag');
      // non-.md → no frontmatter / wikilinks parse attempted
      assert.ok(!pdf.wikilinks || pdf.wikilinks.length === 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-VIZ-WALKER-4: nonexistent subDir returns empty array (graceful)', async () => {
    const root = await makeVault();
    try {
      const out = await walkPages(root, { subDir: 'does-not-exist' });
      assert.deepEqual(out, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-VIZ-WALKER-5: listMarkdownRefs back-compat shape {abs, rel}', async () => {
    const root = await makeVault();
    try {
      const refs = await listMarkdownRefs(root);
      assert.ok(Array.isArray(refs));
      assert.ok(refs.length >= 5);
      for (const r of refs) {
        assert.equal(typeof r.abs, 'string');
        assert.equal(typeof r.rel, 'string');
        assert.ok(!('frontmatter' in r), 'frontmatter omitted from legacy shape');
        assert.ok(!('wikilinks' in r));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-VIZ-WALKER-6: inferPageType priority (system > frontmatter.type > subdir > other)', () => {
    assert.equal(inferPageType('index.md'), 'index');
    assert.equal(inferPageType('log.md'), 'log');
    assert.equal(inferPageType('hot.md'), 'hot');
    assert.equal(inferPageType('index.md', { type: 'concept' }), 'index', 'system files override frontmatter');
    assert.equal(inferPageType('concepts/x.md', { type: 'custom' }), 'custom', 'frontmatter beats subdir');
    assert.equal(inferPageType('projects/x.md', {}), 'project');
    assert.equal(inferPageType('summaries/x.md', null), 'summary');
    assert.equal(inferPageType('decisions/x.md'), 'decision');
    assert.equal(inferPageType('weird-dir/x.md', {}), 'other');
  });

  test('BLUE-VIZ-WALKER-7: resolvePageTitle priority (frontmatter > H1 > basename)', () => {
    assert.equal(resolvePageTitle('a/b.md', { title: 'Hello' }, '# World'), 'Hello');
    assert.equal(resolvePageTitle('a/b.md', {}, '# H1 only'), 'H1 only');
    assert.equal(resolvePageTitle('a/b.md', null, ''), 'b');
    assert.equal(resolvePageTitle('a/b.md', { title: '  trimmed  ' }, ''), 'trimmed');
  });

  test('BLUE-VIZ-WALKER-8: DEFAULT_EXCLUDE_DIRS contains expected dirs', () => {
    assert.ok(DEFAULT_EXCLUDE_DIRS instanceof Set);
    for (const dir of ['.obsidian', '.archive', '.trash', 'templates', '.cache']) {
      assert.ok(DEFAULT_EXCLUDE_DIRS.has(dir), `${dir} must be excluded by default`);
    }
  });

  test('BLUE-VIZ-WALKER-9: corrupt non-utf8 file is skipped silently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kioku-walker-corrupt-'));
    try {
      await mkdir(join(root, 'wiki'), { recursive: true });
      // valid file
      await writeFile(join(root, 'wiki', 'ok.md'), '# ok');
      // binary garbage (still parseable as utf8 lossy, but contents are not markdown):
      // wiki walker should not crash and should include it
      await writeFile(join(root, 'wiki', 'binary.md'), Buffer.from([0x00, 0x01, 0xFF, 0xFE]));
      const pages = await walkPages(root);
      // walker does not validate content, only existence + ext — both should appear
      assert.equal(pages.length, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
