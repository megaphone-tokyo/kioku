#!/usr/bin/env node
// generate-health.mjs — KIOKU 記憶品質 dashboard 生成 (Sprint 2 v0.7.4)
//
// codex roadmap §P1 (plan/codex/260430_kioku-product-improvement-roadmap.md L283-315)
// 「KIOKU の価値を『どれだけ保存したか』ではなく『どれだけ使える記憶になっているか』
//  で測る」を実装。
//
// 6 core metrics (orphan / stale / duplicate / hot.md age / last ingest /
// unprocessed session-logs) を計算し wiki/meta/health.md (Markdown + JSON) として書く。
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
    'Computes 6 KIOKU memory health metrics and writes wiki/meta/health.md.',
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
