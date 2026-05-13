// visualizer-data.mjs — Phase 1+2+4 v0.8 Visualizer β First view data builder
//
// codex strategic doc 260512_v0-8-visualizer-beta-scope.md §Axis 3 §First view
// Phase 1 (PR #124): 4 layer ordering を構成する:
//   1. vault_overview  — pages total / summaries growth / page type distribution
//   2. health_focus    — broken_wikilink / source_sha256_duplicate / pages_warm_zone
//   3. graph_preview   — hot pages / active projects / recent decisions
//   4. action_queue    — 3-5 actionable items with priority + next_action
// Phase 2 (PR #125): 11 metrics を graph/chart に overlay する Health overlay 拡張:
//   - status_banner    — P1 metrics 6 件を severity 付き chip で表示 (ok/info/warn/danger)
//   - health_focus.broken_wikilink.clusters — target で group 化、merge candidate view
//   - health_focus.pages_warm_zone.distribution — fresh/warm/stale 3 bucket gradient
//   - vault_overview.page_count_by_type.sorted_entries — compact bar chart 用 sort 済み
//   - auto-lint output は Phase 2 で touch せず、Phase 4 drawer 化 (BLUE-VIZ-HEALTH-OVERLAY-7 で固定)
// Phase 4 (本 PR): auto-lint 4 観点を補助 drawer として first_view に embed:
//   - auto_lint        — wiki/lint-report.md を 4 section parse (LLM judgment は graph に断定表示しない)
//   - 旧 Phase 2 の negative assert (auto_lint 不在) を positive (graceful null OK + drawer card 存在) へ flip
//   - drawer is 5 枚目 card "Quality notes (auto-lint)"、4 観点を mini-list で表示、詳細は wiki/lint-report.md
//
// 設計方針:
//   - Sprint 2 完走済 collectHealthMetrics() を data source として使う (重複実装しない)
//   - graph_preview は snapshots[0].pages を優先、空なら live filesystem walk fallback。
//     real Vault が parent git repo の subdirectory にあると `git show <sha>:wiki/X.md` が
//     repo-root-relative path mismatch で fail し snapshot が empty になる pre-existing
//     issue があるため (open-issues §VIZ-LIVE-WALK-FALLBACK 参照)。
//   - 出力は HTML embed 用に compact 化 (sample 件数を 5 に制限、UI で「more」展開する想定)
//   - action_queue は metrics 直読で priority 付き構築 (next_actions の string match を避け頑健に)
//   - auto_lint は LLM judgment のため断定表示しない (PM 答え #3「user trust 落とさない」)。
//     report 不在 / parse 失敗時は null で graceful degrade、HTML 側で "auto-lint 未実行" を案内
//
// Sprint 3 Phase 3 (§46 LEARN#8b N=3 mandatory refactor):
//   walkLiveWikiPages is now a thin projection over wiki-walker.mjs#walkPages.
//   The old in-file walk loop and PATH_TO_TYPE map have been removed.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectHealthMetrics } from './health-metrics.mjs';
import { walkPages } from './wiki-walker.mjs';

export const FIRST_VIEW_SCHEMA_VERSION = 2;
export const AUTO_LINT_SCHEMA_VERSION = 1;

// UI 表示 cap (HTML inline JSON 肥大化防止 + 視覚密度のバランス)
const SAMPLE_LIMIT = 5;
const HOT_PAGES_LIMIT = 10;
const ACTIVE_PROJECTS_LIMIT = 5;
const RECENT_DECISIONS_LIMIT = 5;
const ACTION_QUEUE_MAX = 5;
const BROKEN_CLUSTER_LIMIT = 10; // Phase 2: target 別 cluster の表示上限
const AUTO_LINT_SAMPLE_LIMIT = 3; // Phase 4: 4 観点各 section の preview sample 件数
const AUTO_LINT_SAMPLE_MAX_CHARS = 240; // Phase 4: sample 1 件あたり最大文字数 (HTML inline 肥大化防止)
const AUTO_LINT_MAX_BYTES = 256 * 1024; // Phase 4: lint-report.md 読み込み上限 (異常巨大 file 防御)

