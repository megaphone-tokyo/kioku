// visualizer-data.test.mjs — Phase 1+2 v0.8 Visualizer β First view data tests
//
// 実行: node --test tools/claude-brain/tests/visualizer-data.test.mjs
//
// codex strategic doc 260512_v0-8-visualizer-beta-scope.md §Axis 3 First view
// = 4 layer ordering (Vault overview / Health focus / Graph preview / Action queue)
//
// Phase 1 ケース:
//   BLUE-VIZ-FIRSTVIEW-1: Vault overview data shape
//   BLUE-VIZ-FIRSTVIEW-2: Health focus data shape (broken / sha256 dup / warm zone)
//   BLUE-VIZ-FIRSTVIEW-3: Graph preview data (hot pages / active projects / recent decisions)
//   BLUE-VIZ-FIRSTVIEW-4: Action queue 3-5 件 (priority + next_action 必須)
//   BLUE-VIZ-FIRSTVIEW-5: Schema isolation — first_view が既存 snapshots schema を壊さない
//
// Phase 2 ケース (Health overlay integration):
//   BLUE-VIZ-HEALTH-OVERLAY-1: broken_wikilink.clusters (target でグループ化、merge target view)
//   BLUE-VIZ-HEALTH-OVERLAY-2: source_sha256_duplicate.groups merge candidate context
//   BLUE-VIZ-HEALTH-OVERLAY-3: pages_warm_zone.distribution (fresh/warm/stale 3 bucket gradient)
//   BLUE-VIZ-HEALTH-OVERLAY-4: page_count_by_type chart-friendly (sorted entries 計算)
//   BLUE-VIZ-HEALTH-OVERLAY-5: summaries_growth_rate sparkline data (7d/30d + per_day)
//   BLUE-VIZ-HEALTH-OVERLAY-6: status_banner with 6 P1 metrics + severity (ok/info/warn/danger)
//   BLUE-VIZ-HEALTH-OVERLAY-7: (Phase 4 で flip) auto_lint field is now present in first_view,
//                              graceful null when no report file
//
// Phase 4 ケース (Auto-lint drawer):
//   BLUE-VIZ-AUTOLINT-DRAWER-1: loadAutoLintReport returns null when no wiki/lint-report.md
//   BLUE-VIZ-AUTOLINT-DRAWER-2: 4 観点 sections are correctly extracted with samples + counts
//   BLUE-VIZ-AUTOLINT-DRAWER-3: sample text is collapsed + truncated to 240 chars
//   BLUE-VIZ-AUTOLINT-DRAWER-4: sample_limit caps per-category at 3 samples
//   BLUE-VIZ-AUTOLINT-DRAWER-5: "(検出なし)" / "none" markers produce count=0
//   BLUE-VIZ-AUTOLINT-DRAWER-6: frontmatter date is extracted as generated_at
//   BLUE-VIZ-AUTOLINT-DRAWER-7: malformed markdown doesn't crash (paragraph fallback)
//   BLUE-VIZ-AUTOLINT-DRAWER-8: source_truncated flag set when file exceeds 256KB
//   BLUE-VIZ-AUTOLINT-DRAWER-9: collectFirstViewData embeds auto_lint into first_view

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectFirstViewData,
  walkLiveWikiPages,
  loadAutoLintReport,
  FIRST_VIEW_SCHEMA_VERSION,
  AUTO_LINT_SCHEMA_VERSION,
  _internals,
} from '../mcp/lib/visualizer-data.mjs';

// ───────────── mock health data ─────────────
// collectHealthMetrics(vault) が返す shape を最小限再現
function makeMockHealth(overrides = {}) {
  const base = {
    schema_version: 2,
    generated_at: '2026-05-12T00:00:00.000Z',
    vault_pages_total: 155,
    metrics: {
      orphan: { count: 3, pages: ['concepts/foo.md', 'concepts/bar.md', 'analyses/baz.md'] },
      stale: { count: 8, threshold_days: 30, pages: [] },
      duplicate_title: { count: 1, groups: [] },
      hot_md_age: { exists: true, mtime_iso: '2026-05-11T00:00:00.000Z', age_seconds: 86400, age_human: '1d' },
      last_ingest: { exists: true, log_count: 200, mtime_iso: '2026-05-11T20:00:00.000Z', age_seconds: 14400, age_human: '4h' },
      unprocessed_logs: { count: 7, sample_paths: [], sample_truncated: false },
      broken_wikilink: {
        count: 21,
        samples: [
          { source: 'concepts/a.md', target: 'missing-1' },
          { source: 'concepts/b.md', target: 'missing-2' },
        ],
        sample_truncated: false,
      },
      source_sha256_duplicate: {
        count: 2,
        groups: [
          { source_sha256: 'aaaa', paths: ['summaries/x.md', 'summaries/y.md'] },
          { source_sha256: 'bbbb', paths: ['summaries/z.md', 'summaries/w.md'] },
        ],
      },
      pages_warm_zone: {
        count: 12,
        lower_days: 7,
        upper_days: 30,
        pages: [{ rel: 'concepts/warm1.md', age_days: 14, updated: '2026-04-28' }],
      },
      page_count_by_type: {
        total: 155,
        by_type: { concept: 40, project: 8, decision: 12, summary: 70, analysis: 15, other: 10 },
      },
      summaries_growth_rate: {
        vault_is_git: true,
        day_7: { added: 14, per_day: 2.0 },
        day_30: { added: 45, per_day: 1.5 },
      },
    },
    next_actions: [],
  };
  return { ...base, ...overrides };
}

