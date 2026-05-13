// tools-visualizer-screenshot.test.mjs — Sprint 3 v0.8 β Phase 4
//
// CI screenshot regression test: empty / small fixture Vault で kioku_generate_viz が
// 破綻なく動き、screenshot 撮影に必要な DOM containers / data shape / drawer 要素が揃って
// いることを assert する。実 screenshot は撮らない (headless browser 依存を持ち込まない
// = Node 18+ stdlib only 原則 §「Hook スクリプトは外部依存を入れない」を test にも適用)
// が、screenshot 担保すべき要素を DOM / JSON shape として固定する。
//
// 実行: node --test tools/claude-brain/tests/mcp/tools-visualizer-screenshot.test.mjs
//
// ケース:
//   BLUE-VIZ-SCREENSHOT-1: empty Vault state 破綻なし (auto-lint drawer "未実行" 案内)
//   BLUE-VIZ-SCREENSHOT-2: small Vault で全 view 動作 (Overview/Timeline/Diff/Lineage)
//   BLUE-VIZ-SCREENSHOT-3: auto-lint drawer 4 観点表示 (small Vault fixture lint-report.md)
//   BLUE-VIZ-SCREENSHOT-4: 既存 Timeline Player / Diff Viewer regression (Phase D α 維持)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

import { handleGenerateViz } from '../../mcp/tools/visualizer.mjs';
import { cloneEmptyVault, cloneSmallVault, disposeFixtureVault } from '../fixtures/visualizer-vaults.mjs';

// git が利用可能でなければ skip — visualizer は git log で commit を集めるので git 必須。
const gitAvailable = spawnSync('git', ['--version']).status === 0;

function parseDataBlob(html) {
  const m = html.match(/<script type="application\/json" id="kioku-data">([^<]*)<\/script>/);
  assert.ok(m, 'data JSON script tag exists in HTML');
  return JSON.parse(m[1]);
}