// Phase 2 severity thresholds (status_banner で使用)
//   - hot_md_age: > 7 day で warn, > 30 day で danger
//   - last_ingest: > 24h で warn, > 7 day で danger
//   - stale / unprocessed_logs: > 5 で warn
const SEC_PER_DAY = 24 * 3600;
const HOT_MD_WARN_DAYS = 7;
const HOT_MD_DANGER_DAYS = 30;
const LAST_INGEST_WARN_HOURS = 24;
const LAST_INGEST_DANGER_DAYS = 7;
const STALE_WARN_COUNT = 5;
const UNPROCESSED_LOGS_WARN_COUNT = 5;

// snapshots:  visualizer.mjs が build した snapshot 配列 (newest first 想定)
// livePages:  事前 walk 済みの page array — テスト経由で snapshot fallback を bypass する用途
// health   :  collectHealthMetrics 結果。caller が再計算回避のため渡すか、null で再計算
//
// graph_preview の page source 優先順位:
//   1. livePages が array で渡されたらそれを使う (test 経由 / caller が live walk 済)
//   2. snapshots[0].pages が non-empty なら snapshot 内 page metadata を使う (高速 path)
//   3. fallback: vault/wiki/ を live walk する (snapshot が repo-root-relative path drift
//      等で空になっているケース)
//   4. それでも 0 件なら空 graph_preview
// autoLint: Phase 4 で追加した補助 input。caller が pre-load した auto_lint object か null。
//   - undefined (default) → vault から loadAutoLintReport で読む
//   - null               → 強制的に "report 未存在" として扱う (test 用)
//   - object             → そのまま first_view に埋め込む (test / mock 用)
export async function collectFirstViewData(vault, {
  now = new Date(),
  snapshots = [],
  livePages = null,
  health = null,
  autoLint = undefined,
} = {}) {
  const healthData = health ?? await collectHealthMetrics(vault, { now });
  const metrics = healthData.metrics;

  const pagesForGraph = await resolvePagesForGraph(vault, snapshots, livePages);

  let resolvedAutoLint;
  if (autoLint === undefined) {
    resolvedAutoLint = await loadAutoLintReport(vault).catch(() => null);
  } else {
    resolvedAutoLint = autoLint;
  }

  return {
    schema_version: FIRST_VIEW_SCHEMA_VERSION,
    generated_at: now.toISOString(),
    vault_overview: buildVaultOverview(healthData),
    health_focus: buildHealthFocus(metrics),
    graph_preview: buildGraphPreview(pagesForGraph),
    action_queue: buildActionQueue(metrics),
    status_banner: buildStatusBanner(metrics),
    auto_lint: resolvedAutoLint,
  };
}

async function resolvePagesForGraph(vault, snapshots, livePages) {
  if (Array.isArray(livePages)) return livePages;
  if (Array.isArray(snapshots) && snapshots.length > 0
      && Array.isArray(snapshots[0].pages) && snapshots[0].pages.length > 0) {
    return snapshots[0].pages;
  }
  if (typeof vault === 'string' && vault.length > 0) {
    return await walkLiveWikiPages(vault);
  }
  return [];
}

