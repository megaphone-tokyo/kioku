#!/usr/bin/env node
// generate-health.mjs — KIOKU 記憶品質 dashboard 生成 (Sprint 2 v0.7.4 + 完走 v0.7.5)
//
// codex roadmap §P1 (plan/codex/260430_kioku-product-improvement-roadmap.md L283-315)
// 「KIOKU の価値を『どれだけ保存したか』ではなく『どれだけ使える記憶になっているか』
//  で測る」を実装。
//
// 11 metrics (core 6 + stretch 5) を計算し wiki/meta/health.md (Markdown + JSON) として書く。
//   Core 6:    orphan / stale / duplicate / hot.md age / last ingest / unprocessed session-logs
//   Stretch 5: broken_wikilink / source_sha256_duplicate / pages_warm_zone /
//              page_count_by_type / summaries_growth_rate
//
// 環境変数:
//   OBSIDIAN_VAULT  Vault ルート (未設定時は $HOME/claude-brain/main-claude-brain)
//   KIOKU_HEALTH_OUTPUT  output 相対パス (default: wiki/meta/health.md)
//
// 使用例:
//   node scripts/generate-health.mjs           # health.md 生成
//   node scripts/generate-health.mjs --json    # stdout に JSON 出力 (file 書かない)
//   node scripts/generate-health.mjs --dry-run # file 書かず human summary のみ
//
// Exit code:
//   0 = 正常終了
//   1 = vault 不在 / write 失敗
//
// 設計方針:
//   - 読み取り専用 (wiki/ session-logs/ は touch しない、出力先は wiki/meta/health.md のみ)
//   - 既存 dashboard.base / auto-lint と非干渉 (出力先別 path、責務分離)
//   - atomic write (temp + rename) で half-write 防止

