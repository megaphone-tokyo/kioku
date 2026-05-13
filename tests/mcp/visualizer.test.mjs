// visualizer.test.mjs — kioku_generate_viz (Phase D α V-2) のユニット/結合テスト
//
// 実行: node --test tools/claude-brain/tests/mcp/visualizer.test.mjs
//
// ケース (VIZ-T1 〜 VIZ-T9):
//   VIZ-T1: TOOL_DEF shape (name / title / description / inputShape)
//   VIZ-T2: 非 git vault → helpful error
//   VIZ-T3: 正常パス — git fixture で生成、HTML 内に data JSON 埋め込み確認 (schema_version=4 含む、Phase 4 で bump)
//   VIZ-T4: output_path validation — `.cache/viz/` prefix 以外は reject
//   VIZ-T5: embeddings=true は "deferred to v0.8" で reject
//   VIZ-T6: path traversal in output_path → boundary error
//   VIZ-T7: XSS hardening — script close tag が HTML 内で escape される
//   VIZ-T8: first_view 4 layer が data blob に埋め込まれる (Phase 1 v0.8 β)
//   VIZ-T9: Phase 2 health overlay elements (status banner + bar chart + sparkline + warm gradient + cluster) が HTML に存在 + Phase 4 で auto-lint drawer presence へ flip (旧 negative→positive)
//   VIZ-T10: Phase 3 lineage graph が data blob + HTML tab に embed される (Sprint 3 v0.8 β Phase 3)

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  VISUALIZER_TOOL_DEF,
  handleGenerateViz,
  _internals,
} from '../../mcp/tools/visualizer.mjs';