// Layer 1: Vault overview ───────────────────────────────────────────────────
function buildVaultOverview(healthData) {
  const m = healthData.metrics;
  const pct = m.page_count_by_type ?? { total: 0, by_type: {} };
  // Phase 2: sorted_entries を chart-friendly descending order で同梱。
  // HTML 側は再 sort 不要、compact bar chart に直接 map できる。
  const sortedEntries = Object.entries(pct.by_type ?? {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    pages_total: healthData.vault_pages_total,
    summaries_growth: m.summaries_growth_rate,
    page_count_by_type: {
      total: pct.total,
      by_type: pct.by_type,
      sorted_entries: sortedEntries,
    },
  };
}

// Layer 2: Health focus (compact 化 + Phase 2 overlay 拡張) ─────────────────
function buildHealthFocus(metrics) {
  const broken = metrics.broken_wikilink ?? { count: 0, samples: [], sample_truncated: false };
  const sha256Dup = metrics.source_sha256_duplicate ?? { count: 0, groups: [] };
  const warm = metrics.pages_warm_zone ?? { count: 0, lower_days: 7, upper_days: 30, pages: [] };
  const stale = metrics.stale ?? { count: 0, threshold_days: 30, pages: [] };
  const pagesTotal = (metrics.page_count_by_type && metrics.page_count_by_type.total) ?? 0;

  // Phase 2: broken_wikilink を target で group 化、merge candidate view を提供。
  // 各 cluster は { target, sources: [...], inbound_broken_count }。
  // sort: inbound_broken_count desc → 最も問題の多い target が先頭、target locale 安定 sort。
  const clusterMap = new Map();
  for (const s of (broken.samples ?? [])) {
    if (!s || typeof s.target !== 'string' || typeof s.source !== 'string') continue;
    const list = clusterMap.get(s.target) ?? [];
    list.push(s.source);
    clusterMap.set(s.target, list);
  }
  const allClusters = Array.from(clusterMap.entries())
    .map(([target, sources]) => ({
      target,
      sources: sources.slice().sort(),
      inbound_broken_count: sources.length,
    }))
    .sort((a, b) => {
      if (b.inbound_broken_count !== a.inbound_broken_count) return b.inbound_broken_count - a.inbound_broken_count;
      return a.target.localeCompare(b.target);
    });
  const clusters = allClusters.slice(0, BROKEN_CLUSTER_LIMIT);

  // Phase 2: warm zone distribution (fresh / warm / stale 3 bucket gradient 用)。
  // fresh は明示的に渡されない (health-metrics は system page 除外で warm/stale を出す)
  // ので: total_classified = warm + stale + fresh, fresh = pagesTotal - warm - stale - system 除外分
  // 簡易: fresh = pagesTotal - warm - stale (system page は誤差として許容)
  const warmCount = warm.count ?? 0;
  const staleCount = stale.count ?? 0;
  const fresh = Math.max(0, pagesTotal - warmCount - staleCount);
  const totalClassified = fresh + warmCount + staleCount;

  return {
    broken_wikilink: {
      count: broken.count,
      samples: (broken.samples ?? []).slice(0, SAMPLE_LIMIT),
      sample_truncated: broken.sample_truncated || (broken.samples ?? []).length > SAMPLE_LIMIT,
      clusters,
      cluster_truncated: allClusters.length > BROKEN_CLUSTER_LIMIT,
    },
    source_sha256_duplicate: {
      count: sha256Dup.count,
      groups: (sha256Dup.groups ?? []).slice(0, SAMPLE_LIMIT),
    },
    pages_warm_zone: {
      count: warm.count,
      lower_days: warm.lower_days,
      upper_days: warm.upper_days,
      pages: (warm.pages ?? []).slice(0, SAMPLE_LIMIT),
      distribution: {
        fresh,
        warm: warmCount,
        stale: staleCount,
        total_classified: totalClassified,
      },
    },
  };
}

// Layer 3: Graph preview ────────────────────────────────────────────────────
// page array (snapshot.pages 由来 or live walk 由来) から:
//   - hot_pages: wikilink in+out degree が高い page top N
//   - active_projects: type='project' の page top N
//   - recent_decisions: type='decision' の page top N
//
// page shape (snapshot / live walk 両者で共通):
//   { name, type, title, path, wikilinks }
//   - wikilinks は array of target string (outgoing wikilink target)
//   - snapshot 経由 (wiki-snapshot.mjs) は validator 通過済
//   - live 経由 (walkLiveWikiPages) は findWikilinks 経由、validator 未通過 (display only)
function buildGraphPreview(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    return { hot_pages: [], active_projects: [], recent_decisions: [] };
  }

  // degree counting: outbound wikilink target を resolve して in+out 加算
  const degreeByName = new Map();
  for (const p of pages) degreeByName.set(p.name, 0);
  for (const p of pages) {
    const wikilinks = Array.isArray(p.wikilinks) ? p.wikilinks : [];
    for (const target of wikilinks) {
      const t = typeof target === 'string' ? target.trim() : '';
      if (!t) continue;
      let resolved = null;
      if (degreeByName.has(t)) resolved = t;
      else {
        const last = t.split('/').pop();
        if (last && degreeByName.has(last)) resolved = last;
      }
      if (resolved) {
        degreeByName.set(resolved, degreeByName.get(resolved) + 1);
        degreeByName.set(p.name, degreeByName.get(p.name) + 1);
      }
    }
  }

  const hotPages = pages
    .map((p) => ({
      name: p.name,
      type: p.type ?? null,
      title: p.title ?? null,
      path: p.path ?? null,
      degree: degreeByName.get(p.name) ?? 0,
    }))
    .sort((a, b) => {
      if (b.degree !== a.degree) return b.degree - a.degree;
      return a.name.localeCompare(b.name);
    })
    .slice(0, HOT_PAGES_LIMIT);

  const activeProjects = pages
    .filter((p) => p.type === 'project')
    .map((p) => ({ name: p.name, title: p.title ?? null, path: p.path ?? null, type: 'project' }))
    .slice(0, ACTIVE_PROJECTS_LIMIT);

  const recentDecisions = pages
    .filter((p) => p.type === 'decision')
    .map((p) => ({ name: p.name, title: p.title ?? null, path: p.path ?? null, type: 'decision' }))
    .slice(0, RECENT_DECISIONS_LIMIT);

  return {
    hot_pages: hotPages,
    active_projects: activeProjects,
    recent_decisions: recentDecisions,
  };
}

