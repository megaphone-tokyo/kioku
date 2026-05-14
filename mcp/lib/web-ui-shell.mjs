// web-ui-shell.mjs — KIOKU Web UI shell layer (Sprint 4 Phase 1 PR B).
//
// Plan: tools/claude-brain/plan/claude/26051301_v0-9-phase1-impl-plan.md §「PR B」 (L1070-1769).
//
// Responsibility:
//   - Combine PR A bases-renderer output (Dashboard tab) with Sprint 3 Visualizer β
//     data layer (Overview / Timeline / Diff / Lineage tabs) into a single shell HTML.
//   - `snapshot` mode (default): self-contained HTML with all data inlined as JSON
//     for offline / share / archive use.
//   - `served` mode: placeholder for Phase 2 Search (live backend), currently no-op
//     beyond shell_meta.mode tag — Phase 1 ships shell with mode flag only.
//
// Exports:
//   buildShellData(vault, options?) → ShellData
//   buildShellHtml(vault, options?) → string (full HTML)
//
// Security:
//   - innerHTML must not be used (template uses textContent + createElement only)
//   - safeJsonForScript escapes `</script>`, U+2028, U+2029 before inline embedding
//   - No external <script src>, <link href>, fetch, XHR, sendBeacon in snapshot mode
//   - Path C+β boundary: no editor / Canvas write / Plugin loader / cloud connector