describe('kioku_generate_viz — Sprint 3 v0.8 β Phase 4 screenshot regression', () => {

  test('BLUE-VIZ-SCREENSHOT-1: empty Vault state 破綻なし (drawer は "未実行" 案内のみ)', async () => {
    if (!gitAvailable) return;
    const vault = await cloneEmptyVault();
    try {
      const res = await handleGenerateViz(vault, {});
      // 生成自体は成功するはず (commit はある = git log 集計可)
      assert.equal(typeof res.path, 'string');
      assert.equal(res.first_view_error, null,
        'empty Vault でも first_view 計算は成功する (健全な状態の表現として first_view を返す)');
      assert.equal(res.auto_lint_present, false,
        'empty Vault には wiki/lint-report.md が無いので auto_lint_present は false');

      const html = await readFile(res.path, 'utf8');
      const data = parseDataBlob(html);
      // schema_version 確認 (Phase 4 で 4 に bump 済)
      assert.equal(data.schema_version, 4);
      // first_view present, auto_lint null (graceful)
      assert.ok(data.first_view, 'first_view object present');
      assert.equal(data.first_view.auto_lint, null,
        'no lint-report.md → auto_lint is null (graceful)');
      // graph_preview は空でも構わない (wiki/ が無い)
      assert.ok(data.first_view.graph_preview, 'graph_preview key exists');

      // HTML 側: 5 枚目 card markup が存在する (drawer 容器)
      assert.match(html, /id="ov-quality-notes"/);
      // "auto-lint 未実行" 案内のためのコマンド表記が HTML JS render path に含まれる
      assert.match(html, /bash scripts\/auto-lint\.sh/,
        'renderQualityNotes JS has command suggestion for empty state');
    } finally {
      await disposeFixtureVault(vault);
    }
  });

  test('BLUE-VIZ-SCREENSHOT-2: small Vault で全 view 動作 (Overview/Timeline/Diff/Lineage)', async () => {
    if (!gitAvailable) return;
    const vault = await cloneSmallVault();
    try {
      const res = await handleGenerateViz(vault, {});
      assert.equal(res.first_view_present, true);
      assert.equal(res.lineage_present, true,
        'small Vault でも lineage は計算成功 (raw-sources 0 でも summaries / wiki layer は存在)');
      assert.deepEqual(res.views, ['overview', 'timeline-player', 'diff-viewer', 'lineage']);
      assert.ok(res.snapshots >= 2,
        'small Vault は 2 commit ある → snapshot 2 以上で Timeline 切替テスト可');

      const html = await readFile(res.path, 'utf8');
      const data = parseDataBlob(html);
      assert.equal(data.first_view.schema_version, 2,
        'first_view schema_version は Phase 4 で 2 に bump');
      assert.ok(data.snapshots.length >= 2, 'snapshots array carries 2+ entries');

      // graph_preview: 5 page の中で hot_pages / active_projects / recent_decisions が
      // それぞれ classified されることを軽く確認 (validates fixture content)
      const gp = data.first_view.graph_preview;
      assert.ok(Array.isArray(gp.hot_pages) && gp.hot_pages.length > 0,
        'hot_pages non-empty for small vault');
      assert.ok(gp.active_projects.some((p) => p.name === 'kioku-mini'),
        'fixture project page kioku-mini classified into active_projects');
      assert.ok(gp.recent_decisions.some((p) => p.name === 'use-edge-runtime'),
        'fixture decision page use-edge-runtime classified into recent_decisions');
    } finally {
      await disposeFixtureVault(vault);
    }
  });

  test('BLUE-VIZ-SCREENSHOT-3: auto-lint drawer 4 観点表示 (small Vault lint-report.md 経由)', async () => {
    if (!gitAvailable) return;
    const vault = await cloneSmallVault();
    try {
      const res = await handleGenerateViz(vault, {});
      assert.equal(res.auto_lint_present, true,
        'small Vault は wiki/lint-report.md を持つので auto_lint_present=true');

      const html = await readFile(res.path, 'utf8');
      const data = parseDataBlob(html);
      const al = data.first_view.auto_lint;
      assert.ok(al, 'auto_lint object embedded in first_view');
      assert.equal(al.report_exists, true);
      assert.equal(al.source_path, 'wiki/lint-report.md');
      assert.equal(al.categories.length, 4, '4 観点 categories');

      const byKey = Object.fromEntries(al.categories.map((c) => [c.key, c]));
      // fixture lint-report.md は 4 観点各 1 finding
      assert.equal(byKey.contradiction.count, 1);
      assert.equal(byKey.splinter.count, 1);
      assert.equal(byKey.promotion_candidate.count, 1);
      assert.equal(byKey.link_gap.count, 1);
      assert.equal(al.total_findings, 4);

      // sample text are non-empty (fixture lint-report の本文がそのまま入っている)
      for (const cat of al.categories) {
        assert.ok(cat.samples.length === 1, `${cat.key} has 1 sample`);
        assert.ok(typeof cat.samples[0] === 'string' && cat.samples[0].length > 0,
          `${cat.key} sample is non-empty string`);
      }

      // HTML 側: drawer card + 4 観点 CSS + heading
      assert.match(html, /Quality notes \(auto-lint\)/);
      assert.match(html, /\.qn-cat\s*\{/);
      assert.match(html, /\.qn-samples\s*\{/);
      assert.match(html, /\.qn-disclosure\s*\{/);
    } finally {
      await disposeFixtureVault(vault);
    }
  });

  test('BLUE-VIZ-SCREENSHOT-4: 既存 Timeline / Diff regression (Phase D α 維持)', async () => {
    if (!gitAvailable) return;
    const vault = await cloneSmallVault();
    try {
      const res = await handleGenerateViz(vault, {});
      const html = await readFile(res.path, 'utf8');
      const data = parseDataBlob(html);

      // Timeline tab markup + JS path (V-2 で既に存在、Phase 4 で壊さない契約)
      assert.match(html, /id="tab-timeline"/);
      assert.match(html, /id="tp-slider"/);
      assert.match(html, /id="tp-play"/);

      // Diff tab markup + JS path
      assert.match(html, /id="tab-diff"/);
      assert.match(html, /id="dv-from"/);
      assert.match(html, /id="dv-to"/);
      assert.match(html, /id="dv-diff"/);

      // snapshots data structure 不変 (Timeline / Diff の入力)
      assert.ok(Array.isArray(data.snapshots), 'snapshots is array');
      for (const snap of data.snapshots) {
        assert.equal(typeof snap.sha, 'string');
        assert.equal(typeof snap.timestamp, 'number');
        assert.ok(Array.isArray(snap.pages), 'snapshot.pages is array');
        assert.ok(Array.isArray(snap.links), 'snapshot.links is array');
        // P1 security 契約: body フィールドは snapshot に含めない (VIZ-T3 と同じ assertion)
        for (const p of snap.pages) {
          assert.ok(!('body' in p), 'snapshot page must not include body');
          assert.ok(!('content' in p), 'snapshot page must not include content');
        }
      }

      // generation summary に既存 user 互換性のため必要な field が引き続き存在
      assert.equal(typeof res.commits, 'number');
      assert.equal(typeof res.latest_pages, 'number');
      assert.equal(typeof res.since, 'string');
    } finally {
      await disposeFixtureVault(vault);
    }
  });
});