// Walk vault/wiki/ as a flat page list shaped like snapshot.pages.
// Implementation now delegates to wiki-walker.mjs (§46 N=3 refactor). The legacy
// fields preserved for back-compat with tests/visualizer-data.test.mjs:
//   { name, path: `wiki/<rel>`, type, title|null, wikilinks }
//
// Notes:
//   - title is null (not basename) when neither frontmatter.title nor body H1 exists,
//     matching the pre-refactor behaviour relied upon by graph_preview UI.
//   - wikilinks come from findWikilinks() inside walkPages, validator-untouched (display only).
export async function walkLiveWikiPages(vault) {
  const walked = await walkPages(vault, {
    subDir: 'wiki',
    withFrontmatter: true,
    withWikilinks: true,
    withBody: false,
    withMtime: false,
  });
  return walked.map((p) => ({
    name: p.name,
    path: `wiki/${p.rel}`,
    type: p.type,
    title: (p.frontmatter && typeof p.frontmatter.title === 'string' && p.frontmatter.title.trim())
      ? p.frontmatter.title.trim()
      : null,
    wikilinks: p.wikilinks,
  }));
}

// Layer 4: Action queue ─────────────────────────────────────────────────────
// metrics 直読で priority 付きの actionable item を生成。
// 健全な vault (全 metric 健全) では 0 件で返す (空配列で「健全」を表現)。
//
// priority 配分:
//   P0 = critical health drift (data quality, ingest pipeline 破綻)
//   P1 = degrading (放置すると stale 化、cron 詰まり)
//   P2 = informational (nice to have、構造改善)
function buildActionQueue(metrics) {
  const items = [];

  // ── P0: critical health drift ──
  if (metrics.broken_wikilink && metrics.broken_wikilink.count > 0) {
    items.push({
      priority: 'P0',
      reason: `${metrics.broken_wikilink.count} broken wikilinks ([[X]] target が wiki に存在しない)`,
      next_action: 'Open dashboard "Broken Links" view, fix orphan link target or link 元 page を整理',
      command: 'cat wiki/meta/health.md  # see metrics.broken_wikilink.samples',
    });
  }
  if (metrics.source_sha256_duplicate && metrics.source_sha256_duplicate.count > 0) {
    items.push({
      priority: 'P0',
      reason: `${metrics.source_sha256_duplicate.count} source_sha256 duplicate group(s) — 同一 source から重複 page`,
      next_action: '重複 page を merge or archive (idempotent ingest が壊れている可能性、ingest path を確認)',
    });
  }

  // ── P1: degrading items ──
  if (metrics.pages_warm_zone && metrics.pages_warm_zone.count > 5) {
    items.push({
      priority: 'P1',
      reason: `${metrics.pages_warm_zone.count} pages in warm zone (${metrics.pages_warm_zone.lower_days}-${metrics.pages_warm_zone.upper_days} days)`,
      next_action: '更新候補が溜まっている。stale 化する前に revisit / 内容更新 / 関連リンク補強',
    });
  }
  if (metrics.stale && metrics.stale.count > 0) {
    items.push({
      priority: 'P1',
      reason: `${metrics.stale.count} pages older than ${metrics.stale.threshold_days} days`,
      next_action: 'Open dashboard "Stale Pages" view and revisit / update / archive',
      command: 'open wiki/meta/dashboard.md',
    });
  }
  if (metrics.unprocessed_logs && metrics.unprocessed_logs.count > 5) {
    items.push({
      priority: 'P1',
      reason: `${metrics.unprocessed_logs.count} unprocessed session-logs (ingested:false)`,
      next_action: 'Run auto-ingest manually, or wait for the next cron tick',
      command: 'bash scripts/auto-ingest.sh',
    });
  }
  if (metrics.last_ingest && metrics.last_ingest.exists && metrics.last_ingest.age_seconds > 24 * 3600) {
    items.push({
      priority: 'P1',
      reason: `last session-log activity ${metrics.last_ingest.age_human} ago`,
      next_action: 'session-logger hook が active か確認 (doctor で診断)',
      command: 'bash scripts/doctor.sh',
    });
  }

  // ── P2: informational ──
  if (metrics.orphan && metrics.orphan.count > 0) {
    items.push({
      priority: 'P2',
      reason: `${metrics.orphan.count} orphan pages (no inbound wikilinks)`,
      next_action: 'Add wikilinks from related pages, or move to wiki/.archive/ if obsolete',
    });
  }
  if (metrics.duplicate_title && metrics.duplicate_title.count > 0) {
    items.push({
      priority: 'P2',
      reason: `${metrics.duplicate_title.count} duplicate title groups`,
      next_action: 'Merge or rename duplicate pages — see metrics.duplicate_title.groups',
    });
  }
  if (metrics.hot_md_age && metrics.hot_md_age.exists && metrics.hot_md_age.age_seconds > 7 * 24 * 3600) {
    items.push({
      priority: 'P2',
      reason: `wiki/hot.md last updated ${metrics.hot_md_age.age_human} ago`,
      next_action: 'Refresh wiki/hot.md, or run a session that triggers PostCompact hook',
    });
  }
  const growth = metrics.summaries_growth_rate;
  if (growth && growth.vault_is_git === true && growth.day_7.added === 0 && growth.day_30.added === 0) {
    items.push({
      priority: 'P2',
      reason: 'No new summaries added in the last 30 days (ingest pipeline idle?)',
      next_action: 'PDF/URL ingest cron が回っているか確認、または新規 source を投入',
      command: 'bash scripts/auto-ingest.sh',
    });
  }

  // priority ordering is preserved by insertion order (P0 → P1 → P2) since we
  // appended in priority groups above. Cap to ACTION_QUEUE_MAX for UI density.
  return items.slice(0, ACTION_QUEUE_MAX);
}