import { basename, dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { collectHealthMetrics } from './health-metrics.mjs';
import { collectFirstViewData } from './visualizer-data.mjs';
import { buildLineageGraph } from './lineage-graph.mjs';
import { getFileHistory } from './git-history.mjs';
import { buildWikiSnapshot } from './wiki-snapshot.mjs';
import { parseBaseFile, renderBases } from './bases-renderer.mjs';
import { buildSearchIndex } from './qmd-search-index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHELL_TEMPLATE_PATH = join(__dirname, '..', 'templates', 'shell-template.html');
const VIZ_TEMPLATE_PATH = join(__dirname, '..', 'templates', 'viz-template.html');

export const SHELL_SCHEMA_VERSION = 1;

// 8 tabs: 6 active (Phase 1 base 5 + Phase 2 Search) + 2 placeholder (Phase 3-4).
// Order = visual left-to-right rendering order.
const SHELL_TABS = Object.freeze([
  { id: 'dashboard', label: 'Dashboard', enabled: true },
  { id: 'overview', label: 'Overview', enabled: true },
  { id: 'timeline', label: 'Timeline', enabled: true },
  { id: 'diff', label: 'Diff', enabled: true },
  { id: 'lineage', label: 'Lineage', enabled: true },
  { id: 'search', label: 'Search', enabled: true },
  { id: 'navigation', label: 'Navigation', enabled: false, gate: 'phase3' },
  { id: 'wikilink-graph', label: 'Wikilink graph', enabled: false, gate: 'phase4' },
]);

// Canonical location written by tools/claude-brain/scripts/setup-vault.sh:221-222
// (REPO source `tools/claude-brain/templates/wiki/meta/dashboard.base` → installed
// at `${vault}/wiki/meta/dashboard.base`). Callers can override via
// options.base_source if their vault uses a different path.
const DEFAULT_BASE_SOURCE = 'wiki/meta/dashboard.base';
const DEFAULT_MAX_COMMITS = 50;
const MAX_COMMITS_HARD_CAP = 5000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function buildShellData(vault, options = {}) {
  if (typeof vault !== 'string' || vault.length === 0) {
    throw new Error('buildShellData: vault path is required');
  }
  const mode = options.mode === 'served' ? 'served' : 'snapshot';
  const now = options.now instanceof Date ? options.now : new Date();

  const visualizer = await buildVisualizerData(vault, options, now);
  const dashboard = await buildDashboardData(vault, options, now);
  const searchIndex = await buildSearchIndexSafe(vault, options.search ?? {}, now);

  return {
    schema_version: SHELL_SCHEMA_VERSION,
    shell_meta: {
      mode,
      default_tab: 'dashboard',
      tabs: SHELL_TABS.map((tab) => ({ ...tab })),
      generated_at: now.toISOString(),
      vault_name: basename(vault),
      search: {
        precomputed: Array.isArray(searchIndex.queries) ? searchIndex.queries.length : 0,
        generated_at: searchIndex.generated_at,
      },
    },
    visualizer,
    dashboard,
    search_index: searchIndex,
  };
}

// Defensive wrapper around buildSearchIndex.
// PR A2/B2 already harden the discovery / search path (graceful per-query failure,
// non-git skip, fs error swallow), but we still wrap the top-level call so a
// hypothetical regression in qmd-search-index.mjs never blocks the shell.
async function buildSearchIndexSafe(vault, searchOptions, now) {
  try {
    return await buildSearchIndex(vault, searchOptions);
  } catch (err) {
    return {
      schema_version: 1,
      generated_at: now.toISOString(),
      queries: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function buildShellHtml(vault, options = {}) {
  const data = await buildShellData(vault, options);
  const shellTpl = await readFile(SHELL_TEMPLATE_PATH, 'utf8');
  const vizInline = await loadVizInline();
  const dataJson = safeJsonForScript(data);
  return shellTpl
    .replace('__KIOKU_VIZ_INLINE__', vizInline)
    .replace('__KIOKU_SHELL_DATA__', dataJson);
}

// ---------------------------------------------------------------------------
// Visualizer data (delegates to Sprint 3 lib)
// ---------------------------------------------------------------------------

async function buildVisualizerData(vault, options, now) {
  const since = typeof options.since === 'string' ? options.since : defaultSinceISO(now);
  const maxCommits = typeof options.max_commits === 'number'
    ? Math.max(1, Math.min(options.max_commits, MAX_COMMITS_HARD_CAP))
    : DEFAULT_MAX_COMMITS;

  let histRes;
  try {
    histRes = await getFileHistory(vault, { since, subPath: 'wiki/', maxCommits });
  } catch (err) {
    return {
      schema_version: 4,
      error: 'history_failed',
      error_message: err instanceof Error ? err.message : String(err),
      snapshots: [],
      since,
      commits_total: 0,
      history_truncated: false,
      first_view: null,
      first_view_error: 'history_failed',
      lineage: null,
      lineage_error: 'history_failed',
    };
  }
  if (histRes && histRes.error === 'not_a_git_repo') {
    return {
      schema_version: 4,
      error: 'not_a_git_repo',
      snapshots: [],
      since,
      commits_total: 0,
      history_truncated: false,
      first_view: null,
      first_view_error: 'not_a_git_repo',
      lineage: null,
      lineage_error: 'not_a_git_repo',
    };
  }

  const snapshots = [];
  for (const commit of histRes.commits) {
    try {
      const snap = await buildWikiSnapshot(vault, commit.sha, {
        subPath: 'wiki/',
        timestamp: commit.timestamp,
      });
      snapshots.push({
        sha: snap.sha,
        shortSha: commit.shortSha,
        timestamp: snap.timestamp ?? commit.timestamp,
        author: commit.author,
        subject: commit.subject,
        pages: snap.pages,
        links: snap.links,
        truncated: Boolean(snap.truncated),
        error: snap.error ?? null,
      });
    } catch (err) {
      snapshots.push({
        sha: commit.sha,
        shortSha: commit.shortSha,
        timestamp: commit.timestamp,
        author: commit.author,
        subject: commit.subject,
        pages: [],
        links: [],
        truncated: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let firstView = null;
  let firstViewError = null;
  try {
    const health = await collectHealthMetrics(vault, { now });
    firstView = await collectFirstViewData(vault, { now, snapshots, health });
  } catch (err) {
    firstViewError = err instanceof Error ? err.message : String(err);
  }

  let lineage = null;
  let lineageError = null;
  try {
    lineage = await buildLineageGraph(vault, { now });
  } catch (err) {
    lineageError = err instanceof Error ? err.message : String(err);
  }

  return {
    schema_version: 4,
    snapshots,
    since,
    commits_total: histRes.commits.length,
    history_truncated: Boolean(histRes.truncated),
    first_view: firstView,
    first_view_error: firstViewError,
    lineage,
    lineage_error: lineageError,
  };
}

// ---------------------------------------------------------------------------
// Dashboard data (delegates to PR A bases-renderer)
// ---------------------------------------------------------------------------

async function buildDashboardData(vault, options, now) {
  const baseSource = typeof options.base_source === 'string' && options.base_source.length > 0
    ? options.base_source
    : DEFAULT_BASE_SOURCE;

  let baseText;
  try {
    baseText = await readFile(join(vault, baseSource), 'utf8');
  } catch (err) {
    return {
      base_source: baseSource,
      views: [],
      warnings: [],
      base_error: `file_not_found: ${err.message}`,
    };
  }

  let parsed;
  try {
    parsed = parseBaseFile(baseText);
  } catch (err) {
    return {
      base_source: baseSource,
      views: [],
      warnings: [],
      base_error: `parse_error: ${err.message}`,
    };
  }

  try {
    const { views, warnings } = await renderBases(vault, parsed.ast, { now });
    return {
      base_source: baseSource,
      views,
      warnings: [...(parsed.warnings || []), ...(warnings || [])],
      base_error: null,
    };
  } catch (err) {
    return {
      base_source: baseSource,
      views: [],
      warnings: parsed.warnings || [],
      base_error: `render_error: ${err.message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

// Extract <body> inner content from viz-template.html for shell inlining.
// We intentionally take only the <body> content — the shell template provides
// its own <head> with merged styles — to avoid duplicate <html>/<head>/<body>.
async function loadVizInline() {
  try {
    const vizTpl = await readFile(VIZ_TEMPLATE_PATH, 'utf8');
    const match = vizTpl.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (!match) return '<!-- viz-template body not found -->';
    return match[1];
  } catch (err) {
    return `<!-- viz-template load error: ${escapeHtmlComment(err.message)} -->`;
  }
}

function escapeHtmlComment(text) {
  return String(text).replace(/--/g, '—');
}

// safeJsonForScript: serialize an object to a JSON string that is safe to embed
// inside a <script type="application/json"> block. Escapes:
//   - </ → </  (prevents </script> injection)
//   - U+2028 / U+2029 (LINE / PARAGRAPH SEPARATOR — JSON-legal but ECMAScript
//     parser-illegal in inline <script type="application/javascript">; harmless
//     in application/json but escaping keeps inline JS safe even if reused.)
function safeJsonForScript(obj) {
  const raw = JSON.stringify(obj);
  const u2028 = String.fromCharCode(0x2028);
  const u2029 = String.fromCharCode(0x2029);
  return raw
    .split('</').join('\\u003c/')
    .split(u2028).join('\\u2028')
    .split(u2029).join('\\u2029');
}

function defaultSinceISO(now) {
  const d = new Date(now);
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Test hook
// ---------------------------------------------------------------------------

export const _internals = {
  SHELL_TABS,
  SHELL_SCHEMA_VERSION,
  safeJsonForScript,
  loadVizInline,
  buildVisualizerData,
  buildDashboardData,
  defaultSinceISO,
};
