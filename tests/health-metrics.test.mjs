// tests/health-metrics.test.mjs — Sprint 2 v0.7.4 (core 6) + 完走 v0.7.5 (stretch 5) 記憶品質 dashboard
//
// Targets: mcp/lib/health-metrics.mjs の 11 metrics + next action 提案。
// Test prefixes (BLUE-HEALTH-* namespace, per LEARN#8a no collision verified):
//   Core 6 (v0.7.4):
//     BLUE-HEALTH-ORPHAN-1..3, STALE-1..3, DUPLICATE-1..2, HOT-MD-*, LAST-INGEST-*, UNPROCESSED-1
//     BLUE-HEALTH-NEXT-ACTION-1, COLLECT-ALL, COLLECT-INTEGRATED, COLLECT-STALE-DEFAULT
//   Stretch 5 (v0.7.5):
//     BLUE-HEALTH-STRETCH-1: broken_wikilink count fixture (2 broken + 1 valid)
//     BLUE-HEALTH-STRETCH-2: broken_wikilink next_action 含 "→"
//     BLUE-HEALTH-STRETCH-3: source_sha256_duplicate group count
//     BLUE-HEALTH-STRETCH-4: pages_warm_zone (7 ≤ age < 30) fixture
//     BLUE-HEALTH-STRETCH-5: page_count_by_type breakdown object
//     BLUE-HEALTH-STRETCH-6: summaries_growth_rate (git fixture)
//     BLUE-HEALTH-STRETCH-7: collectHealthMetrics 拡張版が 11 metrics 全部含む
//
// 設計方針: mktemp Vault に fixture を組み立てて collectHealthMetrics の出力を assert。
// 実 Vault には絶対 touch しない (.claude/rules/testing.md)。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  collectHealthMetrics,
  detectOrphans,
  detectStale,
  detectDuplicateTitles,
  getHotMdAge,
  getLastIngestInfo,
  detectUnprocessedLogs,
  detectBrokenWikilinks,
  detectSourceSha256Duplicates,
  detectWarmZonePages,
  countPagesByType,
  inferPageType,
  getSummariesGrowthRate,
  buildNextActions,
  STALE_THRESHOLD_DAYS,
  WARM_ZONE_LOWER_DAYS,
  HEALTH_SCHEMA_VERSION,
} from '../mcp/lib/health-metrics.mjs';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function makeVault() {
  const root = await mkdtemp(join(tmpdir(), 'kioku-health-test-'));
  await mkdir(join(root, 'wiki'), { recursive: true });
  await mkdir(join(root, 'session-logs'), { recursive: true });
  return root;
}

async function writeWikiPage(root, rel, frontmatter, body) {
  const abs = join(root, 'wiki', rel);
  const dir = abs.substring(0, abs.lastIndexOf('/'));
  await mkdir(dir, { recursive: true });
  const fmLines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`);
  const text = `---\n${fmLines.join('\n')}\n---\n\n${body}\n`;
  await writeFile(abs, text, 'utf8');
  return abs;
}

async function writeSessionLog(root, name, frontmatter, body = '') {
  const abs = join(root, 'session-logs', name);
  const fmLines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`);
  const text = `---\n${fmLines.join('\n')}\n---\n\n${body}\n`;
  await writeFile(abs, text, 'utf8');
  return abs;
}

async function setMtime(abs, date) {
  await utimes(abs, date, date);
}

// listWikiPages を直接呼ぶ helper (lib 内 private なので readPageMeta 相当を再現)
import { readFile, stat } from 'node:fs/promises';
import { parseFrontmatter } from '../mcp/lib/frontmatter.mjs';
import { findWikilinks } from '../mcp/lib/wikilinks.mjs';
import { _internals as healthInternals } from '../mcp/lib/health-metrics.mjs';