// Phase 2: Status banner (P1 metrics の severity 付き chip 表示) ──────────────
// 6 P1 metric を 1 row banner で一覧、各 chip は severity (ok/info/warn/danger) で着色。
// severity 判定 rule:
//   ok       — 健全 (count=0, age 短い等)
//   info     — 観察対象 (count>0 だが urgent ではない)
//   warn     — 閾値超え (stale>5, hot_md>7d, unprocessed>5 等)
//   danger   — 緊急 (last_ingest>7d 等、cron 停止疑い)
function buildStatusBanner(metrics) {
  const orphan = metrics.orphan ?? { count: 0, pages: [] };
  const stale = metrics.stale ?? { count: 0, threshold_days: 30 };
  const dupTitle = metrics.duplicate_title ?? { count: 0, groups: [] };
  const hotAge = metrics.hot_md_age ?? { exists: false, age_seconds: null, age_human: null };
  const lastIngest = metrics.last_ingest ?? { exists: false, log_count: 0, age_seconds: null, age_human: null };
  const unproc = metrics.unprocessed_logs ?? { count: 0 };

  return {
    orphan: {
      count: orphan.count,
      severity: orphan.count === 0 ? 'ok' : 'info',
    },
    stale: {
      count: stale.count,
      threshold_days: stale.threshold_days,
      severity: stale.count === 0 ? 'ok' : (stale.count > STALE_WARN_COUNT ? 'warn' : 'info'),
    },
    duplicate_title: {
      count: dupTitle.count,
      severity: dupTitle.count === 0 ? 'ok' : 'warn',
    },
    hot_md_age: {
      exists: hotAge.exists,
      age_seconds: hotAge.age_seconds,
      age_human: hotAge.age_human,
      severity: severityFromAge(hotAge.age_seconds, HOT_MD_WARN_DAYS * SEC_PER_DAY, HOT_MD_DANGER_DAYS * SEC_PER_DAY),
    },
    last_ingest: {
      exists: lastIngest.exists,
      log_count: lastIngest.log_count,
      age_seconds: lastIngest.age_seconds,
      age_human: lastIngest.age_human,
      severity: severityFromAge(lastIngest.age_seconds, LAST_INGEST_WARN_HOURS * 3600, LAST_INGEST_DANGER_DAYS * SEC_PER_DAY),
    },
    unprocessed_logs: {
      count: unproc.count,
      severity: unproc.count === 0 ? 'ok' : (unproc.count > UNPROCESSED_LOGS_WARN_COUNT ? 'warn' : 'info'),
    },
  };
}

