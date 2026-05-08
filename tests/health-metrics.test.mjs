// tests/health-metrics.test.mjs — Sprint 2 v0.7.4 記憶品質 dashboard
//
// Targets: mcp/lib/health-metrics.mjs の 6 core metrics + next action 提案。
// Test prefixes (BLUE-HEALTH-* namespace, per LEARN#8a no collision verified):
//   BLUE-HEALTH-ORPHAN-1     : orphan page あり → count = 1
//   BLUE-HEALTH-ORPHAN-2     : 全 page リンク済 → count = 0
//   BLUE-HEALTH-ORPHAN-3     : system page (index/hot/meta/summaries) は除外
//   BLUE-HEALTH-STALE-1      : updated: 30 日以上前 → stale count = 1
//   BLUE-HEALTH-STALE-2      : 全 page 30 日以内 → stale count = 0
//   BLUE-HEALTH-STALE-3      : updated: 不在時は file mtime で判定
//   BLUE-HEALTH-DUPLICATE-1  : 同 title 2 page → duplicate count = 1
//   BLUE-HEALTH-DUPLICATE-2  : title source priority (frontmatter > H1 > basename)
//   BLUE-HEALTH-HOT-MD-AGE   : hot.md mtime → 経過秒
//   BLUE-HEALTH-HOT-MD-MISSING : hot.md 不在 → exists:false
//   BLUE-HEALTH-LAST-INGEST  : session-logs/ 最新 mtime + 件数
//   BLUE-HEALTH-LAST-INGEST-EMPTY : session-logs/ 空 → exists:false
//   BLUE-HEALTH-UNPROCESSED-1 : ingested:false 件数
//   BLUE-HEALTH-NEXT-ACTION-1 : orphan ありなら action 提案
//   BLUE-HEALTH-COLLECT-ALL  : empty vault でも crash せず全 metric = 0
//   BLUE-HEALTH-COLLECT-INTEGRATED : 複数 metric が同時発火する fixture で整合
//
// 設計方針: mktemp Vault に fixture を組み立てて collectHealthMetrics の出力を assert。
// 実 Vault には絶対 touch しない (.claude/rules/testing.md)。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectHealthMetrics,
  detectOrphans,
  detectStale,
  detectDuplicateTitles,
  getHotMdAge,
  getLastIngestInfo,
  detectUnprocessedLogs,
  buildNextActions,
  STALE_THRESHOLD_DAYS,
  HEALTH_SCHEMA_VERSION,
} from '../mcp/lib/health-metrics.mjs';

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