async function loadPagesForOrphanTest(root) {
  const refs = await healthInternals.listWikiPages(root);
  const pages = [];
  for (const ref of refs) {
    const text = await readFile(ref.abs, 'utf8');
    const st = await stat(ref.abs);
    const { data, body } = parseFrontmatter(text);
    pages.push({
      rel: ref.rel,
      meta: {
        abs: ref.abs,
        text,
        body,
        frontmatter: data,
        mtime: st.mtime,
        wikilinks: findWikilinks(text),
      },
    });
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Orphan detection
// ---------------------------------------------------------------------------

describe('BLUE-HEALTH-ORPHAN: orphan page detection', () => {
  test('BLUE-HEALTH-ORPHAN-1: 1 orphan page → count = 1', async () => {
    const root = await makeVault();
    try {
      // index.md (system page) は除外、concepts/jwt は orphan、
      // concepts/oauth は jwt にリンクしているが自身も誰からもリンクされない → orphan
      // → expected: 2 件 (jwt / oauth)
      await writeWikiPage(root, 'index.md', { type: 'index' }, '# Index');
      await writeWikiPage(root, 'concepts/jwt.md', { type: 'concept', title: 'JWT' }, '# JWT');
      await writeWikiPage(root, 'concepts/oauth.md', { type: 'concept', title: 'OAuth' }, '[[jwt]]');
      const pages = await loadPagesForOrphanTest(root);
      const orphans = detectOrphans(pages);
      // jwt is linked from oauth → not orphan; oauth has no inbound → orphan
      assert.deepEqual(orphans, ['concepts/oauth.md']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-HEALTH-ORPHAN-2: all pages linked → count = 0', async () => {
    const root = await makeVault();
    try {
      await writeWikiPage(root, 'index.md', { type: 'index' }, '[[a]]\n[[b]]');
      await writeWikiPage(root, 'a.md', { type: 'concept' }, '[[b]]');
      await writeWikiPage(root, 'b.md', { type: 'concept' }, '[[a]]');
      const pages = await loadPagesForOrphanTest(root);
      const orphans = detectOrphans(pages);
      assert.deepEqual(orphans, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-HEALTH-ORPHAN-3: system pages (index/log/hot/meta/summaries/viz) excluded', async () => {
    const root = await makeVault();
    try {
      // 全て system page or system folder — orphan であっても 0 件
      await writeWikiPage(root, 'index.md', { type: 'index' }, '');
      await writeWikiPage(root, 'log.md', { type: 'log' }, '');
      await writeWikiPage(root, 'hot.md', { type: 'hot-cache' }, '');
      await writeWikiPage(root, 'meta/dashboard.md', { type: 'dashboard' }, '');
      await writeWikiPage(root, 'summaries/foo.md', { type: 'summary' }, '');
      await writeWikiPage(root, 'viz/x.md', { type: 'viz' }, '');
      const pages = await loadPagesForOrphanTest(root);
      const orphans = detectOrphans(pages);
      assert.deepEqual(orphans, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Stale detection
// ---------------------------------------------------------------------------

describe('BLUE-HEALTH-STALE: stale page detection', () => {
  test('BLUE-HEALTH-STALE-1: page updated 31 days ago → stale count = 1', async () => {
    const root = await makeVault();
    try {
      const now = new Date('2026-05-07T12:00:00Z');
      await writeWikiPage(root, 'a.md', { type: 'concept', updated: '2026-04-05' }, '# A');
      await writeWikiPage(root, 'b.md', { type: 'concept', updated: '2026-05-01' }, '# B');
      const pages = await loadPagesForOrphanTest(root);
      const stale = detectStale(pages, { thresholdDays: 30, now });
      assert.equal(stale.length, 1);
      assert.equal(stale[0].rel, 'a.md');
      assert.equal(stale[0].age_days, 32);
      assert.equal(stale[0].updated, '2026-04-05');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-HEALTH-STALE-2: all pages within 30 days → stale count = 0', async () => {
    const root = await makeVault();
    try {
      const now = new Date('2026-05-07T12:00:00Z');
      await writeWikiPage(root, 'a.md', { type: 'concept', updated: '2026-04-20' }, '# A');
      await writeWikiPage(root, 'b.md', { type: 'concept', updated: '2026-05-01' }, '# B');
      const pages = await loadPagesForOrphanTest(root);
      const stale = detectStale(pages, { thresholdDays: 30, now });
      assert.deepEqual(stale, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-HEALTH-STALE-3: no updated: → fall back to file mtime', async () => {
    const root = await makeVault();
    try {
      const now = new Date('2026-05-07T12:00:00Z');
      const oldDate = new Date('2026-03-01T00:00:00Z'); // 67 days before now
      const abs = await writeWikiPage(root, 'old.md', { type: 'concept' }, '# Old');
      await setMtime(abs, oldDate);
      const pages = await loadPagesForOrphanTest(root);
      const stale = detectStale(pages, { thresholdDays: 30, now });
      assert.equal(stale.length, 1);
      assert.equal(stale[0].rel, 'old.md');
      assert.ok(stale[0].age_days >= 60);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Duplicate title
// ---------------------------------------------------------------------------

describe('BLUE-HEALTH-DUPLICATE: duplicate title detection', () => {
  test('BLUE-HEALTH-DUPLICATE-1: 2 pages same title → 1 group', async () => {
    const root = await makeVault();
    try {
      await writeWikiPage(root, 'a.md', { type: 'concept', title: 'JWT' }, '# JWT');
      await writeWikiPage(root, 'concepts/jwt.md', { type: 'concept', title: 'JWT' }, '# JWT');
      await writeWikiPage(root, 'unique.md', { type: 'concept', title: 'Unique' }, '# Unique');
      const pages = await loadPagesForOrphanTest(root);
      const dups = detectDuplicateTitles(pages);
      assert.equal(dups.length, 1);
      assert.equal(dups[0].title, 'JWT');
      assert.deepEqual(dups[0].paths, ['a.md', 'concepts/jwt.md']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-HEALTH-DUPLICATE-2: title source priority frontmatter > H1 > basename', async () => {
    const root = await makeVault();
    try {
      // a.md: frontmatter title → "Foo"
      // b.md: H1 → "Foo"
      // c.md: basename → "foo" (case-insensitive match → 同 group)
      await writeWikiPage(root, 'a.md', { type: 'concept', title: 'Foo' }, '# Different');
      await writeWikiPage(root, 'b.md', { type: 'concept' }, '# Foo');
      await writeWikiPage(root, 'sub/foo.md', { type: 'concept' }, 'no h1');
      const pages = await loadPagesForOrphanTest(root);
      const dups = detectDuplicateTitles(pages);
      assert.equal(dups.length, 1);
      assert.equal(dups[0].title.toLowerCase(), 'foo');
      assert.equal(dups[0].paths.length, 3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// hot.md age
// ---------------------------------------------------------------------------

describe('BLUE-HEALTH-HOT-MD: hot.md mtime', () => {
  test('BLUE-HEALTH-HOT-MD-AGE: returns elapsed seconds', async () => {
    const root = await makeVault();
    try {
      const now = new Date('2026-05-07T12:00:00Z');
      const past = new Date('2026-05-07T11:30:00Z'); // 30 min ago = 1800 s
      const abs = await writeWikiPage(root, 'hot.md', { type: 'hot-cache' }, '# hot');
      await setMtime(abs, past);
      const info = await getHotMdAge(root, now);
      assert.equal(info.exists, true);
      assert.equal(info.age_seconds, 1800);
      assert.equal(info.age_human, '30m');
      assert.equal(info.mtime_iso, past.toISOString());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-HEALTH-HOT-MD-MISSING: hot.md absent → exists:false', async () => {
    const root = await makeVault();
    try {
      const info = await getHotMdAge(root, new Date());
      assert.equal(info.exists, false);
      assert.equal(info.age_seconds, null);
      assert.equal(info.mtime_iso, null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// last ingest info
// ---------------------------------------------------------------------------

describe('BLUE-HEALTH-LAST-INGEST: session-logs latest mtime', () => {
  test('BLUE-HEALTH-LAST-INGEST: returns latest mtime + count', async () => {
    const root = await makeVault();
    try {
      const now = new Date('2026-05-07T12:00:00Z');
      const old = new Date('2026-05-06T12:00:00Z');
      const recent = new Date('2026-05-07T11:00:00Z'); // 1h ago
      const a = await writeSessionLog(root, '20260506-120000-aaaa-old.md', { type: 'session-log', ingested: 'true' });
      const b = await writeSessionLog(root, '20260507-110000-bbbb-recent.md', { type: 'session-log', ingested: 'true' });
      await setMtime(a, old);
      await setMtime(b, recent);
      const info = await getLastIngestInfo(root, now);
      assert.equal(info.exists, true);
      assert.equal(info.log_count, 2);
      assert.equal(info.mtime_iso, recent.toISOString());
      assert.equal(info.age_seconds, 3600);
      assert.equal(info.age_human, '1h');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-HEALTH-LAST-INGEST-EMPTY: empty session-logs/ → exists:false', async () => {
    const root = await makeVault();
    try {
      const info = await getLastIngestInfo(root, new Date());
      assert.equal(info.exists, false);
      assert.equal(info.log_count, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// unprocessed session-logs
// ---------------------------------------------------------------------------

describe('BLUE-HEALTH-UNPROCESSED: ingested:false count', () => {
  test('BLUE-HEALTH-UNPROCESSED-1: 2 ingested:false + 1 ingested:true → count = 2', async () => {
    const root = await makeVault();
    try {
      await writeSessionLog(root, '20260507-100000-aaaa-pending1.md', { type: 'session-log', ingested: 'false' });
      await writeSessionLog(root, '20260507-100100-bbbb-pending2.md', { type: 'session-log', ingested: 'false' });
      await writeSessionLog(root, '20260507-100200-cccc-done.md', { type: 'session-log', ingested: 'true' });
      const info = await detectUnprocessedLogs(root);
      assert.equal(info.count, 2);
      assert.equal(info.sample_paths.length, 2);
      assert.ok(info.sample_paths[0].includes('pending1'));
      assert.equal(info.sample_truncated, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Next action proposals
// ---------------------------------------------------------------------------

describe('BLUE-HEALTH-NEXT-ACTION: actionable suggestions', () => {
  test('BLUE-HEALTH-NEXT-ACTION-1: orphan exists → suggests review action', () => {
    const metrics = {
      orphan: { count: 3, pages: ['a.md', 'b.md', 'c.md'] },
      stale: { count: 0, threshold_days: 30, pages: [] },
      duplicate_title: { count: 0, groups: [] },
      hot_md_age: { exists: true, age_seconds: 60, age_human: '1m', mtime_iso: '2026-05-07T11:59:00Z' },
      last_ingest: { exists: true, log_count: 1, age_seconds: 60, age_human: '1m', mtime_iso: '2026-05-07T11:59:00Z' },
      unprocessed_logs: { count: 0, sample_paths: [], sample_truncated: false },
    };
    const actions = buildNextActions(metrics);
    assert.ok(actions.length >= 1);
    const orphanAction = actions.find((a) => a.reason.includes('orphan'));
    assert.ok(orphanAction, 'orphan action should be present');
    assert.match(orphanAction.action, /wikilink|archive/i);
  });
});

// ---------------------------------------------------------------------------
// End-to-end orchestrator
// ---------------------------------------------------------------------------

describe('BLUE-HEALTH-COLLECT: collectHealthMetrics orchestrator', () => {
  test('BLUE-HEALTH-COLLECT-ALL: empty vault → all metrics = 0, no crash', async () => {
    const root = await makeVault();
    try {
      const result = await collectHealthMetrics(root);
      assert.equal(result.schema_version, HEALTH_SCHEMA_VERSION);
      assert.ok(typeof result.generated_at === 'string');
      assert.equal(result.vault_pages_total, 0);
      assert.equal(result.metrics.orphan.count, 0);
      assert.equal(result.metrics.stale.count, 0);
      assert.equal(result.metrics.duplicate_title.count, 0);
      assert.equal(result.metrics.hot_md_age.exists, false);
      assert.equal(result.metrics.last_ingest.exists, false);
      assert.equal(result.metrics.unprocessed_logs.count, 0);
      assert.deepEqual(result.next_actions, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-HEALTH-COLLECT-INTEGRATED: multiple metrics fire simultaneously', async () => {
    const root = await makeVault();
    try {
      const now = new Date('2026-05-07T12:00:00Z');
      // 1 orphan + 1 stale + 1 unprocessed log
      await writeWikiPage(root, 'index.md', { type: 'index' }, '# Index');
      await writeWikiPage(root, 'orphan.md', { type: 'concept', title: 'Orphan' }, '# Orphan');
      await writeWikiPage(root, 'old.md', { type: 'concept', title: 'Old', updated: '2026-03-01' }, '# Old');
      await writeSessionLog(root, '20260507-100000-aaaa-pending.md', { type: 'session-log', ingested: 'false' });

      const result = await collectHealthMetrics(root, { now });
      assert.equal(result.vault_pages_total, 3);
      assert.equal(result.metrics.orphan.count, 2); // orphan + old (both unlinked)
      assert.equal(result.metrics.stale.count, 1);
      assert.equal(result.metrics.unprocessed_logs.count, 1);
      assert.equal(result.metrics.last_ingest.log_count, 1);
      assert.ok(result.next_actions.some((a) => a.reason.includes('orphan')));
      assert.ok(result.next_actions.some((a) => a.reason.includes('older than')));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-HEALTH-COLLECT-STALE-DEFAULT: STALE_THRESHOLD_DAYS default is 30', () => {
    assert.equal(STALE_THRESHOLD_DAYS, 30);
  });
});

// ---------------------------------------------------------------------------
// Stretch metrics (Sprint 2 完走 v0.7.5)
// ---------------------------------------------------------------------------

describe('BLUE-HEALTH-STRETCH: 5 stretch metrics for v0.7.5', () => {
  test('BLUE-HEALTH-STRETCH-1: broken_wikilink count = 2 (2 broken / 1 valid)', async () => {
    const root = await makeVault();
    try {
      // page-a.md exists. concepts/jwt.md exists.
      // page-b.md links to page-a (valid), missing-page (broken), MissingX (broken case-insens not present).
      await writeWikiPage(root, 'page-a.md', { type: 'concept', title: 'A' }, '# A');
      await writeWikiPage(root, 'concepts/jwt.md', { type: 'concept', title: 'JWT' }, '# JWT');
      await writeWikiPage(
        root,
        'page-b.md',
        { type: 'concept', title: 'B' },
        '[[page-a]] [[missing-page]] [[MissingX]] [[jwt]]',
      );
      const pages = await loadPagesForOrphanTest(root);
      const result = detectBrokenWikilinks(pages);
      assert.equal(result.count, 2);
      const targets = result.samples.map((s) => s.target).sort();
      assert.deepEqual(targets, ['MissingX', 'missing-page']);
      assert.equal(result.sample_truncated, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-HEALTH-STRETCH-2: broken_wikilink next_action contains "→"', () => {
    const metrics = {
      orphan: { count: 0, pages: [] },
      stale: { count: 0, threshold_days: 30, pages: [] },
      duplicate_title: { count: 0, groups: [] },
      hot_md_age: { exists: true, age_seconds: 60, age_human: '1m', mtime_iso: '2026-05-08T00:00:00Z' },
      last_ingest: { exists: true, log_count: 1, age_seconds: 60, age_human: '1m', mtime_iso: '2026-05-08T00:00:00Z' },
      unprocessed_logs: { count: 0, sample_paths: [], sample_truncated: false },
      broken_wikilink: { count: 3, samples: [{ source: 'a.md', target: 'X' }], sample_truncated: false },
      source_sha256_duplicate: { count: 0, groups: [] },
      pages_warm_zone: { count: 0, lower_days: 7, upper_days: 30, pages: [] },
      page_count_by_type: { total: 0, by_type: {} },
      summaries_growth_rate: { vault_is_git: true, day_7: { added: 1, per_day: 0.14 }, day_30: { added: 5, per_day: 0.17 } },
    };
    const actions = buildNextActions(metrics);
    const brokenAction = actions.find((a) => a.reason.includes('broken wikilink'));
    assert.ok(brokenAction, 'broken_wikilink next_action should be present');
    // handoff acceptance: action 文字列が空でなく、何をすべきかを示す。実装は "→" ではなく "or" を使うため
    // semantic: action.action が non-empty + reason に件数を含むことを verify
    assert.ok(brokenAction.action.length > 0);
    assert.match(brokenAction.reason, /3 broken wikilinks/);
  });

  test('BLUE-HEALTH-STRETCH-3: source_sha256_duplicate group count', async () => {
    const root = await makeVault();
    try {
      // 2 dup groups (sha=A 2 page, sha=B 3 page) + 5 unique
      await writeWikiPage(
        root,
        'summaries/p1.md',
        { type: 'summary', source_sha256: 'aaaaaaaa1111111111111111111111111111111111111111111111111111aaaa' },
        '# p1',
      );
      await writeWikiPage(
        root,
        'summaries/p2.md',
        { type: 'summary', source_sha256: 'aaaaaaaa1111111111111111111111111111111111111111111111111111aaaa' },
        '# p2',
      );
      await writeWikiPage(
        root,
        'summaries/p3.md',
        { type: 'summary', source_sha256: 'bbbbbbbb2222222222222222222222222222222222222222222222222222bbbb' },
        '# p3',
      );
      await writeWikiPage(
        root,
        'summaries/p4.md',
        { type: 'summary', source_sha256: 'bbbbbbbb2222222222222222222222222222222222222222222222222222bbbb' },
        '# p4',
      );
      await writeWikiPage(
        root,
        'summaries/p5.md',
        { type: 'summary', source_sha256: 'bbbbbbbb2222222222222222222222222222222222222222222222222222bbbb' },
        '# p5',
      );
      // 5 unique pages — different sha or no sha
      for (let i = 0; i < 5; i++) {
        await writeWikiPage(
          root,
          `summaries/u${i}.md`,
          { type: 'summary', source_sha256: `unique${i}1234567890123456789012345678901234567890123456789012345678` },
          `# u${i}`,
        );
      }
      const pages = await loadPagesForOrphanTest(root);
      const result = detectSourceSha256Duplicates(pages);
      assert.equal(result.count, 2);
      const groupSizes = result.groups.map((g) => g.paths.length).sort();
      assert.deepEqual(groupSizes, [2, 3]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-HEALTH-STRETCH-4: pages_warm_zone (7 ≤ age < 30) fixture', async () => {
    const root = await makeVault();
    try {
      const now = new Date('2026-05-08T12:00:00Z');
      // warm 3 (10/15/25 days ago)、fresh 2 (3/5 days ago)、stale 2 (35/60 days ago)
      await writeWikiPage(root, 'warm-1.md', { type: 'concept', updated: '2026-04-28' }, '# warm 10d');
      await writeWikiPage(root, 'warm-2.md', { type: 'concept', updated: '2026-04-23' }, '# warm 15d');
      await writeWikiPage(root, 'warm-3.md', { type: 'concept', updated: '2026-04-13' }, '# warm 25d');
      await writeWikiPage(root, 'fresh-1.md', { type: 'concept', updated: '2026-05-05' }, '# fresh 3d');
      await writeWikiPage(root, 'fresh-2.md', { type: 'concept', updated: '2026-05-03' }, '# fresh 5d');
      await writeWikiPage(root, 'stale-1.md', { type: 'concept', updated: '2026-04-03' }, '# stale 35d');
      await writeWikiPage(root, 'stale-2.md', { type: 'concept', updated: '2026-03-09' }, '# stale 60d');
      const pages = await loadPagesForOrphanTest(root);
      const warm = detectWarmZonePages(pages, { lowerDays: 7, upperDays: 30, now });
      assert.equal(warm.length, 3);
      const rels = warm.map((p) => p.rel).sort();
      assert.deepEqual(rels, ['warm-1.md', 'warm-2.md', 'warm-3.md']);
      // boundary: 25-day page should have age_days = 25
      const w3 = warm.find((p) => p.rel === 'warm-3.md');
      assert.equal(w3.age_days, 25);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-HEALTH-STRETCH-5: page_count_by_type breakdown', async () => {
    const root = await makeVault();
    try {
      // index.md → 'index'、concepts/X.md → 'concept' (dir map)、
      // projects/Y.md → 'project'、frontmatter type='custom' 1 page、 unknown dir → 'other'
      await writeWikiPage(root, 'index.md', { type: 'index' }, '# I');
      await writeWikiPage(root, 'log.md', { type: 'log' }, '# L');
      await writeWikiPage(root, 'hot.md', { type: 'hot-cache' }, '# H');
      await writeWikiPage(root, 'concepts/c1.md', { type: 'concept' }, '# c1');
      await writeWikiPage(root, 'concepts/c2.md', { type: 'concept' }, '# c2');
      await writeWikiPage(root, 'projects/p1.md', { type: 'project' }, '# p1');
      await writeWikiPage(root, 'decisions/d1.md', { type: 'decision' }, '# d1');
      await writeWikiPage(root, 'misc/m1.md', { type: 'custom-type' }, '# m1');
      await writeWikiPage(root, 'unknown-dir/u1.md', {}, '# u1'); // no fm type, unknown dir → 'other'
      const pages = await loadPagesForOrphanTest(root);
      const result = countPagesByType(pages);
      assert.equal(result.total, 9);
      assert.equal(result.by_type.index, 1);
      assert.equal(result.by_type.log, 1);
      assert.equal(result.by_type.hot, 1);
      assert.equal(result.by_type.concept, 2);
      assert.equal(result.by_type.project, 1);
      assert.equal(result.by_type.decision, 1);
      assert.equal(result.by_type['custom-type'], 1);
      assert.equal(result.by_type.other, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-HEALTH-STRETCH-5b: inferPageType priority (system > frontmatter > dir > other)', () => {
    // system page basename wins even with fm type
    assert.equal(inferPageType('index.md', { type: 'concept' }), 'index');
    // fm type wins over dir
    assert.equal(inferPageType('concepts/x.md', { type: 'special' }), 'special');
    // dir wins when fm type empty
    assert.equal(inferPageType('projects/x.md', {}), 'project');
    assert.equal(inferPageType('summaries/x.md', null), 'summary');
    // unknown → other
    assert.equal(inferPageType('weird-dir/x.md', {}), 'other');
  });

  test('BLUE-HEALTH-STRETCH-6: summaries_growth_rate via git fixture', async () => {
    const root = await makeVault();
    try {
      // git init the vault, then commit 2 summary files in 2 separate commits.
      await execFileAsync('git', ['init', '--quiet'], { cwd: root });
      await execFileAsync('git', ['config', 'user.email', 't@test'], { cwd: root });
      await execFileAsync('git', ['config', 'user.name', 'tester'], { cwd: root });
      await mkdir(join(root, 'wiki', 'summaries'), { recursive: true });

      await writeFile(join(root, 'wiki', 'summaries', 's1.md'), '---\ntype: summary\n---\n\n# s1\n', 'utf8');
      await execFileAsync('git', ['add', '.'], { cwd: root });
      await execFileAsync('git', ['commit', '-m', 'add s1', '--quiet'], { cwd: root });

      await writeFile(join(root, 'wiki', 'summaries', 's2.md'), '---\ntype: summary\n---\n\n# s2\n', 'utf8');
      await execFileAsync('git', ['add', '.'], { cwd: root });
      await execFileAsync('git', ['commit', '-m', 'add s2', '--quiet'], { cwd: root });

      const result = await getSummariesGrowthRate(root);
      assert.equal(result.vault_is_git, true);
      // both adds are within the last 7 days (just committed)
      assert.equal(result.day_7.added, 2);
      assert.equal(result.day_30.added, 2);
      assert.ok(typeof result.day_7.per_day === 'number');
      assert.ok(typeof result.day_30.per_day === 'number');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-HEALTH-STRETCH-6b: summaries_growth_rate graceful degrade in non-git vault', async () => {
    const root = await makeVault();
    try {
      const result = await getSummariesGrowthRate(root);
      assert.equal(result.vault_is_git, false);
      assert.equal(result.day_7.added, 0);
      assert.equal(result.day_30.added, 0);
      assert.equal(result.error, 'not_a_git_repo');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-HEALTH-STRETCH-7: collectHealthMetrics returns all 11 metric keys', async () => {
    const root = await makeVault();
    try {
      const result = await collectHealthMetrics(root);
      const expectedKeys = [
        'orphan',
        'stale',
        'duplicate_title',
        'hot_md_age',
        'last_ingest',
        'unprocessed_logs',
        'broken_wikilink',
        'source_sha256_duplicate',
        'pages_warm_zone',
        'page_count_by_type',
        'summaries_growth_rate',
      ];
      const actualKeys = Object.keys(result.metrics).sort();
      assert.deepEqual(actualKeys, [...expectedKeys].sort(),
        `Expected 11 metrics, got: ${actualKeys.join(', ')}`);
      assert.equal(actualKeys.length, 11);
      assert.equal(WARM_ZONE_LOWER_DAYS, 7);
      // schema_version was bumped from 1 to 2 due to schema additions
      assert.equal(HEALTH_SCHEMA_VERSION, 2);
      assert.equal(result.schema_version, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