// age_seconds が null / undefined → ok (まだ初期化されていないだけ、urgent ではない)
// age < warnSec → ok
// age >= dangerSec → danger
// 中間 → warn
function severityFromAge(ageSeconds, warnSec, dangerSec) {
  if (ageSeconds == null) return 'ok';
  if (ageSeconds < warnSec) return 'ok';
  if (ageSeconds >= dangerSec) return 'danger';
  return 'warn';
}

// ─── Phase 4: auto-lint drawer loader (wiki/lint-report.md の 4 観点 parse) ───
//
// auto-lint script (scripts/auto-lint.sh) は LLM judgment 必須の 4 観点を
// wiki/lint-report.md に出力する:
//   - 概念の矛盾
//   - 概念の splinter
//   - 専用ページ候補
//   - 意味的な相互リンク欠落
//
// graph に断定表示せず "Quality notes (auto-lint)" 5 枚目 card で補助表示する。
// report 不在 / parse 失敗 / vault 未指定時は null を返し、HTML 側で
// "auto-lint 未実行 (run scripts/auto-lint.sh)" メッセージを表示する graceful degrade。
//
// LLM 生成 free-form markdown を堅牢に parse するため:
//   - section heading は `## ` 完全一致 (見出し ASCII 4 観点) で抽出
//   - 各 section の "finding" は次 `## ` までの本文を行単位で集める
//   - 1 件 = bullet (`-` / `*` / `1.`) または 空行で区切られた段落 paragraph
//   - sample 1 件あたり最大 240 char、各 section 最大 3 件 (HTML inline JSON 肥大化防止)
//
// 4 観点 schema:
//   { key, label, count, samples: string[], sample_truncated, count_estimated }
//   - count は heuristic (bullet 行数 + paragraph 数)、実際の finding 数とは厳密一致しない
//     → count_estimated: true で UI に "推定" を明示し user trust を保護
const AUTO_LINT_CATEGORIES = [
  { key: 'contradiction',       label: '概念の矛盾',             heading: '概念の矛盾' },
  { key: 'splinter',            label: '概念の splinter',        heading: '概念の splinter' },
  { key: 'promotion_candidate', label: '専用ページ候補',         heading: '専用ページ候補' },
  { key: 'link_gap',            label: '意味的な相互リンク欠落', heading: '意味的な相互リンク欠落' },
];

