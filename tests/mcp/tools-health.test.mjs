// tests/mcp/tools-health.test.mjs — kioku_health MCP tool (Sprint 2 v0.7.4 + 完走 v0.7.5)
//
// Test prefixes (MCP-HEALTH-* namespace, per LEARN#8a no collision verified):
//   MCP-HEALTH-1: TOOL_DEF shape (name / title / description / inputShape)
//   MCP-HEALTH-2: empty vault → metrics = 0, no crash
//   MCP-HEALTH-3: 正常 vault で valid metrics 返却
//   MCP-HEALTH-4: paths_limit で orphan/stale 配列が truncate される
//   MCP-HEALTH-5: threshold_days override が stale 判定に効く
//   MCP-HEALTH-6: 大量 page (mock 100+) でも timeout なし
//   MCP-HEALTH-STRETCH-1: kioku_health 出力 JSON に stretch 5 metrics の key と shape が含まれる

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HEALTH_TOOL_DEF, handleHealth } from '../../mcp/tools/health.mjs';

async function makeVault() {
  const root = await mkdtemp(join(tmpdir(), 'kioku-health-mcp-test-'));
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

describe('kioku_health (Sprint 2 v0.7.4)', () => {
  test('MCP-HEALTH-1: TOOL_DEF shape', () => {
    assert.equal(HEALTH_TOOL_DEF.name, 'kioku_health');
    assert.ok(typeof HEALTH_TOOL_DEF.title === 'string' && HEALTH_TOOL_DEF.title.length > 0);
    assert.ok(typeof HEALTH_TOOL_DEF.description === 'string');
    assert.match(HEALTH_TOOL_DEF.description, /metric/i);
    assert.match(HEALTH_TOOL_DEF.description, /Read-only/);
    assert.ok(HEALTH_TOOL_DEF.inputShape.threshold_days);
    assert.ok(HEALTH_TOOL_DEF.inputShape.paths_limit);
  });

  test('MCP-HEALTH-2: empty vault → metrics = 0, no crash', async () => {
    const root = await makeVault();
    try {
      const result = await handleHealth(root);
      assert.equal(result.vault_pages_total, 0);
      assert.equal(result.metrics.orphan.count, 0);
      assert.equal(result.metrics.stale.count, 0);
      assert.equal(result.metrics.duplicate_title.count, 0);
      assert.equal(result.metrics.hot_md_age.exists, false);
      assert.equal(result.metrics.last_ingest.exists, false);
      assert.equal(result.metrics.unprocessed_logs.count, 0);
      assert.deepEqual(result.next_actions, []);
      assert.equal(result.truncated.orphan_pages, false);
      assert.equal(result.truncated.stale_pages, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('MCP-HEALTH-3: valid metrics for non-empty vault', async () => {
    const root = await makeVault();
    try {
      await writeWikiPage(root, 'index.md', { type: 'index' }, '[[a]]');
      await writeWikiPage(root, 'a.md', { type: 'concept', title: 'A' }, '# A');
      await writeWikiPage(root, 'orphan.md', { type: 'concept', title: 'Orphan' }, '# Orphan');
      const result = await handleHealth(root);
      assert.equal(result.vault_pages_total, 3);
      assert.equal(result.metrics.orphan.count, 1);
      assert.deepEqual(result.metrics.orphan.pages, ['orphan.md']);
      assert.ok(result.next_actions.some((a) => a.reason.includes('orphan')));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('MCP-HEALTH-4: paths_limit truncates orphan/stale lists', async () => {
    const root = await makeVault();
    try {
      // 5 orphan pages
      for (let i = 0; i < 5; i++) {
        await writeWikiPage(root, `orphan-${i}.md`, { type: 'concept' }, `# ${i}`);
      }
      const limited = await handleHealth(root, { paths_limit: 2 });
      assert.equal(limited.metrics.orphan.count, 5);
      assert.equal(limited.metrics.orphan.pages.length, 2);
      assert.equal(limited.truncated.orphan_pages, true);

      // paths_limit: 0 → counts only
      const zeroLimit = await handleHealth(root, { paths_limit: 0 });
      assert.equal(zeroLimit.metrics.orphan.count, 5);
      assert.equal(zeroLimit.metrics.orphan.pages.length, 0);
      assert.equal(zeroLimit.truncated.orphan_pages, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('MCP-HEALTH-5: threshold_days override changes stale judgement', async () => {
    const root = await makeVault();
    try {
      // page from 10 days ago: stale at threshold 5, not stale at threshold 30
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
      const abs = await writeWikiPage(
        root,
        'recent.md',
        { type: 'concept', updated: tenDaysAgo.toISOString().slice(0, 10) },
        '# recent',
      );
      await utimes(abs, tenDaysAgo, tenDaysAgo);

      const tight = await handleHealth(root, { threshold_days: 5 });
      assert.equal(tight.metrics.stale.threshold_days, 5);
      assert.equal(tight.metrics.stale.count, 1);

      const loose = await handleHealth(root, { threshold_days: 30 });
      assert.equal(loose.metrics.stale.threshold_days, 30);
      assert.equal(loose.metrics.stale.count, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('MCP-HEALTH-6: 100 pages mock — completes within reasonable time (<2s)', async () => {
    const root = await makeVault();
    try {
      // generate 100 small pages, each linked from index.md to keep orphan = 0
      const links = [];
      for (let i = 0; i < 100; i++) {
        await writeWikiPage(root, `p-${i}.md`, { type: 'concept', title: `P${i}` }, `# P${i}`);
        links.push(`[[p-${i}]]`);
      }
      await writeWikiPage(root, 'index.md', { type: 'index' }, links.join('\n'));

      const t0 = Date.now();
      const result = await handleHealth(root);
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 2000, `MCP-HEALTH-6: 100 pages took ${elapsed}ms (expected < 2000)`);
      assert.equal(result.vault_pages_total, 101);
      assert.equal(result.metrics.orphan.count, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('MCP-HEALTH-STRETCH-1: kioku_health JSON includes stretch 5 metric keys + shape', async () => {
    const root = await makeVault();
    try {
      // Fixture trigger 各 stretch metric が 0 でない値を出すように
      // page-a (valid wikilink target), page-b (broken link), summary 2 page (sha dup),
      // warm zone page, type breakdown page
      await writeWikiPage(root, 'index.md', { type: 'index' }, '[[page-a]]');
      await writeWikiPage(root, 'page-a.md', { type: 'concept', title: 'A' }, '# A');
      await writeWikiPage(root, 'page-b.md', { type: 'concept' }, '[[page-a]] [[NoSuchTarget]]');
      await writeWikiPage(
        root,
        'summaries/dup1.md',
        { type: 'summary', source_sha256: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111' },
        '# d1',
      );
      await writeWikiPage(
        root,
        'summaries/dup2.md',
        { type: 'summary', source_sha256: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111' },
        '# d2',
      );

      const result = await handleHealth(root);

      // 5 stretch keys present
      assert.ok('broken_wikilink' in result.metrics);
      assert.ok('source_sha256_duplicate' in result.metrics);
      assert.ok('pages_warm_zone' in result.metrics);
      assert.ok('page_count_by_type' in result.metrics);
      assert.ok('summaries_growth_rate' in result.metrics);

      // shape verification
      assert.equal(typeof result.metrics.broken_wikilink.count, 'number');
      assert.equal(result.metrics.broken_wikilink.count, 1);
      assert.ok(Array.isArray(result.metrics.broken_wikilink.samples));

      assert.equal(typeof result.metrics.source_sha256_duplicate.count, 'number');
      assert.equal(result.metrics.source_sha256_duplicate.count, 1);
      assert.ok(Array.isArray(result.metrics.source_sha256_duplicate.groups));

      assert.equal(typeof result.metrics.pages_warm_zone.count, 'number');
      assert.equal(result.metrics.pages_warm_zone.lower_days, 7);
      assert.equal(result.metrics.pages_warm_zone.upper_days, 30);
      assert.ok(Array.isArray(result.metrics.pages_warm_zone.pages));

      assert.equal(typeof result.metrics.page_count_by_type.total, 'number');
      assert.equal(typeof result.metrics.page_count_by_type.by_type, 'object');

      // summaries_growth_rate: vault is non-git in this test → graceful degrade
      assert.equal(result.metrics.summaries_growth_rate.vault_is_git, false);
      assert.equal(result.metrics.summaries_growth_rate.day_7.added, 0);
      assert.equal(result.metrics.summaries_growth_rate.day_30.added, 0);

      // truncated.warm_zone_pages key added in v0.7.5
      assert.ok('warm_zone_pages' in result.truncated);

      // stretch metrics に対応する next_action が存在 (broken_wikilink のみ trigger 中)
      const reasons = result.next_actions.map((a) => a.reason).join(' | ');
      assert.match(reasons, /broken wikilink/);
      assert.match(reasons, /source_sha256/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
