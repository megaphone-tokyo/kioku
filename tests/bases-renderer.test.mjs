// bases-renderer.test.mjs — Tests for mcp/lib/bases-renderer.mjs
//
// Sprint 4 Phase 1 PR A (plan/claude/26051301_v0-9-phase1-impl-plan.md §「PR A」).
//
// Test cases (10 BLUE-BASES-RENDERER-*):
//   BLUE-BASES-RENDERER-1            (Task A-1 / A-3): filters.and 6 P0 operators
//                                                       (folder / ext / name / negation
//                                                       / equality / numeric)
//   BLUE-BASES-RENDERER-2a           (Task A-2)      : parseYamlLike nested lists + strings
//   BLUE-BASES-RENDERER-2            (Task A-4)      : formulas.age_days computed from mtime
//   BLUE-BASES-RENDERER-3            (Task A-5)      : properties.displayName preserved
//   BLUE-BASES-RENDERER-4            (Task A-6)      : views table + list types preserved
//   BLUE-BASES-RENDERER-5            (Task A-6)      : limit truncates pages
//   BLUE-BASES-RENDERER-6            (Task A-6)      : order by file.name ascending
//   BLUE-BASES-RENDERER-7            (Task A-6)      : groupBy property type ASC
//   BLUE-BASES-RENDERER-warning      (Task A-7)      : unknown expression surfaces warning
//                                                       + page excluded from view
//   BLUE-BASES-RENDERER-INTEGRATION  (Task A-8)      : templates/wiki/meta/dashboard.base
//                                                       (10 views) renders without warnings

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseBaseFile,
  renderBases,
  BasesParseError,
  _internals,
} from '../mcp/lib/bases-renderer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const STATIC_FIXTURE_VAULT = resolve(__dirname, 'fixtures/visualizer-small-vault');
const DASHBOARD_BASE_PATH = resolve(
  REPO_ROOT,
  'tools/claude-brain/templates/wiki/meta/dashboard.base',
);

// ---------------------------------------------------------------------------
// Temp vault helper — gives each test isolated control over file content + mtime.
// ---------------------------------------------------------------------------