export async function loadAutoLintReport(vault) {
  if (typeof vault !== 'string' || vault.length === 0) return null;
  const reportPath = join(vault, 'wiki', 'lint-report.md');

  let raw;
  try {
    raw = await readFile(reportPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    return null;
  }

  if (typeof raw !== 'string' || raw.length === 0) return null;
  const text = raw.length > AUTO_LINT_MAX_BYTES ? raw.slice(0, AUTO_LINT_MAX_BYTES) : raw;
  const truncated = raw.length > AUTO_LINT_MAX_BYTES;

  const frontmatterDate = extractFrontmatterDate(text);
  const sections = extractMarkdownSections(text);
  const categories = AUTO_LINT_CATEGORIES.map((cat) => buildAutoLintCategory(cat, sections));
  const totalFindings = categories.reduce((sum, c) => sum + c.count, 0);

  return {
    schema_version: AUTO_LINT_SCHEMA_VERSION,
    report_exists: true,
    source_path: 'wiki/lint-report.md',
    generated_at: frontmatterDate,
    total_findings: totalFindings,
    categories,
    source_truncated: truncated,
  };
}

// frontmatter から `date:` を読み取る。なければ null。
function extractFrontmatterDate(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  const block = text.slice(3, end);
  const match = block.match(/^\s*date\s*:\s*(.+?)\s*$/m);
  if (!match) return null;
  const value = match[1].replace(/^['"]|['"]$/g, '').trim();
  return value.length > 0 ? value : null;
}

// `## <heading>` ブロックを map<heading, body> として抽出する。
// heading は trim + 余分な markdown 記号 (`(`含む補足) を除去して完全一致比較できる形に。
// body は次 `## ` までの行群。R1 や 要約 など想定外 heading は無視 (4 観点のみ extract)。
function extractMarkdownSections(text) {
  const lines = text.split(/\r?\n/);
  const map = new Map();
  let currentKey = null;
  let buffer = [];
  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) {
      if (currentKey !== null) map.set(currentKey, buffer.join('\n'));
      currentKey = normalizeHeading(match[1]);
      buffer = [];
    } else if (currentKey !== null) {
      buffer.push(line);
    }
  }
  if (currentKey !== null) map.set(currentKey, buffer.join('\n'));
  return map;
}

function normalizeHeading(raw) {
  // "R1: Unicode 不可視文字 (prompt injection 監査)" → "R1: Unicode 不可視文字"
  // 4 観点 heading は paren を含まないので、`(` 以降の補足を除去するだけで一致可能。
  return raw.split('(')[0].trim();
}

function buildAutoLintCategory(catSpec, sections) {
  const body = sections.get(catSpec.heading);
  if (!body) {
    return {
      key: catSpec.key,
      label: catSpec.label,
      heading: catSpec.heading,
      count: 0,
      samples: [],
      sample_truncated: false,
      count_estimated: true,
    };
  }
  const findings = parseFindings(body);
  const samples = findings
    .slice(0, AUTO_LINT_SAMPLE_LIMIT)
    .map((f) => truncateSample(f));
  return {
    key: catSpec.key,
    label: catSpec.label,
    heading: catSpec.heading,
    count: findings.length,
    samples,
    sample_truncated: findings.length > AUTO_LINT_SAMPLE_LIMIT,
    count_estimated: true,
  };
}

// section 本文から finding 1 件 = 1 string の配列へ分割。
// LLM 出力は揺らぐので 3 戦略を順に適用:
//   1. top-level bullet (`- ` / `* ` / `1. `) を 1 件として捉える
//   2. bullet が無ければ blank 行で区切った paragraph を 1 件として捉える
//   3. paragraph も無ければ全体を 1 件として捉える (空でない場合)
// "(検出なし)" 等の no-finding marker は除外し count=0 を返す。
function parseFindings(body) {
  const trimmed = body.trim();
  if (trimmed.length === 0) return [];
  if (isNoFindingMarker(trimmed)) return [];

  const lines = trimmed.split(/\r?\n/);

  // 1. top-level bullet 抽出 (子 bullet は同じ finding に含める)
  const bullets = [];
  let currentBullet = null;
  for (const line of lines) {
    const bulletMatch = line.match(/^(?:[-*+]|\d+\.)\s+(.*)$/);
    const isIndentedContinuation = /^(?:\s{2,}|\t)/.test(line) && currentBullet !== null;
    if (bulletMatch) {
      if (currentBullet !== null) bullets.push(currentBullet.trim());
      currentBullet = bulletMatch[1];
    } else if (isIndentedContinuation) {
      currentBullet += ' ' + line.trim();
    } else if (currentBullet !== null && line.trim() === '') {
      // blank line ends current bullet
      bullets.push(currentBullet.trim());
      currentBullet = null;
    }
  }
  if (currentBullet !== null) bullets.push(currentBullet.trim());
  const filteredBullets = bullets.filter((b) => b.length > 0 && !isNoFindingMarker(b));
  if (filteredBullets.length > 0) return filteredBullets;

  // 2. paragraph 抽出 (blank 行 区切り)
  const paragraphs = trimmed
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0 && !isNoFindingMarker(p));
  if (paragraphs.length > 0) return paragraphs;

  // 3. fallback: 全体を 1 件として返す
  const collapsed = trimmed.replace(/\s+/g, ' ').trim();
  return collapsed.length > 0 ? [collapsed] : [];
}