// snapshots: visualizer.mjs が build した shape を最小限再現 (newest first)。
// 各 page には wikilinks (outgoing target 名 array) を持たせる — buildGraphPreview の
// degree 計算が page.wikilinks 経由になったため必須 (snapshot 経由でも live walk 経由でも同形)。
function makeMockSnapshots() {
  return [
    {
      sha: 'a'.repeat(40),
      shortSha: 'aaaaaaa',
      timestamp: 1715472000000,
      author: 'tester',
      subject: 'latest commit',
      pages: [
        { name: 'index', type: 'index', tags: [], title: 'Index', path: 'wiki/index.md', wikilinks: ['jwt', 'oauth'] },
        { name: 'jwt', type: 'concept', tags: ['auth'], title: 'JWT', path: 'wiki/concepts/jwt.md', wikilinks: ['oauth'] },
        { name: 'oauth', type: 'concept', tags: ['auth'], title: 'OAuth', path: 'wiki/concepts/oauth.md', wikilinks: ['jwt'] },
        { name: 'kioku', type: 'project', tags: [], title: 'KIOKU', path: 'wiki/projects/kioku.md', wikilinks: [] },
        { name: 'use-postgres', type: 'decision', tags: [], title: 'Use Postgres', path: 'wiki/decisions/use-postgres.md', wikilinks: [] },
      ],
      links: [
        { from: 'index', to: 'jwt' },
        { from: 'index', to: 'oauth' },
        { from: 'jwt', to: 'oauth' },
        { from: 'oauth', to: 'jwt' },
      ],
      truncated: false,
      error: null,
    },
  ];
}

