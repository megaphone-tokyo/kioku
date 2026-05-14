// web-ui-shell.test.mjs — Tests for mcp/lib/web-ui-shell.mjs
//
// Sprint 4 Phase 1 PR B (plan/claude/26051301_v0-9-phase1-impl-plan.md §「PR B」 L1070-1769) +
// Sprint 4 Phase 2 PR B2 (plan/claude/26051402_v0-9-phase2-qmd-search-impl-plan.md §「PR B2」).
//
// Test cases (10 BLUE-WEBUI-SHELL-* + INTEGRATION):
//   BLUE-WEBUI-SHELL-1   (Task B-1, Phase 2 update): shell_meta has 8 tabs
//                                    (6 enabled incl. Search + 2 placeholder)
//   BLUE-WEBUI-SHELL-2   (Task B-2): visualizer field = first_view + lineage + snapshots
//                                    (Sprint 3 data inline integration)
//   BLUE-WEBUI-SHELL-3   (Task B-3/B-4): dashboard field = 10 views from dashboard.base
//                                        (PR A renderBases consumption)
//   BLUE-WEBUI-SHELL-4   (Task B-5): buildShellHtml placeholder replacement +
//                                    security escape (`</script>` injection guard)
//   BLUE-WEBUI-SHELL-5   (Task B-6): shell HTML inlines Visualizer β 4 view
//                                    (Overview/Timeline/Diff/Lineage)
//   BLUE-WEBUI-SHELL-6   (Phase 2 PR B2): buildShellData includes search_index field
//   BLUE-WEBUI-SHELL-7   (Phase 2 PR B2): SHELL_TABS Search tab enabled === true
//   BLUE-WEBUI-SHELL-8   (Phase 2 PR B2): shell HTML contains tab-search +
//                                          Option C Tier 1/Tier 2 narrative
//   BLUE-WEBUI-SHELL-9   (Phase 2 PR B2): JSON island search_index strips body / abs_path
//   BLUE-WEBUI-SHELL-10  (Phase 2 PR B2): shell HTML self-contained (no fetch/XHR/etc.)
//   BLUE-WEBUI-SHELL-INTEGRATION    : end-to-end buildShellHtml on fixture vault

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildShellData,
  buildShellHtml,
  _internals,
} from '../mcp/lib/web-ui-shell.mjs';
import { cloneSmallVault, disposeFixtureVault } from './fixtures/visualizer-vaults.mjs';
import { withoutQmd } from './fixtures/test-helpers.mjs';

// Phase 2 PR B2: buildShellData now invokes buildSearchIndex → handleSearch,
// which spawns the `qmd` CLI when present. On developer machines with qmd
// installed (operating on the user's brain-wiki collection, not the test
// fixture vault), each subprocess can take 5-35 seconds, ballooning the
// suite to 10+ minutes. We scope a PATH neutralization around the actual
// buildShellData/buildShellHtml calls so qmd is invisible (handleSearch
// falls through to the in-process Node walker) but system `git` remains
// reachable for getFileHistory inside buildVisualizerData.
//
// withoutQmd は fixtures/test-helpers.mjs に統合 (LEARN#8b N=3 shared extract、
// PR B2 sibling: qmd-search-index.test.mjs / xss-search-result-escape.test.mjs).

// ---------------------------------------------------------------------------
// BLUE-WEBUI-SHELL-1: shell_meta has 8 tabs (6 enabled + 2 placeholder)
// (Phase 2 PR B2: Search tab promoted from placeholder to enabled.)
// ---------------------------------------------------------------------------