function isNoFindingMarker(text) {
  // auto-lint.sh prompt は LLM に「検出なし」「(該当なし)」等を書かせる可能性がある
  return /^[(（]?\s*(検出なし|該当なし|なし|none|n\/a)\s*[)）]?\s*\.?$/i.test(text.trim());
}

function truncateSample(s) {
  if (typeof s !== 'string') return '';
  const collapsed = s.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= AUTO_LINT_SAMPLE_MAX_CHARS) return collapsed;
  return collapsed.slice(0, AUTO_LINT_SAMPLE_MAX_CHARS - 1) + '…';
}

// Test 用 internals (test 以外から import しないこと)
export const _internals = {
  SAMPLE_LIMIT,
  HOT_PAGES_LIMIT,
  ACTIVE_PROJECTS_LIMIT,
  RECENT_DECISIONS_LIMIT,
  ACTION_QUEUE_MAX,
  BROKEN_CLUSTER_LIMIT,
  AUTO_LINT_SAMPLE_LIMIT,
  AUTO_LINT_SAMPLE_MAX_CHARS,
  AUTO_LINT_MAX_BYTES,
  AUTO_LINT_CATEGORIES,
  HOT_MD_WARN_DAYS,
  HOT_MD_DANGER_DAYS,
  LAST_INGEST_WARN_HOURS,
  LAST_INGEST_DANGER_DAYS,
  STALE_WARN_COUNT,
  UNPROCESSED_LOGS_WARN_COUNT,
  buildVaultOverview,
  buildHealthFocus,
  buildGraphPreview,
  buildActionQueue,
  buildStatusBanner,
  severityFromAge,
  resolvePagesForGraph,
  extractFrontmatterDate,
  extractMarkdownSections,
  parseFindings,
  isNoFindingMarker,
  truncateSample,
};
