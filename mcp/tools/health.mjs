// kioku_health — KIOKU 記憶品質 metrics の即時取得 (Sprint 2 v0.7.4 core 6 + v0.7.5 stretch 5)
//
// codex roadmap §P1 (plan/codex/260430_kioku-product-improvement-roadmap.md L283-315)
// に基づく 11 metrics を Claude Desktop / Claude Code / Codex CLI から直接 query するための
// MCP tool。scripts/generate-health.mjs が定期生成する wiki/meta/health.md は人間 /
// Obsidian Bases dashboard 向け、本 tool は LLM agent が即時 read するための JSON 形式。
//
// 11 metrics 一覧:
//   Core 6 (v0.7.4):    orphan / stale / duplicate_title / hot_md_age / last_ingest / unprocessed_logs
//   Stretch 5 (v0.7.5): broken_wikilink / source_sha256_duplicate / pages_warm_zone /
//                       page_count_by_type / summaries_growth_rate
//
// 副作用: なし (read-only、wiki/ session-logs/ を一切 modify しない)
//
// 設計方針:
//   - mcp/lib/health-metrics.mjs に処理委譲、tool layer は param 検証 + JSON 整形のみ
//   - paths_limit param で大量結果を抑制 (default 30) — orphan / stale / pages_warm_zone に適用
//   - threshold_days param で stale 判定閾値を override 可能 (default 30、warm zone 上限と兼用)

import { z } from 'zod';

import { collectHealthMetrics, STALE_THRESHOLD_DAYS } from '../lib/health-metrics.mjs';

const DEFAULT_PATHS_LIMIT = 30;

export const HEALTH_TOOL_DEF = {
  name: 'kioku_health',
  title: 'Get KIOKU wiki health metrics',
  description:
    'Compute 11 KIOKU memory health metrics (core 6: orphan / stale / duplicate_title / hot_md_age / last_ingest / unprocessed_logs; stretch 5: broken_wikilink / source_sha256_duplicate / pages_warm_zone / page_count_by_type / summaries_growth_rate) and return them as JSON. Read-only — does not modify wiki/. Use to assess "how usable is the wiki right now" rather than "how much was saved". Pair with scripts/generate-health.mjs which writes the same data to wiki/meta/health.md.',
  inputShape: {
    threshold_days: z
      .number()
      .int()
      .min(1)
      .max(3650)
      .optional()
      .describe(`Stale page threshold in days (default ${STALE_THRESHOLD_DAYS}). Also defines the upper bound of the warm zone (warm = 7 ≤ age < threshold_days).`),
    paths_limit: z
      .number()
      .int()
      .min(0)
      .max(500)
      .optional()
      .describe(`Cap for orphan/stale/warm_zone page lists in the response (default ${DEFAULT_PATHS_LIMIT}). 0 = no list, only counts.`),
  },
};

export async function handleHealth(vault, args = {}) {
  const thresholdDays = Number.isInteger(args.threshold_days)
    ? args.threshold_days
    : STALE_THRESHOLD_DAYS;
  const pathsLimit = Number.isInteger(args.paths_limit)
    ? args.paths_limit
    : DEFAULT_PATHS_LIMIT;

  const report = await collectHealthMetrics(vault, { staleThresholdDays: thresholdDays });

  // path 配列を limit で truncate (response size 抑制、LLM context 節約)
  const m = report.metrics;
  const truncated = {
    orphan_pages: m.orphan.pages.length > pathsLimit,
    stale_pages: m.stale.pages.length > pathsLimit,
    warm_zone_pages: m.pages_warm_zone.pages.length > pathsLimit,
  };
  const limitedMetrics = {
    ...m,
    orphan: {
      count: m.orphan.count,
      pages: m.orphan.pages.slice(0, pathsLimit),
    },
    stale: {
      count: m.stale.count,
      threshold_days: m.stale.threshold_days,
      pages: m.stale.pages.slice(0, pathsLimit),
    },
    pages_warm_zone: {
      count: m.pages_warm_zone.count,
      lower_days: m.pages_warm_zone.lower_days,
      upper_days: m.pages_warm_zone.upper_days,
      pages: m.pages_warm_zone.pages.slice(0, pathsLimit),
    },
  };

  return {
    schema_version: report.schema_version,
    generated_at: report.generated_at,
    vault_pages_total: report.vault_pages_total,
    metrics: limitedMetrics,
    next_actions: report.next_actions,
    truncated,
  };
}