async function makeTempVault({ withStale = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kioku-bases-test-'));
  await mkdir(join(root, 'wiki', 'concepts'), { recursive: true });
  await mkdir(join(root, 'wiki', 'projects'), { recursive: true });
  await mkdir(join(root, 'wiki', 'summaries'), { recursive: true });
  await mkdir(join(root, 'wiki', 'meta'), { recursive: true });

  // Fresh files (mtime ≈ now).
  await writeFile(
    join(root, 'wiki', 'hot.md'),
    '---\ntype: hot\nupdated: 2026-05-13\n---\n\n# Hot cache\n',
  );
  await writeFile(
    join(root, 'wiki', 'index.md'),
    '---\ntype: index\ntitle: Index\n---\n\n# Index\n',
  );
  await writeFile(
    join(root, 'wiki', 'projects', 'kioku.md'),
    '---\ntype: project\nstatus: active\nupdated: 2026-05-12\n---\n\n# KIOKU\n',
  );
  await writeFile(
    join(root, 'wiki', 'concepts', 'jwt.md'),
    '---\ntype: concept\nupdated: 2026-05-12\n---\n\n# JWT\n',
  );
  await writeFile(
    join(root, 'wiki', 'concepts', 'oauth.md'),
    '---\ntype: concept\nupdated: 2026-05-12\n---\n\n# OAuth\n',
  );
  // summary — used to test '!file.inFolder("wiki/summaries")' negation.
  await writeFile(
    join(root, 'wiki', 'summaries', 'rag.md'),
    '---\ntype: summary\nupdated: 2026-05-12\n---\n\n# RAG\n',
  );

  if (withStale) {
    await writeFile(
      join(root, 'wiki', 'concepts', 'legacy.md'),
      '---\ntype: concept\nstatus: archived\nupdated: 2024-01-01\n---\n\n# Legacy\n',
    );
    // Force mtime to 60 days before "now" for the stale test.
    const oldDate = new Date('2026-03-13T00:00:00Z');
    await utimes(join(root, 'wiki', 'concepts', 'legacy.md'), oldDate, oldDate);
  }
  return root;
}

async function cleanup(root) {
  if (root) await rm(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// BLUE-BASES-RENDERER-2a (Task A-2): parseYamlLike nested lists + strings
// ---------------------------------------------------------------------------

test('BLUE-BASES-RENDERER-2a: parseYamlLike handles nested lists + strings', () => {
  const text = `
filters:
  and:
    - file.inFolder("wiki")
    - 'file.ext == "md"'
views:
  - type: table
    name: "Hot"
    limit: 5
`;
  const { ast, warnings } = parseBaseFile(text);
  assert.equal(warnings.length, 0);
  assert.equal(ast.filters.and.length, 2);
  assert.equal(ast.filters.and[0], 'file.inFolder("wiki")');
  assert.equal(ast.filters.and[1], 'file.ext == "md"');
  assert.equal(ast.views.length, 1);
  assert.equal(ast.views[0].type, 'table');
  assert.equal(ast.views[0].name, 'Hot');
  assert.equal(ast.views[0].limit, 5);
});

// ---------------------------------------------------------------------------
// BLUE-BASES-RENDERER-1 (Task A-3): 6 P0 filter operators
// ---------------------------------------------------------------------------

test('BLUE-BASES-RENDERER-1: 6 filter operators (folder/ext/name/negation/equality/numeric)', async () => {
  const vault = await makeTempVault({ withStale: true });
  try {
    const baseText = `
filters:
  and:
    - file.inFolder("wiki")
    - 'file.ext == "md"'
    - '!file.inFolder("wiki/summaries")'
formulas:
  age_days: '(now() - file.mtime).days'
views:
  - type: list
    name: "hot only"
    filters:
      and:
        - 'file.name == "hot"'
  - type: list
    name: "active projects"
    filters:
      and:
        - 'status == "active"'
  - type: list
    name: "stale"
    filters:
      and:
        - 'formula.age_days > 30'
`;
    const { ast, warnings } = parseBaseFile(baseText);
    assert.equal(warnings.length, 0);
    assert.equal(ast.filters.and.length, 3);

    const { views, warnings: rwarn } = await renderBases(vault, ast, {
      now: new Date('2026-05-13T00:00:00Z'),
    });
    assert.equal(rwarn.length, 0, `unexpected render warnings: ${rwarn.join('; ')}`);
    assert.equal(views.length, 3);

    // Negation: no summaries/* pages should appear under the global filter.
    for (const v of views) {
      for (const p of v.pages) {
        assert.ok(!p.rel.startsWith('summaries/'), `expected to exclude ${p.rel}`);
        assert.ok(p.rel.endsWith('.md'));
      }
    }

    // file.name == "hot"
    const hotView = views.find((v) => v.name === 'hot only');
    assert.equal(hotView.pages.length, 1);
    assert.equal(hotView.pages[0].name, 'hot');

    // status == "active"
    const activeView = views.find((v) => v.name === 'active projects');
    assert.equal(activeView.pages.length, 1);
    assert.equal(activeView.pages[0].frontmatter.status, 'active');

    // formula.age_days > 30 → legacy.md only (mtime 60 days back).
    const staleView = views.find((v) => v.name === 'stale');
    assert.equal(staleView.pages.length, 1);
    assert.equal(staleView.pages[0].name, 'legacy');
    assert.ok(staleView.pages[0].computed.age_days > 30);
  } finally {
    await cleanup(vault);
  }
});

// ---------------------------------------------------------------------------
// BLUE-BASES-RENDERER-2 (Task A-4): formulas.age_days computed from mtime
// ---------------------------------------------------------------------------

test('BLUE-BASES-RENDERER-2: formulas.age_days computed from mtime', async () => {
  const vault = await makeTempVault();
  try {
    const baseText = `
formulas:
  age_days: '(now() - file.mtime).days'
views:
  - type: list
    name: "all"
`;
    const { ast } = parseBaseFile(baseText);
    const fixedNow = new Date('2026-05-13T12:00:00Z');
    // utimes all wiki/*.md to a known past mtime so age_days is deterministic
    // regardless of when the test runs. Without this, fixedNow could be in the
    // past relative to file creation time, producing negative age_days.
    const pastMtime = new Date('2026-05-10T00:00:00Z');
    for (const rel of [
      'wiki/hot.md',
      'wiki/index.md',
      'wiki/projects/kioku.md',
      'wiki/concepts/jwt.md',
      'wiki/concepts/oauth.md',
      'wiki/summaries/rag.md',
    ]) {
      await utimes(join(vault, rel), pastMtime, pastMtime);
    }
    const { views, warnings } = await renderBases(vault, ast, { now: fixedNow });
    assert.equal(warnings.length, 0);
    assert.equal(views.length, 1);
    for (const p of views[0].pages) {
      assert.equal(typeof p.computed.age_days, 'number');
      assert.ok(p.computed.age_days >= 0);
    }
  } finally {
    await cleanup(vault);
  }
});

// ---------------------------------------------------------------------------
// BLUE-BASES-RENDERER-3 (Task A-5): properties.displayName preserved
// ---------------------------------------------------------------------------

test('BLUE-BASES-RENDERER-3: properties.displayName preserved in ast', () => {
  const baseText = `
properties:
  type:
    displayName: "Type"
  status:
    displayName: "Status"
  formula.age_days:
    displayName: "Days Since Edit"
views:
  - type: table
    name: "all"
`;
  const { ast, warnings } = parseBaseFile(baseText);
  assert.equal(warnings.length, 0);
  assert.equal(ast.properties.type.displayName, 'Type');
  assert.equal(ast.properties.status.displayName, 'Status');
  assert.equal(ast.properties['formula.age_days'].displayName, 'Days Since Edit');
});

// ---------------------------------------------------------------------------
// BLUE-BASES-RENDERER-4 (Task A-6): views table + list types preserved
// ---------------------------------------------------------------------------

test('BLUE-BASES-RENDERER-4: views table + list types preserved', async () => {
  const vault = await makeTempVault();
  try {
    const baseText = `
views:
  - type: table
    name: "T1"
  - type: list
    name: "L1"
`;
    const { ast } = parseBaseFile(baseText);
    const { views } = await renderBases(vault, ast);
    assert.equal(views.length, 2);
    assert.equal(views[0].type, 'table');
    assert.equal(views[0].name, 'T1');
    assert.equal(views[1].type, 'list');
    assert.equal(views[1].name, 'L1');
  } finally {
    await cleanup(vault);
  }
});

// ---------------------------------------------------------------------------
// BLUE-BASES-RENDERER-5 (Task A-6): limit truncates pages
// ---------------------------------------------------------------------------

test('BLUE-BASES-RENDERER-5: limit truncates pages', async () => {
  const vault = await makeTempVault();
  try {
    const baseText = `
views:
  - type: list
    name: "limited"
    limit: 2
`;
    const { ast } = parseBaseFile(baseText);
    const { views } = await renderBases(vault, ast);
    assert.ok(views[0].pages.length <= 2);
    assert.equal(views[0].pages.length, 2);
  } finally {
    await cleanup(vault);
  }
});

// ---------------------------------------------------------------------------
// BLUE-BASES-RENDERER-6 (Task A-6): order by file.name ascending
// ---------------------------------------------------------------------------

test('BLUE-BASES-RENDERER-6: order by file.name ascending', async () => {
  const vault = await makeTempVault();
  try {
    const baseText = `
views:
  - type: list
    name: "ordered"
    order:
      - file.name
`;
    const { ast } = parseBaseFile(baseText);
    const { views } = await renderBases(vault, ast);
    const names = views[0].pages.map((p) => p.name);
    const sorted = [...names].sort();
    assert.deepEqual(names, sorted);
  } finally {
    await cleanup(vault);
  }
});

// ---------------------------------------------------------------------------
// BLUE-BASES-RENDERER-7 (Task A-6): groupBy property type ASC
// ---------------------------------------------------------------------------

test('BLUE-BASES-RENDERER-7: groupBy property type ASC', async () => {
  const vault = await makeTempVault();
  try {
    const baseText = `
views:
  - type: table
    name: "grouped"
    groupBy:
      property: type
      direction: ASC
`;
    const { ast } = parseBaseFile(baseText);
    const { views } = await renderBases(vault, ast);
    assert.ok(Array.isArray(views[0].groups));
    assert.ok(views[0].groups.length > 0);
    const keys = views[0].groups.map((g) => g.key);
    const sortedKeys = [...keys].sort();
    assert.deepEqual(keys, sortedKeys);
    // Sanity: hot, index, project, concept, summary all present in temp vault.
    assert.ok(keys.includes('hot'));
    assert.ok(keys.includes('project'));
  } finally {
    await cleanup(vault);
  }
});

// ---------------------------------------------------------------------------
// BLUE-BASES-RENDERER-warning (Task A-7): unknown expression → warning + exclude
// ---------------------------------------------------------------------------

test('BLUE-BASES-RENDERER-warning: unknown expression surfaces warning + page excluded', async () => {
  const vault = await makeTempVault();
  try {
    const baseText = `
views:
  - type: list
    name: "unknown filter"
    filters:
      and:
        - 'unknown_func(x)'
formulas:
  weird: 'Math.sqrt(file.size)'
`;
    const { ast } = parseBaseFile(baseText);
    const { views, warnings } = await renderBases(vault, ast);
    assert.equal(views[0].pages.length, 0, 'unknown filter should exclude all pages');
    assert.ok(
      warnings.some((w) => w.includes('unknown filter expression: unknown_func(x)')),
      `expected unknown-filter warning in: ${warnings.join('; ')}`,
    );
    assert.ok(
      warnings.some((w) => w.includes('unknown formula expression: weird')),
      `expected unknown-formula warning in: ${warnings.join('; ')}`,
    );
  } finally {
    await cleanup(vault);
  }
});

// ---------------------------------------------------------------------------
// BLUE-BASES-RENDERER-INTEGRATION (Task A-8): dashboard.base 10 views render
// ---------------------------------------------------------------------------

test('BLUE-BASES-RENDERER-INTEGRATION: dashboard.base 10 views render successfully', async () => {
  const vault = await makeTempVault();
  try {
    const baseText = await readFile(DASHBOARD_BASE_PATH, 'utf8');
    const { ast, warnings: parseWarnings } = parseBaseFile(baseText);
    assert.equal(
      parseWarnings.length,
      0,
      `parse warnings: ${parseWarnings.join('; ')}`,
    );
    assert.equal(ast.views.length, 10, 'dashboard.base should declare 10 views');

    const { views, warnings: renderWarnings } = await renderBases(vault, ast, {
      now: new Date('2026-05-13T00:00:00Z'),
    });
    assert.equal(views.length, 10);
    assert.equal(
      renderWarnings.length,
      0,
      `render warnings (dashboard.base is P0-only): ${renderWarnings.join('; ')}`,
    );
    for (const v of views) {
      assert.equal(typeof v.name, 'string');
      assert.ok(['table', 'list'].includes(v.type));
      assert.ok(Array.isArray(v.pages));
    }
  } finally {
    await cleanup(vault);
  }
});

// ---------------------------------------------------------------------------
// Static fixture cross-check — verify parseBaseFile + renderBases shape against
// the small visualizer fixture so a future fixture rename surfaces here.
// ---------------------------------------------------------------------------

test('static fixture (visualizer-small-vault): basic filter + ext returns markdown pages', async () => {
  const baseText = `
filters:
  and:
    - file.inFolder("wiki")
    - 'file.ext == "md"'
views:
  - type: list
    name: "all md"
`;
  const { ast, warnings } = parseBaseFile(baseText);
  assert.equal(warnings.length, 0);
  const { views } = await renderBases(STATIC_FIXTURE_VAULT, ast);
  assert.equal(views.length, 1);
  assert.ok(views[0].pages.length >= 1, 'expected at least one .md page in static fixture');
  for (const p of views[0].pages) {
    assert.ok(p.rel.endsWith('.md'));
  }
});

// ---------------------------------------------------------------------------
// BasesParseError surface check.
// ---------------------------------------------------------------------------

test('parseBaseFile throws BasesParseError on filters without "and"', () => {
  const text = `
filters:
  or:
    - 'file.ext == "md"'
`;
  assert.throws(() => parseBaseFile(text), BasesParseError);
});

// ---------------------------------------------------------------------------
// P1 Security boundary contract — RenderedView pages must NOT expose `abs`
// (absolute filesystem path). Sprint 3 body 漏洩契約 + LEARN#9 inverse pinning
// (assert on the *absence* of a field so a future walkPages widening surfaces here).
// ---------------------------------------------------------------------------

test('Security boundary: RenderedView pages do not expose `abs` or `body` (whitelist contract)', async () => {
  const vault = await makeTempVault();
  try {
    const baseText = `
views:
  - type: list
    name: "shape check"
`;
    const { ast } = parseBaseFile(baseText);
    const { views } = await renderBases(vault, ast);
    assert.ok(views[0].pages.length > 0);
    const allowed = new Set(['rel', 'name', 'type', 'title', 'frontmatter', 'mtime', 'computed']);
    for (const p of views[0].pages) {
      for (const key of Object.keys(p)) {
        assert.ok(
          allowed.has(key),
          `unexpected page field "${key}" leaked through RenderedView contract`,
        );
      }
      assert.equal(p.abs, undefined, 'page.abs must not appear (filesystem layout leak)');
      assert.equal(p.body, undefined, 'page.body must not appear (Sprint 3 contract)');
      assert.equal(p.text, undefined, 'page.text must not appear');
    }
  } finally {
    await cleanup(vault);
  }
});