test('BLUE-WEBUI-SHELL-1: shell_meta has 8 tabs (6 enabled + 2 placeholder)', async () => {
  const vault = await cloneSmallVault();
  try {
    const data = await withoutQmd(() => buildShellData(vault, { mode: 'snapshot' }));
    assert.equal(data.schema_version, 1);
    assert.equal(data.shell_meta.mode, 'snapshot');
    assert.equal(data.shell_meta.default_tab, 'dashboard');
    assert.equal(data.shell_meta.tabs.length, 8);
    const enabled = data.shell_meta.tabs.filter((t) => t.enabled);
    assert.equal(enabled.length, 6);
    const enabledIds = enabled.map((t) => t.id).sort();
    assert.deepEqual(enabledIds, ['dashboard', 'diff', 'lineage', 'overview', 'search', 'timeline']);
    const placeholders = data.shell_meta.tabs.filter((t) => !t.enabled);
    assert.equal(placeholders.length, 2);
    const placeholderIds = placeholders.map((t) => t.id).sort();
    assert.deepEqual(placeholderIds, ['navigation', 'wikilink-graph']);
    for (const p of placeholders) {
      assert.ok(typeof p.gate === 'string' && p.gate.length > 0,
        `placeholder tab "${p.id}" must declare gate (phaseN)`);
    }
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(data.shell_meta.generated_at),
      'generated_at must be ISO timestamp');
    assert.ok(typeof data.shell_meta.vault_name === 'string' && data.shell_meta.vault_name.length > 0);
  } finally {
    await disposeFixtureVault(vault);
  }
});

test('BLUE-WEBUI-SHELL-1b: mode defaults to snapshot when unspecified', async () => {
  const vault = await cloneSmallVault();
  try {
    const data = await withoutQmd(() => buildShellData(vault));
    assert.equal(data.shell_meta.mode, 'snapshot');
  } finally {
    await disposeFixtureVault(vault);
  }
});

test('BLUE-WEBUI-SHELL-1c: mode=served accepted as opaque flag (Phase 2 placeholder)', async () => {
  const vault = await cloneSmallVault();
  try {
    const data = await withoutQmd(() => buildShellData(vault, { mode: 'served' }));
    assert.equal(data.shell_meta.mode, 'served');
  } finally {
    await disposeFixtureVault(vault);
  }
});

// ---------------------------------------------------------------------------
// BLUE-WEBUI-SHELL-2: visualizer field contains first_view + lineage + snapshots
// ---------------------------------------------------------------------------

test('BLUE-WEBUI-SHELL-2: visualizer field contains first_view + lineage + snapshots', async () => {
  const vault = await cloneSmallVault();
  try {
    const data = await withoutQmd(() => buildShellData(vault, { mode: 'snapshot', max_commits: 5 }));
    assert.equal(data.visualizer.schema_version, 4);
    assert.ok('first_view' in data.visualizer);
    assert.ok('lineage' in data.visualizer);
    assert.ok(Array.isArray(data.visualizer.snapshots),
      'visualizer.snapshots must be an array');
    assert.ok(data.visualizer.snapshots.length >= 1,
      'small fixture vault has >= 1 commit so snapshots should not be empty');
    assert.equal(typeof data.visualizer.since, 'string');
    assert.equal(typeof data.visualizer.commits_total, 'number');
    // graceful degrade contract: if first_view is null, error must be string
    if (data.visualizer.first_view === null) {
      assert.ok(typeof data.visualizer.first_view_error === 'string',
        'when first_view is null, first_view_error must be string');
    }
    if (data.visualizer.lineage === null) {
      assert.ok(typeof data.visualizer.lineage_error === 'string',
        'when lineage is null, lineage_error must be string');
    }
  } finally {
    await disposeFixtureVault(vault);
  }
});

// ---------------------------------------------------------------------------
// BLUE-WEBUI-SHELL-3: dashboard field renders 10 views from dashboard.base
// (relies on Task B-4 fixture extension copying dashboard.base into vault)
// ---------------------------------------------------------------------------

test('BLUE-WEBUI-SHELL-3: dashboard field renders 10 views from dashboard.base', async () => {
  const vault = await cloneSmallVault();
  try {
    const data = await withoutQmd(() => buildShellData(vault, { mode: 'snapshot' }));
    assert.equal(data.dashboard.base_source, 'wiki/meta/dashboard.base');
    assert.equal(data.dashboard.base_error, null,
      `dashboard.base must render without error (got: ${data.dashboard.base_error})`);
    assert.ok(Array.isArray(data.dashboard.views));
    assert.equal(data.dashboard.views.length, 10,
      'wiki/meta/dashboard.base declares 10 views');
    assert.ok(Array.isArray(data.dashboard.warnings));
    for (const view of data.dashboard.views) {
      assert.ok(typeof view.name === 'string' && view.name.length > 0);
      assert.ok(['table', 'list'].includes(view.type));
    }
  } finally {
    await disposeFixtureVault(vault);
  }
});