import { homedir } from 'node:os';
import { mkdir, rename, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { collectHealthMetrics } from '../mcp/lib/health-metrics.mjs';

const DEFAULT_OUTPUT_REL = 'wiki/meta/health.md';

function parseArgs(argv) {
  const out = { json: false, dryRun: false };
  for (const a of argv) {
    if (a === '--json') out.json = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '-h' || a === '--help') {
      console.log(usageText());
      process.exit(0);
    } else {
      console.error(`generate-health: unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function usageText() {
  return [
    'Usage: node scripts/generate-health.mjs [--json|--dry-run]',
    '',
    'Computes 11 KIOKU memory health metrics (core 6 + stretch 5) and writes wiki/meta/health.md.',
    '',
    '  (no arg)   Generate wiki/meta/health.md (Markdown + JSON appendix)',
    '  --json     Print metrics as JSON to stdout, do not write file',
    '  --dry-run  Print human summary to stdout, do not write file',
  ].join('\n');
}

function resolveVault() {
  return process.env.OBSIDIAN_VAULT || join(homedir(), 'claude-brain', 'main-claude-brain');
}

// Markdown report renderer
export function renderMarkdown(report) {
  const m = report.metrics;
  const lines = [];
  lines.push('---');
  lines.push('type: health-report');
  lines.push('title: KIOKU Wiki Health');
  lines.push(`generated_at: ${report.generated_at}`);
  lines.push(`schema_version: ${report.schema_version}`);
  lines.push(`vault_pages_total: ${report.vault_pages_total}`);
  lines.push('---');
  lines.push('');
  lines.push('# KIOKU Wiki Health');
  lines.push('');
  lines.push(`> Generated at ${report.generated_at} — ${report.vault_pages_total} wiki pages total`);
  lines.push('>');
  lines.push('> This file is **auto-generated** by `scripts/generate-health.mjs`.');
  lines.push('> Do not edit by hand — changes will be overwritten on next run.');
  lines.push('');
  lines.push('## Metrics');
  lines.push('');
  lines.push('| Metric | Value | Status |');
  lines.push('|---|---|---|');
  lines.push(`| Orphan pages | ${m.orphan.count} | ${statusBadge(m.orphan.count, 0)} |`);
  lines.push(`| Stale pages (>${m.stale.threshold_days} days) | ${m.stale.count} | ${statusBadge(m.stale.count, 0)} |`);
  lines.push(`| Duplicate title groups | ${m.duplicate_title.count} | ${statusBadge(m.duplicate_title.count, 0)} |`);
  lines.push(`| hot.md age | ${m.hot_md_age.exists ? m.hot_md_age.age_human : '(missing)'} | ${hotMdStatus(m.hot_md_age)} |`);
  lines.push(`| Last session-log activity | ${m.last_ingest.exists ? m.last_ingest.age_human + ` (${m.last_ingest.log_count} logs)` : '(empty)'} | ${ingestStatus(m.last_ingest)} |`);
  lines.push(`| Unprocessed session-logs (ingested:false) | ${m.unprocessed_logs.count} | ${unprocessedStatus(m.unprocessed_logs)} |`);
  lines.push(`| Broken wikilinks ([[X]] target unresolved) | ${m.broken_wikilink.count} | ${statusBadge(m.broken_wikilink.count, 0)} |`);
  lines.push(`| Source sha256 duplicate groups | ${m.source_sha256_duplicate.count} | ${statusBadge(m.source_sha256_duplicate.count, 0)} |`);
  lines.push(`| Pages in warm zone (${m.pages_warm_zone.lower_days}-${m.pages_warm_zone.upper_days}d) | ${m.pages_warm_zone.count} | ${warmZoneStatus(m.pages_warm_zone)} |`);
  lines.push(`| Page types | ${formatTypeBreakdown(m.page_count_by_type)} | INFO |`);
  lines.push(`| Summaries growth (7d / 30d) | ${formatGrowthSummary(m.summaries_growth_rate)} | ${growthStatus(m.summaries_growth_rate)} |`);
  lines.push('');

  if (m.orphan.count > 0) {
    lines.push(`## Orphan pages (${m.orphan.count})`);
    lines.push('');
    lines.push('Pages with no inbound wikilinks. Add a link from a related page or move to `wiki/.archive/` if obsolete.');
    lines.push('');
    for (const p of m.orphan.pages.slice(0, 30)) {
      lines.push(`- [[${p.replace(/\.md$/, '')}]]`);
    }
    if (m.orphan.pages.length > 30) {
      lines.push(`- ... (${m.orphan.pages.length - 30} more)`);
    }
    lines.push('');
  }

  if (m.stale.count > 0) {
    lines.push(`## Stale pages (${m.stale.count}, >${m.stale.threshold_days} days)`);
    lines.push('');
    lines.push('| Page | Updated | Age (days) |');
    lines.push('|---|---|---|');
    for (const s of m.stale.pages.slice(0, 30)) {
      lines.push(`| [[${s.rel.replace(/\.md$/, '')}]] | ${s.updated} | ${s.age_days} |`);
    }
    if (m.stale.pages.length > 30) {
      lines.push(`| ... | ... | (+${m.stale.pages.length - 30} more) |`);
    }
    lines.push('');
  }

  if (m.duplicate_title.count > 0) {
    lines.push(`## Duplicate title groups (${m.duplicate_title.count})`);
    lines.push('');
    for (const g of m.duplicate_title.groups) {
      lines.push(`- **${g.title}**`);
      for (const p of g.paths) {
        lines.push(`  - \`${p}\``);
      }
    }
    lines.push('');
  }

  if (m.unprocessed_logs.count > 0) {
    lines.push(`## Unprocessed session-logs (${m.unprocessed_logs.count})`);
    lines.push('');
    lines.push('Session-logs with `ingested: false`. Auto-ingest cron will process these on the next tick.');
    lines.push('');
    for (const p of m.unprocessed_logs.sample_paths) {
      lines.push(`- \`session-logs/${p}\``);
    }
    if (m.unprocessed_logs.sample_truncated) {
      lines.push(`- ... (${m.unprocessed_logs.count - m.unprocessed_logs.sample_paths.length} more not shown)`);
    }
    lines.push('');
  }

  if (m.broken_wikilink.count > 0) {
    lines.push(`## Broken wikilinks (${m.broken_wikilink.count})`);
    lines.push('');
    lines.push('`[[X]]` references whose target page does not exist in `wiki/`. Either create the target page, fix a typo, or remove the link.');
    lines.push('');
    lines.push('| Source page | Broken target |');
    lines.push('|---|---|');
    for (const b of m.broken_wikilink.samples) {
      lines.push(`| \`${b.source}\` | \`[[${b.target}]]\` |`);
    }
    if (m.broken_wikilink.sample_truncated) {
      lines.push(`| ... | (+${m.broken_wikilink.count - m.broken_wikilink.samples.length} more) |`);
    }
    lines.push('');
  }

  if (m.source_sha256_duplicate.count > 0) {
    lines.push(`## Source sha256 duplicate groups (${m.source_sha256_duplicate.count})`);
    lines.push('');
    lines.push('Pages sharing the same `source_sha256:` frontmatter — likely duplicate ingest of the same source. Consider merging or archiving the redundant pages.');
    lines.push('');
    for (const g of m.source_sha256_duplicate.groups) {
      lines.push(`- **sha256: \`${g.source_sha256.slice(0, 16)}…\`**`);
      for (const p of g.paths) {
        lines.push(`  - \`${p}\``);
      }
    }
    lines.push('');
  }

  if (m.pages_warm_zone.count > 0) {
    lines.push(`## Pages in warm zone (${m.pages_warm_zone.count}, ${m.pages_warm_zone.lower_days}-${m.pages_warm_zone.upper_days} days)`);
    lines.push('');
    lines.push('Pages that are aging but not yet stale. Consider revisiting before they cross the stale threshold.');
    lines.push('');
    lines.push('| Page | Updated | Age (days) |');
    lines.push('|---|---|---|');
    for (const p of m.pages_warm_zone.pages.slice(0, 30)) {
      lines.push(`| [[${p.rel.replace(/\.md$/, '')}]] | ${p.updated} | ${p.age_days} |`);
    }
    if (m.pages_warm_zone.pages.length > 30) {
      lines.push(`| ... | ... | (+${m.pages_warm_zone.pages.length - 30} more) |`);
    }
    lines.push('');
  }

  // page_count_by_type: 常に表示 (count 0 でも有用な distribution 情報)
  if (m.page_count_by_type.total > 0) {
    lines.push(`## Page count by type (total ${m.page_count_by_type.total})`);
    lines.push('');
    lines.push('| Type | Count |');
    lines.push('|---|---|');
    for (const [type, count] of Object.entries(m.page_count_by_type.by_type)) {
      lines.push(`| ${type} | ${count} |`);
    }
    lines.push('');
  }

  // summaries_growth_rate: git 不可なら note を表示
  lines.push('## Summaries growth rate');
  lines.push('');
  if (m.summaries_growth_rate.vault_is_git === false) {
    lines.push('_Vault is not a git repository — growth rate cannot be computed._');
    lines.push('');
  } else {
    const r = m.summaries_growth_rate;
    lines.push(`- **Last 7 days:** ${r.day_7.added} new summary file(s) (${r.day_7.per_day}/day)`);
    lines.push(`- **Last 30 days:** ${r.day_30.added} new summary file(s) (${r.day_30.per_day}/day)`);
    if (r.error) {
      lines.push(`- _Note: ${r.error}_`);
    }
    lines.push('');
  }

  if (report.next_actions.length > 0) {
    lines.push('## Next actions');
    lines.push('');
    for (const a of report.next_actions) {
      lines.push(`- **${a.reason}**`);
      lines.push(`  - ${a.action}`);
      if (a.command) {
        lines.push('  - Command: `' + a.command + '`');
      }
    }
    lines.push('');
  } else {
    lines.push('## Next actions');
    lines.push('');
    lines.push('No actions needed — wiki health looks good. ✓');
    lines.push('');
  }

  lines.push('## Raw metrics (JSON)');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(report, null, 2));
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

function statusBadge(count, healthyValue) {
  return count === healthyValue ? 'OK' : `WARN (${count})`;
}

function hotMdStatus(info) {
  if (!info.exists) return 'INFO (not initialized)';
  if (info.age_seconds > 7 * 24 * 3600) return `WARN (${info.age_human})`;
  return 'OK';
}

function ingestStatus(info) {
  if (!info.exists) return 'INFO (no logs yet)';
  if (info.age_seconds > 24 * 3600) return `WARN (${info.age_human} since last log)`;
  return 'OK';
}

function unprocessedStatus(info) {
  if (info.count === 0) return 'OK';
  if (info.count <= 5) return `INFO (${info.count})`;
  return `WARN (${info.count})`;
}

function warmZoneStatus(info) {
  // warm zone は WARN というより INFO 寄り (revisit 候補の見える化)
  if (info.count === 0) return 'OK';
  return `INFO (${info.count})`;
}

function formatTypeBreakdown(info) {
  const entries = Object.entries(info.by_type);
  if (entries.length === 0) return '(none)';
  // top 5 entries を inline で表示、超過分は "..."
  const top = entries.slice(0, 5).map(([t, n]) => `${t}=${n}`).join(', ');
  return entries.length > 5 ? `${top}, … (+${entries.length - 5} more types)` : top;
}

function formatGrowthSummary(info) {
  if (info.vault_is_git === false) return '(non-git vault)';
  return `${info.day_7.added} / ${info.day_30.added}`;
}

function growthStatus(info) {
  if (info.vault_is_git === false) return 'INFO (not git)';
  if (info.day_30.added === 0) return 'WARN (idle)';
  return 'OK';
}

function renderHumanSummary(report) {
  const m = report.metrics;
  const lines = [];
  lines.push(`KIOKU Wiki Health — ${report.generated_at}`);
  lines.push(`  Pages total: ${report.vault_pages_total}`);
  lines.push(`  Orphan: ${m.orphan.count}`);
  lines.push(`  Stale (>${m.stale.threshold_days}d): ${m.stale.count}`);
  lines.push(`  Duplicate titles: ${m.duplicate_title.count}`);
  lines.push(`  hot.md age: ${m.hot_md_age.exists ? m.hot_md_age.age_human : '(missing)'}`);
  lines.push(`  Last ingest: ${m.last_ingest.exists ? m.last_ingest.age_human + ' ago (' + m.last_ingest.log_count + ' logs)' : '(empty)'}`);
  lines.push(`  Unprocessed logs: ${m.unprocessed_logs.count}`);
  lines.push(`  Broken wikilinks: ${m.broken_wikilink.count}`);
  lines.push(`  Source sha256 duplicates: ${m.source_sha256_duplicate.count}`);
  lines.push(`  Pages warm zone (${m.pages_warm_zone.lower_days}-${m.pages_warm_zone.upper_days}d): ${m.pages_warm_zone.count}`);
  lines.push(`  Page types: ${formatTypeBreakdown(m.page_count_by_type)}`);
  if (m.summaries_growth_rate.vault_is_git === false) {
    lines.push(`  Summaries growth: (non-git vault)`);
  } else {
    lines.push(`  Summaries growth (7d/30d): ${m.summaries_growth_rate.day_7.added} / ${m.summaries_growth_rate.day_30.added}`);
  }
  if (report.next_actions.length > 0) {
    lines.push('');
    lines.push('Next actions:');
    for (const a of report.next_actions) {
      lines.push(`  - ${a.reason}`);
      lines.push(`    → ${a.action}`);
    }
  }
  return lines.join('\n');
}

async function atomicWrite(absPath, content) {
  await mkdir(dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, absPath);
  } catch (err) {
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const vault = resolveVault();

  let st;
  try {
    st = await stat(vault);
  } catch {
    console.error(`generate-health: OBSIDIAN_VAULT not found: ${vault}`);
    process.exit(1);
  }
  if (!st.isDirectory()) {
    console.error(`generate-health: OBSIDIAN_VAULT is not a directory: ${vault}`);
    process.exit(1);
  }

  const report = await collectHealthMetrics(vault);

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  if (args.dryRun) {
    process.stdout.write(renderHumanSummary(report) + '\n');
    return;
  }

  const outputRel = process.env.KIOKU_HEALTH_OUTPUT || DEFAULT_OUTPUT_REL;
  const absOutput = join(vault, outputRel);
  const md = renderMarkdown(report);
  await atomicWrite(absOutput, md);
  process.stdout.write(`generate-health: wrote ${absOutput} (${report.vault_pages_total} pages, ${report.next_actions.length} actions)\n`);
}

// ESM entry gate (LEARN#14): test 等で import されたときは main() を実行しない
function isEntry() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isEntry()) {
  main().catch((err) => {
    console.error(`generate-health: ${err.message}`);
    process.exit(1);
  });
}

// Test 用 export (test 以外から import しないこと)
export const _internals = { renderMarkdown, renderHumanSummary, parseArgs, resolveVault };