function runCmd(cwd, cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`));
    });
  });
}

async function hasGit() {
  return new Promise((resolve) => {
    const child = spawn('git', ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function makeFixtureVault() {
  const root = await mkdtemp(join(tmpdir(), 'kioku-viz-test-'));
  await runCmd(root, 'git', ['init', '-b', 'main']);
  await runCmd(root, 'git', ['config', 'user.email', 'test@example.com']);
  await runCmd(root, 'git', ['config', 'user.name', 'Test User']);
  await mkdir(join(root, 'wiki', 'concepts'), { recursive: true });
  await mkdir(join(root, '.cache'), { recursive: true });

  // 2 commit で history 作る
  await writeFile(
    join(root, 'wiki', 'index.md'),
    '---\ntype: index\ntitle: Index\n---\n\n# Index\n\n- [[concepts/jwt]]\n',
  );
  await writeFile(
    join(root, 'wiki', 'concepts', 'jwt.md'),
    '---\ntype: concept\ntags: [auth]\n---\n\n# JWT\n',
  );
  await runCmd(root, 'git', ['add', '-A']);
  await runCmd(root, 'git', ['commit', '-m', 'v1 initial wiki']);

  await new Promise((r) => setTimeout(r, 1100));
  await writeFile(
    join(root, 'wiki', 'concepts', 'oauth.md'),
    '---\ntype: concept\ntags: [auth, security]\n---\n\n# OAuth\n\n[[jwt]]\n',
  );
  await runCmd(root, 'git', ['add', '-A']);
  await runCmd(root, 'git', ['commit', '-m', 'v2 add oauth page']);
  return root;
}

describe('kioku_generate_viz (Phase D α V-2)', () => {
  let gitAvailable = true;

  before(async () => {
    gitAvailable = await hasGit();
  });

  test('VIZ-T1: TOOL_DEF shape', () => {
    assert.equal(VISUALIZER_TOOL_DEF.name, 'kioku_generate_viz');
    assert.ok(typeof VISUALIZER_TOOL_DEF.title === 'string' && VISUALIZER_TOOL_DEF.title.length > 0);
    assert.ok(typeof VISUALIZER_TOOL_DEF.description === 'string');
    assert.match(VISUALIZER_TOOL_DEF.description, /Timeline/);
    assert.match(VISUALIZER_TOOL_DEF.description, /Diff/);
    assert.ok(VISUALIZER_TOOL_DEF.inputShape);
    // zod schema 確認
    const shape = VISUALIZER_TOOL_DEF.inputShape;
    assert.ok(shape.output_path);
    assert.ok(shape.since);
    assert.ok(shape.max_commits);
    assert.ok(shape.embeddings);
  });

  test('VIZ-T2: 非 git vault → helpful error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kioku-viz-nongit-'));
    try {
      await mkdir(join(root, 'wiki'), { recursive: true });
      await mkdir(join(root, '.cache', 'viz'), { recursive: true });
      await assert.rejects(
        () => handleGenerateViz(root, {}),
        /not a git repository/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('VIZ-T3: 正常生成 — HTML + data JSON 埋め込み', async () => {
    if (!gitAvailable) return;
    const root = await makeFixtureVault();
    try {
      const res = await handleGenerateViz(root, {});
      assert.ok(res.path);
      assert.match(res.path, /\.cache\/viz\/wiki-graph\.html$/);
      assert.ok(res.commits >= 2);
      assert.ok(res.snapshots >= 2);
      assert.ok(Array.isArray(res.views));
      assert.ok(res.views.includes('timeline-player'));
      assert.ok(res.views.includes('diff-viewer'));

      // HTML 内容確認
      const html = await readFile(res.path, 'utf8');
      assert.match(html, /<!doctype html>/i);
      assert.match(html, /id="kioku-data"/);
      assert.ok(!html.includes('__KIOKU_VIZ_DATA__'), 'placeholder not replaced');

      // embed JSON を抽出して parse
      const m = html.match(/<script type="application\/json" id="kioku-data">([^<]*)<\/script>/);
      assert.ok(m, 'kioku-data script block missing');
      const parsed = JSON.parse(m[1]);
      assert.equal(parsed.schema_version, 4, 'schema_version bumped to 4 with Phase 4 auto-lint drawer');
      assert.ok(Array.isArray(parsed.snapshots));
      assert.ok(parsed.snapshots.length >= 2);
      // first_view field が存在 (Phase 1 v0.8 β、null 許容だが key 自体は present)
      assert.ok('first_view' in parsed, 'first_view top-level field missing');
      assert.ok('first_view_error' in parsed, 'first_view_error top-level field missing');
      // lineage field が存在 (Phase 3、null 許容だが key 自体は present)
      assert.ok('lineage' in parsed, 'lineage top-level field missing');
      assert.ok('lineage_error' in parsed, 'lineage_error top-level field missing');
      // snapshot に body が含まれていないこと (plan P1 絶対契約)
      for (const s of parsed.snapshots) {
        for (const p of s.pages) {
          assert.ok(!('body' in p), `page body leaked: ${p.name}`);
          assert.ok(!('content' in p), `page content leaked: ${p.name}`);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('VIZ-T4: output_path validation — .cache/viz/ prefix 必須', async () => {
    if (!gitAvailable) return;
    const root = await makeFixtureVault();
    try {
      // wiki/ への書き込みは禁止
      await assert.rejects(
        () => handleGenerateViz(root, { output_path: 'wiki/evil.html' }),
        /must start with/,
      );
      // raw-sources/ も禁止
      await assert.rejects(
        () => handleGenerateViz(root, { output_path: 'raw-sources/x.html' }),
        /must start with/,
      );
      // .html 以外の拡張子 reject
      await assert.rejects(
        () => handleGenerateViz(root, { output_path: '.cache/viz/foo.txt' }),
        /must end with \.html/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('VIZ-T5: embeddings=true は deferred to v0.8 で reject', async () => {
    if (!gitAvailable) return;
    const root = await makeFixtureVault();
    try {
      await assert.rejects(
        () => handleGenerateViz(root, { embeddings: true }),
        /deferred to v0\.8/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('VIZ-T6: path traversal in output_path → boundary error', async () => {
    if (!gitAvailable) return;
    const root = await makeFixtureVault();
    try {
      // 前半は prefix check で落ちるが、allow-list 通過後の path traversal は assertInsideBase で catch
      await assert.rejects(
        () => handleGenerateViz(root, { output_path: '.cache/viz/../wiki/evil.html' }),
        /invalid output_path|path.*boundary|path traversal/i,
      );
      await assert.rejects(
        () => handleGenerateViz(root, { output_path: '.cache/viz//etc/passwd.html' }),
        /invalid output_path|path.*boundary|unsafe/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('VIZ-T7: XSS hardening — safeJsonForScript が </ を escape', () => {
    const { safeJsonForScript } = _internals;
    // script close tag を含む文字列
    const malicious = { injected: 'hello</script><script>alert(1)</script>' };
    const out = safeJsonForScript(malicious);
    // </script> は escape されて生の `</` が残らないこと
    assert.ok(!out.includes('</script>'), 'raw </script> leaked');
    assert.ok(out.includes('\\u003c/script>'), 'closing tag not escaped');
    // JSON.parse しても元データに戻ること (escape 後も valid JSON)
    assert.deepEqual(JSON.parse(out), malicious);
  });

  test('VIZ-T9: Phase 2 health overlay elements (banner + chart + sparkline + warm gradient + cluster) + Phase 4 auto-lint drawer presence (flipped)', async () => {
    if (!gitAvailable) return;
    const root = await makeFixtureVault();
    try {
      const res = await handleGenerateViz(root, {});
      const html = await readFile(res.path, 'utf8');
      const m = html.match(/<script type="application\/json" id="kioku-data">([^<]*)<\/script>/);
      const parsed = JSON.parse(m[1]);

      // Phase 2 data shapes in first_view
      assert.ok(parsed.first_view.status_banner, 'status_banner field present');
      assert.ok(parsed.first_view.status_banner.orphan, 'status_banner.orphan present');
      assert.ok(parsed.first_view.status_banner.stale, 'status_banner.stale present');
      assert.ok(parsed.first_view.status_banner.duplicate_title, 'status_banner.duplicate_title present');
      assert.ok(parsed.first_view.status_banner.hot_md_age, 'status_banner.hot_md_age present');
      assert.ok(parsed.first_view.status_banner.last_ingest, 'status_banner.last_ingest present');
      assert.ok(parsed.first_view.status_banner.unprocessed_logs, 'status_banner.unprocessed_logs present');

      assert.ok(Array.isArray(parsed.first_view.vault_overview.page_count_by_type.sorted_entries),
        'sorted_entries field present for bar chart');
      assert.ok(parsed.first_view.health_focus.pages_warm_zone.distribution,
        'pages_warm_zone.distribution present for gradient');
      assert.ok(Array.isArray(parsed.first_view.health_focus.broken_wikilink.clusters),
        'broken_wikilink.clusters present for cluster view');

      // Phase 2 HTML elements:
      //   - DOM container (status banner) は static HTML 上に存在
      //   - bar chart / sparkline / warm gradient / cluster は JS で動的生成、
      //     CSS class 定義の存在で render path が用意されていることを確認
      assert.match(html, /id="ov-status-banner"/, 'status banner container in HTML');
      // CSS class definitions (verify render path 用意済)
      assert.match(html, /\.status-banner\s*\{/, 'status-banner CSS rule defined');
      assert.match(html, /\.sb-chip\s*\{/, 'sb-chip CSS rule defined (JS が runtime に append)');
      assert.match(html, /\.bar-chart\s*\{/, 'bar-chart CSS rule defined for type distribution');
      assert.match(html, /\.sparkline\s*\{/, 'sparkline CSS rule defined for growth');
      assert.match(html, /\.warm-gradient\s*\{/, 'warm-gradient CSS rule defined for fresh/warm/stale');
      assert.match(html, /\.cluster-list\s*\{/, 'cluster-list CSS rule defined for broken/sha256');
      // severity class definitions (各 severity が CSS rule で配色定義済)
      assert.match(html, /\.sev-ok\b/, 'sev-ok CSS defined');
      assert.match(html, /\.sev-info\b/, 'sev-info CSS defined');
      assert.match(html, /\.sev-warn\b/, 'sev-warn CSS defined');
      assert.match(html, /\.sev-danger\b/, 'sev-danger CSS defined');
      // JS render path mentions (chip creation, growth sparkline, gradient segment)
      assert.match(html, /createElement\("div"\)/, 'render path uses createElement');
      assert.match(html, /sb-chip sev-/, 'JS appends sb-chip with severity class');
      assert.match(html, /wg-seg /, 'JS creates warm gradient segments');
      assert.match(html, /cluster-item/, 'JS creates cluster items');

      // Phase 4 flip: auto-lint drawer is now present (was negative in Phase 2)
      // - first_view contains auto_lint field (graceful null when no wiki/lint-report.md)
      // - HTML contains the 5th card container (ov-quality-notes) + CSS rules for drawer
      // - fixture vault has no lint-report.md → auto_lint === null, renders "未実行" message
      assert.ok('auto_lint' in parsed.first_view,
        'auto_lint field is present in first_view (Phase 4 drawer)');
      assert.equal(parsed.first_view.auto_lint, null,
        'fixture vault has no wiki/lint-report.md → auto_lint is null (graceful)');

      // HTML side: drawer card + CSS rules for renderQualityNotes
      assert.match(html, /id="ov-quality-notes"/, 'quality-notes card container in HTML');
      assert.match(html, /\.qn-cat\s*\{/, 'qn-cat CSS rule defined');
      assert.match(html, /\.qn-samples\s*\{/, 'qn-samples CSS rule defined');
      assert.match(html, /\.qn-missing\s*\{/, 'qn-missing CSS rule defined for empty state');
      assert.match(html, /Quality notes \(auto-lint\)/, 'card heading text in template');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('VIZ-T8: first_view 4 layer ordering が data blob に埋め込まれる (Phase 1 v0.8 β)', async () => {
    if (!gitAvailable) return;
    const root = await makeFixtureVault();
    try {
      const res = await handleGenerateViz(root, {});
      // 返り値 shape — Phase 1 で追加された field + Phase 3 で lineage tab 追加
      assert.ok(Array.isArray(res.views));
      assert.deepEqual(res.views, ['overview', 'timeline-player', 'diff-viewer', 'lineage'],
        'overview + lineage を含む 4 view が宣言される (Phase 3)');
      assert.equal(typeof res.first_view_present, 'boolean');
      assert.ok(res.first_view_present, 'fixture vault でも first_view は計算成功するはず');
      assert.equal(res.first_view_error, null);

      // HTML 内 first_view 4 layer
      const html = await readFile(res.path, 'utf8');
      const m = html.match(/<script type="application\/json" id="kioku-data">([^<]*)<\/script>/);
      const parsed = JSON.parse(m[1]);
      assert.ok(parsed.first_view, 'first_view must be populated');
      assert.equal(parsed.first_view.schema_version, 2,
        'first_view schema_version bumped to 2 in Phase 4 (auto_lint field added)');
      // 4 layer 順序 (codex doc Axis 3)
      assert.ok(parsed.first_view.vault_overview, 'layer 1 vault_overview');
      assert.ok(parsed.first_view.health_focus, 'layer 2 health_focus');
      assert.ok(parsed.first_view.graph_preview, 'layer 3 graph_preview');
      assert.ok(Array.isArray(parsed.first_view.action_queue), 'layer 4 action_queue');

      // vault_overview: pages_total が fixture の page 数 (≥ 3) と整合
      assert.ok(parsed.first_view.vault_overview.pages_total >= 3,
        `expected ≥ 3 pages in fixture, got ${parsed.first_view.vault_overview.pages_total}`);
      // page_count_by_type は concept type を含む (fixture に concepts/ あり)
      assert.ok(parsed.first_view.vault_overview.page_count_by_type.by_type.concept >= 2,
        'fixture has 2+ concept pages');

      // HTML 自体に Overview tab が存在 (default active)
      assert.match(html, /id="tab-overview"[^>]*class="active"/);
      assert.match(html, /id="view-overview"[^>]*class="view active"/);

      // body 漏洩防止契約は first_view でも継承 (snapshot.pages も pages_total も body を含まない)
      // — health metrics は frontmatter 経由なので body は触らない設計
      assert.ok(!JSON.stringify(parsed.first_view).includes('"body"'),
        'first_view must not leak page body');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('VIZ-T10: Phase 3 lineage graph embeds 3-layer nodes + 5 edge kinds + HTML tab/CSS', async () => {
    if (!gitAvailable) return;
    const root = await makeFixtureVault();
    try {
      // Add raw-sources + a summary referencing them so the fixture exercises lineage paths.
      await mkdir(join(root, 'raw-sources', 'pdf'), { recursive: true });
      await mkdir(join(root, 'wiki', 'summaries'), { recursive: true });
      await writeFile(join(root, 'raw-sources', 'pdf', 'jwt.pdf'), '%PDF fake');
      await writeFile(
        join(root, 'wiki', 'summaries', 'jwt-summary.md'),
        '---\nsource_sha256: ' + 'a'.repeat(64) + '\nderived_from: raw-sources/pdf/jwt.pdf\n---\n\n# jwt summary\n',
      );

      const res = await handleGenerateViz(root, {});
      // Return value shape
      assert.equal(res.lineage_present, true, 'lineage_present=true for non-empty vault');
      assert.equal(res.lineage_error, null);
      assert.ok(res.lineage_totals);
      assert.ok(res.lineage_totals.nodes >= 4, 'wiki + summary + raw nodes >= 4');

      const html = await readFile(res.path, 'utf8');
      const m = html.match(/<script type="application\/json" id="kioku-data">([^<]*)<\/script>/);
      const parsed = JSON.parse(m[1]);
      assert.ok(parsed.lineage, 'lineage embedded in inline JSON');
      assert.equal(parsed.lineage.schema_version, 1);
      assert.match(parsed.lineage.hint_note, /estimated lineage/i);
      // 3 layer classification on nodes
      const layers = new Set((parsed.lineage.nodes || []).map((n) => n.layer));
      assert.ok(layers.has('raw'), 'raw layer present');
      assert.ok(layers.has('summary'), 'summary layer present');
      assert.ok(layers.has('wiki'), 'wiki layer present');
      // hint_summary has 5 edge kinds
      assert.deepEqual(
        Object.keys(parsed.lineage.hint_summary).sort(),
        ['derived_from', 'filename', 'sha256', 'time', 'wikilink'],
      );
      // derived_from + filename edges expected for jwt-summary fixture
      const edges = parsed.lineage.edges || [];
      const derivedHit = edges.find((e) => e.kind === 'derived_from'
        && e.source === 'wiki:summaries/jwt-summary.md'
        && e.target === 'raw:pdf/jwt.pdf');
      assert.ok(derivedHit, 'derived_from edge from summary to raw pdf expected');

      // body 漏洩契約継承
      assert.ok(!JSON.stringify(parsed.lineage).includes('"body"'),
        'lineage must not leak page body');
      assert.ok(!JSON.stringify(parsed.lineage).includes('"text"'),
        'lineage must not leak raw text');

      // HTML side: Lineage tab + view section + CSS hooks
      assert.match(html, /id="tab-lineage"/, 'Lineage tab button in HTML');
      assert.match(html, /id="view-lineage"/, 'Lineage view section in HTML');
      assert.match(html, /\.ln-banner\s*\{/, 'ln-banner CSS rule defined');
      assert.match(html, /\.ln-node-row\s*\{/, 'ln-node-row CSS rule defined');
      assert.match(html, /\.ln-edge-chip\s*\{/, 'ln-edge-chip CSS rule defined');
      assert.match(html, /\.ln-layer-raw\b/, 'raw layer pill style defined');
      assert.match(html, /\.ln-layer-summary\b/, 'summary layer pill style defined');
      assert.match(html, /\.ln-layer-wiki\b/, 'wiki layer pill style defined');
      // JS render path
      assert.match(html, /renderLineage\s*\(/, 'renderLineage JS function called');
      assert.match(html, /estimated lineage/, 'best-effort disclosure text in JS');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