describe('visualizer-data.mjs — Phase 1 v0.8 first view', () => {
  test('BLUE-VIZ-FIRSTVIEW-1: vault_overview data shape', async () => {
    const result = await collectFirstViewData('/dummy', {
      health: makeMockHealth(),
      snapshots: makeMockSnapshots(),
      now: new Date('2026-05-12T00:00:00.000Z'),
    });
    assert.equal(result.schema_version, FIRST_VIEW_SCHEMA_VERSION);
    assert.ok(result.vault_overview, 'vault_overview missing');
    assert.equal(result.vault_overview.pages_total, 155);
    assert.ok(result.vault_overview.summaries_growth, 'summaries_growth missing');
    assert.equal(result.vault_overview.summaries_growth.vault_is_git, true);
    assert.equal(result.vault_overview.summaries_growth.day_7.added, 14);
    assert.equal(result.vault_overview.summaries_growth.day_30.added, 45);
    assert.ok(result.vault_overview.page_count_by_type, 'page_count_by_type missing');
    assert.equal(result.vault_overview.page_count_by_type.total, 155);
    assert.equal(result.vault_overview.page_count_by_type.by_type.concept, 40);
    assert.equal(result.vault_overview.page_count_by_type.by_type.summary, 70);
  });

  test('BLUE-VIZ-FIRSTVIEW-2: health_focus data shape', async () => {
    const result = await collectFirstViewData('/dummy', {
      health: makeMockHealth(),
      snapshots: makeMockSnapshots(),
      now: new Date('2026-05-12T00:00:00.000Z'),
    });
    assert.ok(result.health_focus, 'health_focus missing');
    // broken_wikilink: count + samples (件数制限あり)
    assert.equal(result.health_focus.broken_wikilink.count, 21);
    assert.ok(Array.isArray(result.health_focus.broken_wikilink.samples));
    assert.ok(result.health_focus.broken_wikilink.samples.length <= 5,
      'broken_wikilink.samples should be capped to first 5 for compact display');
    // source_sha256_duplicate: count + groups
    assert.equal(result.health_focus.source_sha256_duplicate.count, 2);
    assert.ok(Array.isArray(result.health_focus.source_sha256_duplicate.groups));
    assert.ok(result.health_focus.source_sha256_duplicate.groups.length <= 5);
    // pages_warm_zone: count + lower_days + upper_days + pages
    assert.equal(result.health_focus.pages_warm_zone.count, 12);
    assert.equal(result.health_focus.pages_warm_zone.lower_days, 7);
    assert.equal(result.health_focus.pages_warm_zone.upper_days, 30);
    assert.ok(Array.isArray(result.health_focus.pages_warm_zone.pages));
  });

  test('BLUE-VIZ-FIRSTVIEW-3: graph_preview data (hot pages / active projects / recent decisions)', async () => {
    const result = await collectFirstViewData('/dummy', {
      health: makeMockHealth(),
      snapshots: makeMockSnapshots(),
      now: new Date('2026-05-12T00:00:00.000Z'),
    });
    assert.ok(result.graph_preview, 'graph_preview missing');
    assert.ok(Array.isArray(result.graph_preview.hot_pages), 'hot_pages should be array');
    assert.ok(Array.isArray(result.graph_preview.active_projects), 'active_projects should be array');
    assert.ok(Array.isArray(result.graph_preview.recent_decisions), 'recent_decisions should be array');

    // hot_pages: 最新 snapshot から wikilink degree でソートされた page
    // mock では oauth と jwt が degree=3 で最も hot
    assert.ok(result.graph_preview.hot_pages.length > 0, 'hot_pages should have entries when snapshots exist');
    const top = result.graph_preview.hot_pages[0];
    assert.ok(typeof top.name === 'string');
    assert.ok(typeof top.degree === 'number');

    // active_projects: type=project の page だけが入る
    for (const p of result.graph_preview.active_projects) {
      assert.equal(p.type ?? 'project', 'project',
        'active_projects must contain only type=project pages');
    }
    assert.ok(result.graph_preview.active_projects.some((p) => p.name === 'kioku'));

    // recent_decisions: type=decision の page だけが入る
    for (const p of result.graph_preview.recent_decisions) {
      assert.equal(p.type ?? 'decision', 'decision',
        'recent_decisions must contain only type=decision pages');
    }
    assert.ok(result.graph_preview.recent_decisions.some((p) => p.name === 'use-postgres'));
  });

  test('BLUE-VIZ-FIRSTVIEW-4: action_queue with priority + next_action (cap 5)', async () => {
    const result = await collectFirstViewData('/dummy', {
      health: makeMockHealth(),
      snapshots: makeMockSnapshots(),
      now: new Date('2026-05-12T00:00:00.000Z'),
    });
    assert.ok(Array.isArray(result.action_queue), 'action_queue must be an array');
    assert.ok(result.action_queue.length >= 3, 'mock has 21 broken + 2 sha256dup + 12 warm + 8 stale + 7 unprocessed_logs + 3 orphan + 1 dup_title → expect ≥ 3 items');
    assert.ok(result.action_queue.length <= 5, 'action_queue must be capped at 5');

    // 各 item の必須 field
    for (const item of result.action_queue) {
      assert.ok(typeof item.priority === 'string', `priority missing: ${JSON.stringify(item)}`);
      assert.match(item.priority, /^P[0-2]$/, `priority must be P0/P1/P2: ${item.priority}`);
      assert.ok(typeof item.reason === 'string' && item.reason.length > 0, 'reason required');
      assert.ok(typeof item.next_action === 'string' && item.next_action.length > 0, 'next_action required');
    }

    // P0 (broken_wikilink + source_sha256_duplicate) が先頭に来る
    assert.equal(result.action_queue[0].priority, 'P0', 'highest priority item should be P0');

    // 健全な vault (mock to have 0 issues) → action_queue は空配列
    const healthyResult = await collectFirstViewData('/dummy', {
      health: makeMockHealth({
        metrics: {
          orphan: { count: 0, pages: [] },
          stale: { count: 0, threshold_days: 30, pages: [] },
          duplicate_title: { count: 0, groups: [] },
          hot_md_age: { exists: true, mtime_iso: '2026-05-12T00:00:00.000Z', age_seconds: 60, age_human: '1m' },
          last_ingest: { exists: true, log_count: 200, mtime_iso: '2026-05-12T00:00:00.000Z', age_seconds: 60, age_human: '1m' },
          unprocessed_logs: { count: 0, sample_paths: [], sample_truncated: false },
          broken_wikilink: { count: 0, samples: [], sample_truncated: false },
          source_sha256_duplicate: { count: 0, groups: [] },
          pages_warm_zone: { count: 0, lower_days: 7, upper_days: 30, pages: [] },
          page_count_by_type: { total: 155, by_type: { concept: 40 } },
          summaries_growth_rate: { vault_is_git: true, day_7: { added: 5, per_day: 0.7 }, day_30: { added: 20, per_day: 0.67 } },
        },
      }),
      snapshots: makeMockSnapshots(),
      now: new Date('2026-05-12T00:00:00.000Z'),
    });
    assert.equal(healthyResult.action_queue.length, 0, 'healthy vault → empty action queue');
  });

  test('BLUE-VIZ-FIRSTVIEW-5: first_view schema is isolated from existing snapshot top-level fields', async () => {
    const result = await collectFirstViewData('/dummy', {
      health: makeMockHealth(),
      snapshots: makeMockSnapshots(),
      now: new Date('2026-05-12T00:00:00.000Z'),
    });
    // visualizer.mjs の data blob top-level field (Timeline/Diff が依存する) と
    // 衝突しないことを保証
    assert.ok(!('snapshots' in result), 'first_view must not include top-level "snapshots"');
    assert.ok(!('commits_total' in result), 'first_view must not include top-level "commits_total"');
    assert.ok(!('since' in result), 'first_view must not include top-level "since"');
    assert.ok(!('vault_name' in result), 'first_view must not include top-level "vault_name"');
    assert.ok(!('history_truncated' in result), 'first_view must not include top-level "history_truncated"');

    // first_view 内 field は 4 layer ordering で並ぶ
    const keys = Object.keys(result);
    const layerKeys = keys.filter((k) => ['vault_overview', 'health_focus', 'graph_preview', 'action_queue'].includes(k));
    assert.deepEqual(layerKeys, ['vault_overview', 'health_focus', 'graph_preview', 'action_queue'],
      '4 layer must appear in spec ordering: overview → health → graph → action');
  });

  test('BLUE-VIZ-FIRSTVIEW-empty-snapshots: graph_preview gracefully empty when no snapshots', async () => {
    const result = await collectFirstViewData('/dummy', {
      health: makeMockHealth(),
      snapshots: [],
      now: new Date('2026-05-12T00:00:00.000Z'),
    });
    assert.deepEqual(result.graph_preview.hot_pages, []);
    assert.deepEqual(result.graph_preview.active_projects, []);
    assert.deepEqual(result.graph_preview.recent_decisions, []);
  });

  test('BLUE-VIZ-FIRSTVIEW-internals: cap constants exported for downstream tests', () => {
    assert.ok(typeof _internals === 'object' && _internals !== null);
    assert.ok(typeof _internals.HOT_PAGES_LIMIT === 'number');
    assert.ok(typeof _internals.ACTION_QUEUE_MAX === 'number');
    assert.equal(_internals.ACTION_QUEUE_MAX, 5);
  });

  // ───────────────────────── Phase 2: Health overlay integration ─────────────────────────

  test('BLUE-VIZ-HEALTH-OVERLAY-1: broken_wikilink.clusters group sources by target', async () => {
    const result = await collectFirstViewData('/dummy', {
      health: makeMockHealth({
        metrics: {
          ...makeMockHealth().metrics,
          broken_wikilink: {
            count: 5,
            samples: [
              { source: 'concepts/a.md', target: 'missing-x' },
              { source: 'concepts/b.md', target: 'missing-x' }, // same target
              { source: 'concepts/c.md', target: 'missing-y' },
              { source: 'analyses/d.md', target: 'missing-x' }, // again same target
              { source: 'bugs/e.md', target: 'missing-z' },
            ],
            sample_truncated: false,
          },
        },
      }),
      snapshots: makeMockSnapshots(),
      now: new Date('2026-05-12T00:00:00.000Z'),
    });
    assert.ok(result.health_focus.broken_wikilink.clusters,
      'broken_wikilink.clusters field required for Phase 2 merge candidate view');
    const clusters = result.health_focus.broken_wikilink.clusters;
    assert.ok(Array.isArray(clusters));
    // target 'missing-x' は 3 source、'missing-y' は 1、'missing-z' は 1 → 3 cluster
    assert.equal(clusters.length, 3);
    const missingX = clusters.find((c) => c.target === 'missing-x');
    assert.ok(missingX, 'missing-x cluster present');
    assert.equal(missingX.sources.length, 3, 'missing-x has 3 source pages');
    assert.equal(missingX.inbound_broken_count, 3, 'inbound_broken_count = sources.length');
    // sort 順は inbound_broken_count desc → missing-x が先頭
    assert.equal(clusters[0].target, 'missing-x', 'most-referenced broken target sorted first');
  });

  test('BLUE-VIZ-HEALTH-OVERLAY-2: source_sha256_duplicate.groups expose merge candidate paths', async () => {
    const result = await collectFirstViewData('/dummy', {
      health: makeMockHealth(),
      snapshots: makeMockSnapshots(),
      now: new Date('2026-05-12T00:00:00.000Z'),
    });
    const groups = result.health_focus.source_sha256_duplicate.groups;
    assert.ok(Array.isArray(groups));
    for (const g of groups) {
      assert.ok(typeof g.source_sha256 === 'string' && g.source_sha256.length > 0);
      assert.ok(Array.isArray(g.paths) && g.paths.length >= 2, '同一 sha256 で 2+ path = merge candidate');
    }
    assert.equal(result.health_focus.source_sha256_duplicate.count, 2);
  });

  test('BLUE-VIZ-HEALTH-OVERLAY-3: pages_warm_zone.distribution exposes fresh/warm/stale 3 bucket', async () => {
    const result = await collectFirstViewData('/dummy', {
      health: makeMockHealth(),
      snapshots: makeMockSnapshots(),
      now: new Date('2026-05-12T00:00:00.000Z'),
    });
    const dist = result.health_focus.pages_warm_zone.distribution;
    assert.ok(dist, 'pages_warm_zone.distribution required for gradient bar');
    // mock: total=155, stale=8, warm=12
    //   fresh ≈ total - stale - warm = 135 (approximation since system pages を排除し切れない)
    assert.equal(dist.warm, 12, 'warm = pages_warm_zone.count');
    assert.equal(dist.stale, 8, 'stale = stale.count');
    assert.equal(typeof dist.fresh, 'number', 'fresh は number');
    assert.ok(dist.fresh >= 0, 'fresh は non-negative');
    assert.equal(dist.fresh + dist.warm + dist.stale, dist.total_classified,
      'fresh + warm + stale must equal total_classified');
  });

  test('BLUE-VIZ-HEALTH-OVERLAY-4: page_count_by_type chart-friendly sorted_entries', async () => {
    const result = await collectFirstViewData('/dummy', {
      health: makeMockHealth(),
      snapshots: makeMockSnapshots(),
      now: new Date('2026-05-12T00:00:00.000Z'),
    });
    const pct = result.vault_overview.page_count_by_type;
    // existing fields: total, by_type
    assert.equal(pct.total, 155);
    assert.ok(pct.by_type.summary === 70);
    // Phase 2: sorted_entries で chart rendering 側が再 sort せずに済む
    assert.ok(Array.isArray(pct.sorted_entries), 'sorted_entries field required for compact bar chart');
    assert.ok(pct.sorted_entries.length > 0);
    for (const e of pct.sorted_entries) {
      assert.ok(Array.isArray(e) && e.length === 2);
      assert.equal(typeof e[0], 'string');
      assert.equal(typeof e[1], 'number');
    }
    // descending order
    for (let i = 1; i < pct.sorted_entries.length; i += 1) {
      assert.ok(pct.sorted_entries[i - 1][1] >= pct.sorted_entries[i][1],
        `sorted_entries should be descending by count: ${JSON.stringify(pct.sorted_entries)}`);
    }
    // sum of values must equal total
    const sumVal = pct.sorted_entries.reduce((s, e) => s + e[1], 0);
    assert.equal(sumVal, pct.total, 'sum(sorted_entries) === total');
  });

  test('BLUE-VIZ-HEALTH-OVERLAY-5: summaries_growth_rate sparkline data preserved', async () => {
    const result = await collectFirstViewData('/dummy', {
      health: makeMockHealth(),
      snapshots: makeMockSnapshots(),
      now: new Date('2026-05-12T00:00:00.000Z'),
    });
    const g = result.vault_overview.summaries_growth;
    assert.equal(g.vault_is_git, true);
    assert.equal(g.day_7.added, 14);
    assert.equal(g.day_7.per_day, 2.0);
    assert.equal(g.day_30.added, 45);
    assert.equal(g.day_30.per_day, 1.5);
    // non-git vault では vault_is_git=false で graceful (sparkline 側で「n/a」表示)
    const ngResult = await collectFirstViewData('/dummy', {
      health: makeMockHealth({
        metrics: {
          ...makeMockHealth().metrics,
          summaries_growth_rate: { vault_is_git: false, day_7: { added: 0, per_day: 0 }, day_30: { added: 0, per_day: 0 }, error: 'not_a_git_repo' },
        },
      }),
      snapshots: makeMockSnapshots(),
      now: new Date('2026-05-12T00:00:00.000Z'),
    });
    assert.equal(ngResult.vault_overview.summaries_growth.vault_is_git, false);
    assert.equal(ngResult.vault_overview.summaries_growth.error, 'not_a_git_repo');
  });

  test('BLUE-VIZ-HEALTH-OVERLAY-6: status_banner with 6 P1 metrics + severity classification', async () => {
    const result = await collectFirstViewData('/dummy', {
      health: makeMockHealth(),
      snapshots: makeMockSnapshots(),
      now: new Date('2026-05-12T00:00:00.000Z'),
    });
    const sb = result.status_banner;
    assert.ok(sb, 'status_banner field required for Phase 2');
    // 6 P1 metrics 全部 present
    assert.ok(sb.orphan);
    assert.ok(sb.stale);
    assert.ok(sb.duplicate_title);
    assert.ok(sb.hot_md_age);
    assert.ok(sb.last_ingest);
    assert.ok(sb.unprocessed_logs);

    // 各 metric は count or 相当 + severity
    for (const key of ['orphan', 'stale', 'duplicate_title', 'unprocessed_logs']) {
      assert.equal(typeof sb[key].count, 'number', `${key}.count should be number`);
      assert.match(sb[key].severity, /^(ok|info|warn|danger)$/);
    }

    // mock values: orphan=3 → info, stale=8 → warn (>5), duplicate_title=1 → warn,
    //   hot_md_age age_seconds=86400 (1d) → ok (under 7d), last_ingest age_seconds=14400 (4h) → ok (under 24h),
    //   unprocessed_logs=7 → warn (>5)
    assert.equal(sb.orphan.severity, 'info', 'orphan count=3 > 0 → info');
    assert.equal(sb.stale.severity, 'warn', 'stale count=8 > 5 → warn');
    assert.equal(sb.duplicate_title.severity, 'warn', 'duplicate_title count>0 → warn');
    assert.equal(sb.hot_md_age.severity, 'ok', 'hot_md_age 1d < 7d threshold → ok');
    assert.equal(sb.last_ingest.severity, 'ok', 'last_ingest 4h < 24h threshold → ok');
    assert.equal(sb.unprocessed_logs.severity, 'warn', 'unprocessed_logs 7 > 5 → warn');

    // healthy vault test
    const healthyResult = await collectFirstViewData('/dummy', {
      health: makeMockHealth({
        metrics: {
          orphan: { count: 0, pages: [] },
          stale: { count: 0, threshold_days: 30, pages: [] },
          duplicate_title: { count: 0, groups: [] },
          hot_md_age: { exists: true, mtime_iso: '2026-05-12T00:00:00.000Z', age_seconds: 60, age_human: '1m' },
          last_ingest: { exists: true, log_count: 200, mtime_iso: '2026-05-12T00:00:00.000Z', age_seconds: 60, age_human: '1m' },
          unprocessed_logs: { count: 0, sample_paths: [], sample_truncated: false },
          broken_wikilink: { count: 0, samples: [], sample_truncated: false },
          source_sha256_duplicate: { count: 0, groups: [] },
          pages_warm_zone: { count: 0, lower_days: 7, upper_days: 30, pages: [] },
          page_count_by_type: { total: 100, by_type: { concept: 100 } },
          summaries_growth_rate: { vault_is_git: true, day_7: { added: 1, per_day: 0.14 }, day_30: { added: 5, per_day: 0.17 } },
        },
      }),
      snapshots: makeMockSnapshots(),
      now: new Date('2026-05-12T00:00:00.000Z'),
    });
    for (const key of ['orphan', 'stale', 'duplicate_title', 'hot_md_age', 'last_ingest', 'unprocessed_logs']) {
      assert.equal(healthyResult.status_banner[key].severity, 'ok',
        `healthy vault: ${key} should be ok`);
    }
  });

  test('BLUE-VIZ-HEALTH-OVERLAY-7: auto_lint field is present in first_view (Phase 4 flip — was negative in Phase 2)', async () => {
    // Phase 2 では auto-lint output が first_view に含まれないことを negative assertion で固定していた。
    // Phase 4 で drawer 化したため契約を flip:
    //   - auto_lint field は first_view に必ず存在する (presence 契約)
    //   - report 不在 vault では auto_lint === null (graceful degrade)
    //   - report 存在 vault では object shape (BLUE-VIZ-AUTOLINT-DRAWER-* で検証)
    const result = await collectFirstViewData('/dummy', {
      health: makeMockHealth(),
      snapshots: makeMockSnapshots(),
      now: new Date('2026-05-12T00:00:00.000Z'),
    });
    assert.ok('auto_lint' in result, 'top-level auto_lint field must be present (Phase 4 drawer)');
    assert.equal(result.auto_lint, null,
      '/dummy vault has no wiki/lint-report.md → auto_lint must be null (graceful degrade)');
    // schema_version も Phase 4 で bump 済
    assert.equal(result.schema_version, FIRST_VIEW_SCHEMA_VERSION,
      'first_view schema_version reflects the Phase 4 const bump');
    assert.ok(FIRST_VIEW_SCHEMA_VERSION >= 2, 'Phase 4 bumps to schema 2');
  });

  // ───────────────────────── Phase 4 BLUE-VIZ-AUTOLINT-DRAWER-* (auto-lint drawer) ─────────────────────────

  // section 1-3 で 4 観点それぞれが 1 件以上 finding を持つ完全 report fixture
  function writeFullLintReport(vault) {
    const body = [
      '---',
      'title: Lint Report',
      'date: 2026-05-09',
      '---',
      '',
      '# Wiki Lint Report (2026-05-09)',
      '',
      '## 要約',
      '- 検出した問題の総数: 8',
      '- カテゴリ別の内訳: 矛盾 2 / splinter 1 / 専用ページ候補 2 / link gap 3',
      '',
      '## 概念の矛盾',
      '- hot.md TTL: concepts/hot-cache.md は 24h と書かれているが analyses/cache-rotation.md では 12h と記述、source が異なる',
      '- ingest schedule: cron で 1h と書かれているが scripts/auto-ingest.sh の実装は 30 min',
      '',
      '## 概念の splinter',
      '- agent の役割定義が wiki/concepts/agent-role.md と wiki/projects/multi-agent.md の両方に重複しているため merge 候補',
      '',
      '## 専用ページ候補',
      '- "prompt cache" が summaries/ 配下 4 ファイルで言及されているが wiki/concepts/ に専用ページ未昇格',
      '- "MCP transport" が source 3 件で繰り返されているが分散している',
      '',
      '## 意味的な相互リンク欠落',
      '- wiki/concepts/jwt.md と wiki/concepts/oauth.md は深く関連するが wikilink なし',
      '- wiki/decisions/use-postgres.md と wiki/analyses/db-perf.md は意味的に隣接するが link なし',
      '- wiki/concepts/cron.md と wiki/projects/auto-ingest.md は依存関係があるが片方向しか link なし',
      '',
      '## R1: Unicode 不可視文字 (prompt injection 監査)',
      '(該当なし — wiki/ 内のどの .md にも ZWSP / RTLO / SHY / BOM 等は検出されませんでした)',
      '',
    ].join('\n');
    return writeFile(join(vault, 'wiki', 'lint-report.md'), body);
  }

  test('BLUE-VIZ-AUTOLINT-DRAWER-1: loadAutoLintReport returns null when wiki/lint-report.md is missing', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'kioku-autolint-missing-'));
    try {
      await mkdir(join(vault, 'wiki'), { recursive: true });
      const result = await loadAutoLintReport(vault);
      assert.equal(result, null, 'no report file → null');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('BLUE-VIZ-AUTOLINT-DRAWER-2: 4 観点 sections are extracted with counts + samples', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'kioku-autolint-full-'));
    try {
      await mkdir(join(vault, 'wiki'), { recursive: true });
      await writeFullLintReport(vault);
      const result = await loadAutoLintReport(vault);
      assert.ok(result, 'parsed report returned');
      assert.equal(result.schema_version, AUTO_LINT_SCHEMA_VERSION);
      assert.equal(result.report_exists, true);
      assert.equal(result.source_path, 'wiki/lint-report.md');
      assert.equal(result.generated_at, '2026-05-09');

      const byKey = Object.fromEntries(result.categories.map((c) => [c.key, c]));
      // 4 観点全て present
      assert.ok(byKey.contradiction, 'contradiction category present');
      assert.ok(byKey.splinter, 'splinter category present');
      assert.ok(byKey.promotion_candidate, 'promotion_candidate category present');
      assert.ok(byKey.link_gap, 'link_gap category present');
      // count
      assert.equal(byKey.contradiction.count, 2);
      assert.equal(byKey.splinter.count, 1);
      assert.equal(byKey.promotion_candidate.count, 2);
      assert.equal(byKey.link_gap.count, 3);
      // total = 8
      assert.equal(result.total_findings, 8);
      // samples non-empty
      assert.ok(byKey.contradiction.samples[0].includes('hot.md TTL'),
        'contradiction first sample matches');
      assert.ok(byKey.link_gap.samples[0].includes('jwt.md'),
        'link_gap first sample matches');
      // count_estimated flag is true (LLM heuristic)
      assert.equal(byKey.contradiction.count_estimated, true);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('BLUE-VIZ-AUTOLINT-DRAWER-3: sample text is collapsed + truncated to 240 chars', async () => {
    const limit = _internals.AUTO_LINT_SAMPLE_MAX_CHARS;
    const longBullet = 'A'.repeat(limit + 50);
    const body = [
      '---', 'title: Lint Report', 'date: 2026-05-09', '---',
      '', '## 概念の矛盾',
      `- ${longBullet}`,
      '',
    ].join('\n');
    const vault = await mkdtemp(join(tmpdir(), 'kioku-autolint-trunc-'));
    try {
      await mkdir(join(vault, 'wiki'), { recursive: true });
      await writeFile(join(vault, 'wiki', 'lint-report.md'), body);
      const result = await loadAutoLintReport(vault);
      const sample = result.categories.find((c) => c.key === 'contradiction').samples[0];
      assert.equal(sample.length, limit, `sample length capped to ${limit}`);
      assert.ok(sample.endsWith('…'), 'truncation suffix added');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('BLUE-VIZ-AUTOLINT-DRAWER-4: sample_limit caps per-category at 3 samples', async () => {
    const limit = _internals.AUTO_LINT_SAMPLE_LIMIT;
    const bullets = Array.from({ length: limit + 4 }, (_, i) => `- finding #${i + 1}: detail`).join('\n');
    const body = [
      '---', 'title: Lint Report', 'date: 2026-05-09', '---',
      '', '## 意味的な相互リンク欠落',
      bullets,
      '',
    ].join('\n');
    const vault = await mkdtemp(join(tmpdir(), 'kioku-autolint-cap-'));
    try {
      await mkdir(join(vault, 'wiki'), { recursive: true });
      await writeFile(join(vault, 'wiki', 'lint-report.md'), body);
      const result = await loadAutoLintReport(vault);
      const cat = result.categories.find((c) => c.key === 'link_gap');
      assert.equal(cat.count, limit + 4, 'count reflects total findings');
      assert.equal(cat.samples.length, limit, 'samples capped at limit');
      assert.equal(cat.sample_truncated, true, 'sample_truncated flag set');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('BLUE-VIZ-AUTOLINT-DRAWER-5: "(検出なし)" markers produce count=0 + empty samples', async () => {
    const body = [
      '---', 'title: Lint Report', 'date: 2026-05-09', '---',
      '', '## 概念の矛盾',
      '(検出なし)',
      '',
      '## 概念の splinter',
      '該当なし',
      '',
      '## 専用ページ候補',
      'None',
      '',
      '## 意味的な相互リンク欠落',
      'n/a',
      '',
    ].join('\n');
    const vault = await mkdtemp(join(tmpdir(), 'kioku-autolint-nomarker-'));
    try {
      await mkdir(join(vault, 'wiki'), { recursive: true });
      await writeFile(join(vault, 'wiki', 'lint-report.md'), body);
      const result = await loadAutoLintReport(vault);
      assert.equal(result.total_findings, 0, '"検出なし" markers → no findings');
      for (const cat of result.categories) {
        assert.equal(cat.count, 0, `${cat.key} count is 0`);
        assert.deepEqual(cat.samples, [], `${cat.key} samples is empty array`);
      }
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('BLUE-VIZ-AUTOLINT-DRAWER-6: frontmatter date is extracted as generated_at (fallback to null when missing)', async () => {
    const body = [
      '# No frontmatter report',
      '',
      '## 概念の矛盾',
      '- some finding',
      '',
    ].join('\n');
    const vault = await mkdtemp(join(tmpdir(), 'kioku-autolint-nofront-'));
    try {
      await mkdir(join(vault, 'wiki'), { recursive: true });
      await writeFile(join(vault, 'wiki', 'lint-report.md'), body);
      const result = await loadAutoLintReport(vault);
      assert.equal(result.generated_at, null, 'no frontmatter → generated_at is null');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('BLUE-VIZ-AUTOLINT-DRAWER-7: malformed markdown without bullets falls back to paragraph parsing', async () => {
    const body = [
      '---', 'date: 2026-05-09', '---',
      '',
      '## 概念の矛盾',
      'paragraph 1: this is a free-form judgment finding without bullet syntax.',
      '',
      'paragraph 2: another finding, separated by blank line.',
      '',
    ].join('\n');
    const vault = await mkdtemp(join(tmpdir(), 'kioku-autolint-paragraph-'));
    try {
      await mkdir(join(vault, 'wiki'), { recursive: true });
      await writeFile(join(vault, 'wiki', 'lint-report.md'), body);
      const result = await loadAutoLintReport(vault);
      const cat = result.categories.find((c) => c.key === 'contradiction');
      assert.equal(cat.count, 2, 'paragraph fallback produces 2 findings');
      assert.ok(cat.samples[0].includes('paragraph 1'), 'first paragraph captured');
      assert.ok(cat.samples[1].includes('paragraph 2'), 'second paragraph captured');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('BLUE-VIZ-AUTOLINT-DRAWER-8: source_truncated flag is set when file exceeds AUTO_LINT_MAX_BYTES', async () => {
    const max = _internals.AUTO_LINT_MAX_BYTES;
    const padding = 'x'.repeat(max + 1024);
    const body = [
      '---', 'date: 2026-05-09', '---',
      '',
      '## 概念の矛盾',
      '- short finding',
      '',
      padding,
    ].join('\n');
    const vault = await mkdtemp(join(tmpdir(), 'kioku-autolint-trunc-bytes-'));
    try {
      await mkdir(join(vault, 'wiki'), { recursive: true });
      await writeFile(join(vault, 'wiki', 'lint-report.md'), body);
      const result = await loadAutoLintReport(vault);
      assert.equal(result.source_truncated, true, 'file > max → source_truncated true');
      // 早期セクションは引き続き parse できているはず
      const cat = result.categories.find((c) => c.key === 'contradiction');
      assert.ok(cat.count > 0, 'contradiction section is parsed before truncation cap');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('BLUE-VIZ-AUTOLINT-DRAWER-9: collectFirstViewData embeds auto_lint into first_view (positive contract)', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'kioku-autolint-embed-'));
    try {
      await mkdir(join(vault, 'wiki'), { recursive: true });
      await writeFullLintReport(vault);
      const result = await collectFirstViewData(vault, {
        health: makeMockHealth(),
        snapshots: makeMockSnapshots(),
        now: new Date('2026-05-12T00:00:00.000Z'),
      });
      assert.ok(result.auto_lint, 'auto_lint embedded');
      assert.equal(result.auto_lint.report_exists, true);
      assert.equal(result.auto_lint.categories.length, 4, '4 観点 categories');
      assert.ok(result.auto_lint.total_findings >= 8, 'total_findings reflects full report');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  // ───────────────────────── Phase 1 livewalk fallback test (placed after Phase 2) ─────────────────────────

  test('BLUE-VIZ-FIRSTVIEW-livewalk: live filesystem walk fallback for graph_preview', async () => {
    // real Vault が parent git repo の subdirectory にあると snapshot[0].pages が空に
    // なる pre-existing issue を補う fallback path。snapshot 空でも live walk で graph_preview
    // が機能する事を保証する。
    const tmpVault = await mkdtemp(join(tmpdir(), 'kioku-viz-livewalk-'));
    try {
      await mkdir(join(tmpVault, 'wiki', 'concepts'), { recursive: true });
      await mkdir(join(tmpVault, 'wiki', 'projects'), { recursive: true });
      await mkdir(join(tmpVault, 'wiki', 'decisions'), { recursive: true });
      // exclude dirs (must be filtered out by walkLiveWikiPages)
      await mkdir(join(tmpVault, 'wiki', '.archive'), { recursive: true });
      await mkdir(join(tmpVault, 'wiki', 'templates'), { recursive: true });
      await writeFile(join(tmpVault, 'wiki', 'index.md'), '---\ntype: index\ntitle: Index\n---\n\n# Index\n\n[[jwt]] [[oauth]]\n');
      await writeFile(join(tmpVault, 'wiki', 'concepts', 'jwt.md'), '---\ntitle: JWT\n---\n\n# JWT\n\n[[oauth]]\n');
      await writeFile(join(tmpVault, 'wiki', 'concepts', 'oauth.md'), '---\ntitle: OAuth\n---\n\n# OAuth\n\n[[jwt]]\n');
      await writeFile(join(tmpVault, 'wiki', 'projects', 'kioku.md'), '---\ntype: project\ntitle: KIOKU\n---\n\n# KIOKU\n');
      await writeFile(join(tmpVault, 'wiki', 'decisions', 'use-postgres.md'), '---\ntype: decision\ntitle: Use Postgres\n---\n\n# Use Postgres\n');
      // exclude dir 配下 — walk すべきでない
      await writeFile(join(tmpVault, 'wiki', '.archive', 'old.md'), '---\n---\n# Old\n');
      await writeFile(join(tmpVault, 'wiki', 'templates', 'tmpl.md'), '---\n---\n# Tmpl\n');

      const livePages = await walkLiveWikiPages(tmpVault);
      const names = livePages.map((p) => p.name).sort();
      assert.deepEqual(names, ['index', 'jwt', 'kioku', 'oauth', 'use-postgres'],
        'walkLiveWikiPages must walk wiki/ and exclude .archive/ + templates/');

      // type inference (path-based fallback) が効く
      const jwt = livePages.find((p) => p.name === 'jwt');
      assert.equal(jwt.type, 'concept', 'jwt.md under concepts/ should infer type=concept');
      const kioku = livePages.find((p) => p.name === 'kioku');
      assert.equal(kioku.type, 'project', 'frontmatter type=project preserved');
      const useP = livePages.find((p) => p.name === 'use-postgres');
      assert.equal(useP.type, 'decision');

      // collectFirstViewData が snapshot 空でも live walk fallback で graph_preview を生成
      const result = await collectFirstViewData(tmpVault, {
        health: makeMockHealth(),
        snapshots: [], // 意図的に空 → fallback to live walk
        now: new Date('2026-05-12T00:00:00.000Z'),
      });
      assert.ok(result.graph_preview.hot_pages.length > 0,
        'graph_preview should be populated via live walk fallback');
      assert.ok(result.graph_preview.active_projects.some((p) => p.name === 'kioku'),
        'active_projects must include kioku (live walk)');
      assert.ok(result.graph_preview.recent_decisions.some((p) => p.name === 'use-postgres'),
        'recent_decisions must include use-postgres (live walk)');

      // walkLiveWikiPages nonexistent path → 空配列 (graceful)
      const empty = await walkLiveWikiPages('/nonexistent-' + Date.now());
      assert.deepEqual(empty, []);
    } finally {
      await rm(tmpVault, { recursive: true, force: true });
    }
  });
});