test('BLUE-WEBUI-SHELL-3b: dashboard field graceful degrade when base_source missing', async () => {
  const vault = await cloneSmallVault();
  try {
    const data = await withoutQmd(() => buildShellData(vault, {
      mode: 'snapshot',
      base_source: 'does/not/exist.base',
    }));
    assert.equal(data.dashboard.base_source, 'does/not/exist.base');
    assert.ok(typeof data.dashboard.base_error === 'string');
    assert.ok(data.dashboard.base_error.startsWith('file_not_found:'));
    assert.deepEqual(data.dashboard.views, []);
  } finally {
    await disposeFixtureVault(vault);
  }
});

// ---------------------------------------------------------------------------
// BLUE-WEBUI-SHELL-4: buildShellHtml produces HTML with placeholder replaced
// + security escape (</script> injection guard)
// ---------------------------------------------------------------------------

test('BLUE-WEBUI-SHELL-4: buildShellHtml replaces __KIOKU_SHELL_DATA__ + security escape', async () => {
  const vault = await cloneSmallVault();
  try {
    const html = await withoutQmd(() => buildShellHtml(vault, { mode: 'snapshot' }));
    assert.ok(typeof html === 'string' && html.length > 0);
    assert.ok(html.includes('KIOKU Web UI'),
      'shell title must appear in rendered HTML');
    assert.ok(!html.includes('__KIOKU_SHELL_DATA__'),
      'placeholder must be replaced');
    assert.ok(html.includes('"schema_version":1'),
      'inline JSON data must be present');
    assert.ok(html.includes('"default_tab":"dashboard"'),
      'shell_meta.default_tab=dashboard must serialize');
    // security: no external network handles
    const fetchHits = (html.match(/\bfetch\s*\(/g) || []).length;
    const xhrHits = (html.match(/XMLHttpRequest|sendBeacon/g) || []).length;
    assert.equal(fetchHits, 0, 'snapshot mode must not contain fetch() calls');
    assert.equal(xhrHits, 0, 'snapshot mode must not contain XHR/sendBeacon');
    const linkHrefHits = (html.match(/<link[^>]+href=/gi) || []).length;
    assert.equal(linkHrefHits, 0, 'snapshot mode must not contain external <link href>');
    // <script src=...> external loads must be 0; inline <script> with no src is fine
    const scriptSrcHits = (html.match(/<script[^>]+\bsrc=/gi) || []).length;
    assert.equal(scriptSrcHits, 0, 'snapshot mode must not contain external <script src>');
    // </script> escape guard: data JSON must not contain raw </script>
    const dataBlobMatch = html.match(/<script id="kioku-shell-data"[^>]*>([\s\S]*?)<\/script>/);
    assert.ok(dataBlobMatch, 'kioku-shell-data <script> block must exist');
    const dataBlob = dataBlobMatch[1];
    assert.ok(!/<\/script>/i.test(dataBlob),
      'inline JSON must not contain raw </script>');
  } finally {
    await disposeFixtureVault(vault);
  }
});

test('BLUE-WEBUI-SHELL-4b: safeJsonForScript escapes injection vectors', () => {
  const { safeJsonForScript } = _internals;
  // Use String.fromCharCode for invisible separators so the test source stays
  // reviewable (CLAUDE.md `.claude/rules/code-style.md` LEARN#13 spirit).
  const U2028 = String.fromCharCode(0x2028);
  const U2029 = String.fromCharCode(0x2029);
  const evil = {
    payload: '</script><img src=x onerror=alert(1)>',
    sep2028: U2028,
    sep2029: U2029,
  };
  const out = safeJsonForScript(evil);
  assert.ok(!out.includes('</script>'),
    'safeJsonForScript must escape literal </script>');
  assert.ok(out.includes('\\u003c/script>'),
    'safeJsonForScript must escape </ to \\u003c/');
  assert.ok(!out.includes(U2028),
    'safeJsonForScript must escape U+2028');
  assert.ok(!out.includes(U2029),
    'safeJsonForScript must escape U+2029');
  assert.ok(out.includes('\\u2028'));
  assert.ok(out.includes('\\u2029'));
});

// ---------------------------------------------------------------------------
// BLUE-WEBUI-SHELL-5: shell HTML inlines Visualizer β 4 view from viz-template.html
// ---------------------------------------------------------------------------

test('BLUE-WEBUI-SHELL-5: shell HTML inlines Visualizer β 4 view (overview/timeline/diff/lineage)', async () => {
  const vault = await cloneSmallVault();
  try {
    const html = await withoutQmd(() => buildShellHtml(vault, { mode: 'snapshot' }));
    // Tab content containers must exist
    assert.ok(html.includes('id="tab-overview"'),
      'tab-overview section must be present in shell HTML');
    assert.ok(html.includes('id="tab-timeline"'),
      'tab-timeline section must be present');
    assert.ok(html.includes('id="tab-diff"'),
      'tab-diff section must be present');
    assert.ok(html.includes('id="tab-lineage"'),
      'tab-lineage section must be present');
    // Inline data reference: shell JS exposes data.visualizer for tabs to consume
    assert.ok(html.includes('data.visualizer'),
      'shell template must reference data.visualizer for β tabs');
    // viz-template inline body has key Sprint 3 markers; the inline placeholder
    // must have been replaced (not raw __KIOKU_VIZ_INLINE__)
    assert.ok(!html.includes('__KIOKU_VIZ_INLINE__'),
      'viz inline placeholder must be replaced');
  } finally {
    await disposeFixtureVault(vault);
  }
});

// ---------------------------------------------------------------------------
// BLUE-WEBUI-SHELL-INTEGRATION: end-to-end shell HTML build + render contract
// ---------------------------------------------------------------------------

test('BLUE-WEBUI-SHELL-INTEGRATION: end-to-end buildShellHtml produces self-contained HTML', async () => {
  const vault = await cloneSmallVault();
  try {
    const html = await withoutQmd(() => buildShellHtml(vault, { mode: 'snapshot' }));
    // doctype + html + body must be present (well-formed)
    assert.ok(/^<!DOCTYPE html>/i.test(html.trim()),
      'shell HTML must start with <!DOCTYPE html>');
    assert.ok(html.includes('</html>'), 'shell HTML must close </html>');
    // 8 tabs visible (data-tab-id attribute count) — JS-rendered, so check JSON has 8 tabs
    const data = await withoutQmd(() => buildShellData(vault, { mode: 'snapshot' }));
    assert.equal(data.shell_meta.tabs.length, 8);
    // dashboard rendered with 10 views (LEARN#6 boundary: PR A → shell)
    assert.equal(data.dashboard.views.length, 10);
    // visualizer integrated (LEARN#6 boundary: Sprint 3 → shell)
    assert.ok(Array.isArray(data.visualizer.snapshots));
    // schema_version drift guard: shell schema (1) vs viz schema (4) independent
    assert.equal(data.schema_version, 1);
    assert.equal(data.visualizer.schema_version, 4);
  } finally {
    await disposeFixtureVault(vault);
  }
});

// ---------------------------------------------------------------------------
// BLUE-WEBUI-SHELL-6: buildShellData includes search_index with valid shape
// ---------------------------------------------------------------------------

test('BLUE-WEBUI-SHELL-6: buildShellData includes search_index field with valid shape', async () => {
  const vault = await cloneSmallVault();
  try {
    const data = await withoutQmd(() => buildShellData(vault, { mode: 'snapshot' }));
    assert.ok(data.search_index, 'search_index must be present');
    assert.equal(data.search_index.schema_version, 1);
    assert.match(data.search_index.generated_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(Array.isArray(data.search_index.queries));
    assert.ok(data.shell_meta.search, 'shell_meta.search summary must be present');
    assert.equal(typeof data.shell_meta.search.precomputed, 'number');
    assert.equal(data.shell_meta.search.precomputed, data.search_index.queries.length);
  } finally {
    await disposeFixtureVault(vault);
  }
});

// ---------------------------------------------------------------------------
// BLUE-WEBUI-SHELL-7: Search tab now enabled (Phase 2 promotion)
// ---------------------------------------------------------------------------

test('BLUE-WEBUI-SHELL-7: SHELL_TABS Search tab enabled === true with no gate', async () => {
  const vault = await cloneSmallVault();
  try {
    const data = await withoutQmd(() => buildShellData(vault, { mode: 'snapshot' }));
    const searchTab = data.shell_meta.tabs.find((t) => t.id === 'search');
    assert.ok(searchTab, 'search tab must exist');
    assert.equal(searchTab.enabled, true);
    assert.ok(!('gate' in searchTab) || searchTab.gate === undefined,
      'enabled search tab must not retain Phase 2 gate field');
  } finally {
    await disposeFixtureVault(vault);
  }
});

// ---------------------------------------------------------------------------
// BLUE-WEBUI-SHELL-8: shell HTML contains <section id="tab-search"> + search hint
// ---------------------------------------------------------------------------

test('BLUE-WEBUI-SHELL-8: shell HTML contains tab-search section + Option C UX narrative hint', async () => {
  const vault = await cloneSmallVault();
  try {
    const html = await withoutQmd(() => buildShellHtml(vault, { mode: 'snapshot' }));
    assert.ok(html.includes('id="tab-search"'),
      'shell HTML must contain <section id="tab-search">');
    // Option C narrative must appear in either the template hint or the rendered IIFE strings
    assert.ok(html.includes('Tier 1') && html.includes('Tier 2'),
      'shell HTML must embed Option C Tier 1 / Tier 2 narrative');
    assert.ok(html.includes('kioku_search'),
      'shell HTML must reference the kioku_search MCP tool for Tier 2 deep-dive');
  } finally {
    await disposeFixtureVault(vault);
  }
});

// ---------------------------------------------------------------------------
// BLUE-WEBUI-SHELL-9: search_index JSON island parses; results have no body/abs_path
// ---------------------------------------------------------------------------

test('BLUE-WEBUI-SHELL-9: search_index JSON island parse + results strip body/abs_path', async () => {
  const vault = await cloneSmallVault();
  try {
    const html = await withoutQmd(() => buildShellHtml(vault, { mode: 'snapshot' }));
    const m = html.match(/<script id="kioku-shell-data" type="application\/json">([\s\S]*?)<\/script>/);
    assert.ok(m, 'kioku-shell-data <script> block must exist');
    const parsed = JSON.parse(m[1]);
    assert.ok(parsed.search_index, 'parsed shell data must contain search_index');
    assert.ok(Array.isArray(parsed.search_index.queries));
    for (const q of parsed.search_index.queries) {
      for (const r of (q.results || [])) {
        assert.ok(!('body' in r),
          `search result for query "${q.query}" must not contain body`);
        assert.ok(!('abs_path' in r),
          `search result for query "${q.query}" must not contain abs_path`);
        assert.equal(typeof r.title, 'string');
        assert.equal(typeof r.rel, 'string');
        assert.equal(typeof r.snippet, 'string');
      }
    }
  } finally {
    await disposeFixtureVault(vault);
  }
});

// ---------------------------------------------------------------------------
// BLUE-WEBUI-SHELL-10: shell HTML self-contained — no fetch / XHR / sendBeacon
// ---------------------------------------------------------------------------

test('BLUE-WEBUI-SHELL-10: shell HTML self-contained (no fetch / XHR / sendBeacon / EventSource)', async () => {
  const vault = await cloneSmallVault();
  try {
    const html = await withoutQmd(() => buildShellHtml(vault, { mode: 'snapshot' }));
    const fetchHits = (html.match(/\bfetch\s*\(/g) || []).length;
    const xhrHits = (html.match(/\bXMLHttpRequest\b/g) || []).length;
    const beaconHits = (html.match(/\bsendBeacon\b/g) || []).length;
    const sseHits = (html.match(/\bEventSource\b/g) || []).length;
    const wsHits = (html.match(/\bWebSocket\b/g) || []).length;
    const swHits = (html.match(/navigator\.serviceWorker/g) || []).length;
    assert.equal(fetchHits, 0, 'snapshot mode shell HTML must not contain fetch() calls');
    assert.equal(xhrHits, 0, 'snapshot mode shell HTML must not contain XMLHttpRequest');
    assert.equal(beaconHits, 0, 'snapshot mode shell HTML must not contain sendBeacon');
    assert.equal(sseHits, 0, 'snapshot mode shell HTML must not contain EventSource');
    assert.equal(wsHits, 0, 'snapshot mode shell HTML must not contain WebSocket');
    assert.equal(swHits, 0, 'snapshot mode shell HTML must not contain navigator.serviceWorker');
  } finally {
    await disposeFixtureVault(vault);
  }
});
