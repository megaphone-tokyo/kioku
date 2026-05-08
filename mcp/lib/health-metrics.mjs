// health-metrics.mjs — KIOKU 記憶品質 dashboard の metric 計算ライブラリ
//
// codex roadmap §P1 (plan/codex/260430_kioku-product-improvement-roadmap.md L283-315)
// に基づく "wiki が育っているか / 淀んでいるか" を測る 6 core metrics:
//   1. orphan pages           — 他から wikilink で参照されていない page
//   2. stale pages            — frontmatter `updated:` が 30 日以上前 (fallback: file mtime)
//   3. duplicate title groups — 同一 title (frontmatter > H1 > basename) の 2+ page
//   4. hot.md age             — wiki/hot.md の最終更新からの経過時間
//   5. last ingest activity   — session-logs/ の最新 mtime + ログ件数
//   6. unprocessed session-logs — frontmatter `ingested: false` の session-log 件数
//
// Acceptance criteria (codex roadmap L310-315):
//   - 「Wiki が育っている / 淀んでいる」を見て分かる
//   - auto-lint の結果と重複しすぎない (auto-lint は session→wiki ingest 品質、
//     本 module は ingest 後の wiki 自体の状態、責務分離)
//   - 数字だけでなく next action を出す (buildNextActions が actionable 提案を生成)
//
// 設計方針:
//   - Node 18+ stdlib + 既存 lib (frontmatter / wikilinks) のみ、新規外部依存なし
//   - 読み取り専用: wiki/ session-logs/ を **絶対に modify しない**
//   - test 可能性を優先: 個別 metric 関数を export、orchestrator (collectHealthMetrics) で合成
//   - vault root を引数で受け取り、environment 変数依存を持たない

import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import { parseFrontmatter } from './frontmatter.mjs';
import { findWikilinks } from './wikilinks.mjs';

export const STALE_THRESHOLD_DAYS = 30;
export const HEALTH_SCHEMA_VERSION = 1;

// wiki/ 走査時にスキップするディレクトリ (kioku_list の EXCLUDE と整合)
const EXCLUDE_DIRS = new Set(['.obsidian', '.archive', '.trash', 'templates', '.cache']);

// orphan / stale / duplicate 判定から除外する system page
//   - index.md / log.md / hot.md      : entry point + hot cache
const ORPHAN_EXEMPT_FILES = new Set(['index.md', 'log.md', 'hot.md']);
//   - meta/      : dashboard.md, health.md (本 module 出力)
//   - summaries/ : LLM 生成の要約 (機械生成、人間の wikilink 対象外)
//   - viz/       : visualizer 出力 (HTML、wikilink 対象外)
const ORPHAN_EXEMPT_TOP_DIRS = new Set(['meta', 'summaries', 'viz']);

function isSystemPage(rel) {
  if (ORPHAN_EXEMPT_FILES.has(rel)) return true;
  const top = rel.split('/')[0];
  return ORPHAN_EXEMPT_TOP_DIRS.has(top);
}

// wiki/ を再帰的に walk して .md file path を集める。
// 戻り値は { abs, rel } (rel は wiki/ からの相対パス、posix slash 統一)。
async function listWikiPages(vault) {
  const wikiDir = join(vault, 'wiki');
  let baseStat;
  try {
    baseStat = await stat(wikiDir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  if (!baseStat.isDirectory()) return [];

  const out = [];
  async function walk(absDir) {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      if (EXCLUDE_DIRS.has(ent.name)) continue;
      const abs = join(absDir, ent.name);
      if (ent.isDirectory()) {
        await walk(abs);
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        out.push(abs);
      }
    }
  }
  await walk(wikiDir);
  return out.map((abs) => ({ abs, rel: relative(wikiDir, abs).split(sep).join('/') }));
}

// 1 file から meta (frontmatter / body / mtime / wikilinks) を抽出。
// 読み込み失敗時は null を返す (corrupt file は metrics 集計から除外、stderr に出さない)。
async function readPageMeta(absPath) {
  let text;
  let st;
  try {
    [text, st] = await Promise.all([readFile(absPath, 'utf8'), stat(absPath)]);
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(text);
  return {
    abs: absPath,
    text,
    body,
    frontmatter: data,
    mtime: st.mtime,
    wikilinks: findWikilinks(text),
  };
}

// title 解決: frontmatter title > 本文 H1 > file basename (.md 除く)
function resolveTitle(meta, rel) {
  const fmTitle = meta.frontmatter?.title;
  if (typeof fmTitle === 'string' && fmTitle.trim()) return fmTitle.trim();
  const h1 = meta.body.match(/^#\s+(.+?)\s*$/m);
  if (h1) return h1[1].trim();
  return basename(rel, '.md');
}

// frontmatter `updated:` を Date に解釈。null / 不正値 の場合は fallback (file mtime) を返す。
function parseUpdatedDate(fmValue, fallbackMtime) {
  if (fmValue) {
    const s = typeof fmValue === 'string' ? fmValue.trim() : String(fmValue);
    if (s) {
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return fallbackMtime;
}

function humanDuration(seconds) {
  if (seconds === null || seconds === undefined) return null;
  const abs = Math.abs(seconds);
  if (abs < 60) return `${seconds}s`;
  if (abs < 3600) return `${Math.floor(seconds / 60)}m`;
  if (abs < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

// Metric 1: orphan pages
//
// 「他のどの wiki page からも wikilink 参照されていない page」を返す。
// system page (index.md / hot.md / meta/* / summaries/* / viz/*) は除外。
//
// マッチング規則 (Obsidian の wikilink resolution に倣う):
//   [[concepts/jwt]] → "concepts/jwt" / "jwt"
//   [[jwt]]          → "jwt"
//   [[Title]]        → "Title"  (basename match のみ、frontmatter title は本実装では未対応)
//
// page の rel が "concepts/jwt.md" であれば、"concepts/jwt" / "jwt" のいずれかが
// link target set に含まれていれば inbound あり扱い。
export function detectOrphans(pages) {
  const linkedTargets = new Set();
  for (const p of pages) {
    for (const target of p.meta.wikilinks) {
      const t = String(target).trim();
      if (!t) continue;
      linkedTargets.add(t);
      const last = t.split('/').pop();
      if (last) linkedTargets.add(last);
    }
  }
  const orphans = [];
  for (const p of pages) {
    if (isSystemPage(p.rel)) continue;
    const relNoExt = p.rel.replace(/\.md$/, '');
    const bn = basename(p.rel, '.md');
    if (linkedTargets.has(p.rel)) continue;
    if (linkedTargets.has(relNoExt)) continue;
    if (linkedTargets.has(bn)) continue;
    orphans.push(p.rel);
  }
  return orphans.sort();
}

// Metric 2: stale pages
//
// frontmatter `updated:` (YYYY-MM-DD or ISO) が thresholdDays 以上前の page を返す。
// `updated:` が無い場合は file mtime で判定。system page は除外 (索引や hot は性質上頻度が違う)。
export function detectStale(
  pages,
  { thresholdDays = STALE_THRESHOLD_DAYS, now = new Date() } = {},
) {
  const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;
  const out = [];
  for (const p of pages) {
    if (isSystemPage(p.rel)) continue;
    const updatedDate = parseUpdatedDate(p.meta.frontmatter?.updated, p.meta.mtime);
    const ageMs = now.getTime() - updatedDate.getTime();
    if (ageMs > thresholdMs) {
      const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      out.push({
        rel: p.rel,
        age_days: ageDays,
        updated: updatedDate.toISOString().slice(0, 10),
      });
    }
  }
  return out.sort((a, b) => b.age_days - a.age_days);
}

// Metric 3: duplicate title groups
//
// 解決後の title が大文字小文字を無視して同一の page が 2 件以上 → 1 group。
// system page は除外。表示順は title の locale compare で安定。
export function detectDuplicateTitles(pages) {
  const titleMap = new Map();
  for (const p of pages) {
    if (isSystemPage(p.rel)) continue;
    const title = resolveTitle(p.meta, p.rel);
    const key = title.toLowerCase();
    if (!titleMap.has(key)) titleMap.set(key, []);
    titleMap.get(key).push({ title, rel: p.rel });
  }
  const groups = [];
  for (const list of titleMap.values()) {
    if (list.length >= 2) {
      groups.push({
        title: list[0].title,
        paths: list.map((g) => g.rel).sort(),
      });
    }
  }
  return groups.sort((a, b) => a.title.localeCompare(b.title));
}

// Metric 4: hot.md age
//
// wiki/hot.md の mtime からの経過秒。file 不在 (= まだ hot cache が初期化されていない)
// の場合は exists:false を返す。
export async function getHotMdAge(vault, now = new Date()) {
  const path = join(vault, 'wiki', 'hot.md');
  try {
    const st = await stat(path);
    const ageSec = Math.floor((now.getTime() - st.mtime.getTime()) / 1000);
    return {
      exists: true,
      mtime_iso: st.mtime.toISOString(),
      age_seconds: ageSec,
      age_human: humanDuration(ageSec),
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { exists: false, mtime_iso: null, age_seconds: null, age_human: null };
    }
    throw err;
  }
}

// session-logs/ を再帰 walk。空 / 不在は空配列を返す。
async function listSessionLogs(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      const inner = await listSessionLogs(abs);
      out.push(...inner);
    } else if (ent.isFile() && ent.name.endsWith('.md')) {
      try {
        const st = await stat(abs);
        out.push({ abs, mtime: st.mtime });
      } catch {
        // ignore unreadable file
      }
    }
  }
  return out;
}

// Metric 5: last ingest activity (session-logs/ の最新 mtime + 件数)
export async function getLastIngestInfo(vault, now = new Date()) {
  const sessionLogsDir = join(vault, 'session-logs');
  const logs = await listSessionLogs(sessionLogsDir);
  if (logs.length === 0) {
    return { exists: false, log_count: 0, mtime_iso: null, age_seconds: null, age_human: null };
  }
  let latestMs = 0;
  for (const f of logs) {
    const ms = f.mtime.getTime();
    if (ms > latestMs) latestMs = ms;
  }
  const ageSec = Math.floor((now.getTime() - latestMs) / 1000);
  return {
    exists: true,
    log_count: logs.length,
    mtime_iso: new Date(latestMs).toISOString(),
    age_seconds: ageSec,
    age_human: humanDuration(ageSec),
  };
}

// Metric 6: unprocessed session-logs (frontmatter `ingested: false` の件数)
//
// session-logger-core.mjs:398 が `ingested: false` を初期値で書き、auto-ingest が成功時に
// `ingested: true` に書き換える契約。本 metric は cron が遅延していないか / 失敗が貯まって
// いないかの指標になる (5+ 件で next action を提案)。
//
// path 列挙は最大 PATH_SAMPLE_LIMIT 件で truncate (大量 backlog 時の output 肥大防止)。
const PATH_SAMPLE_LIMIT = 20;

export async function detectUnprocessedLogs(vault) {
  const sessionLogsDir = join(vault, 'session-logs');
  const logs = await listSessionLogs(sessionLogsDir);
  const unprocessed = [];
  for (const f of logs) {
    let text;
    try {
      text = await readFile(f.abs, 'utf8');
    } catch {
      continue;
    }
    const { data } = parseFrontmatter(text);
    // frontmatter.mjs は `false` literal を boolean に変換するので、念のため string 比較も持つ
    if (data.ingested === false || data.ingested === 'false') {
      unprocessed.push(relative(sessionLogsDir, f.abs).split(sep).join('/'));
    }
  }
  unprocessed.sort();
  return {
    count: unprocessed.length,
    sample_paths: unprocessed.slice(0, PATH_SAMPLE_LIMIT),
    sample_truncated: unprocessed.length > PATH_SAMPLE_LIMIT,
  };
}

// Next action 提案。数字だけでなく「次に何をすべきか」を出す (codex roadmap acceptance)。
// 各提案は { reason, action, command? } の形。command は実行可能 1-line を載せる。
export function buildNextActions(metrics) {
  const actions = [];
  if (metrics.orphan.count > 0) {
    actions.push({
      reason: `${metrics.orphan.count} orphan pages (no inbound wikilinks)`,
      action: 'Add wikilinks from related pages, or move to wiki/.archive/ if obsolete',
      command: 'cat wiki/meta/health.md  # see metrics.orphan.pages for full list',
    });
  }
  if (metrics.stale.count > 0) {
    actions.push({
      reason: `${metrics.stale.count} pages older than ${metrics.stale.threshold_days} days`,
      action: 'Open dashboard "Stale Pages" view and revisit / update / archive',
      command: 'open wiki/meta/dashboard.md',
    });
  }
  if (metrics.duplicate_title.count > 0) {
    actions.push({
      reason: `${metrics.duplicate_title.count} duplicate title groups`,
      action: 'Merge or rename duplicate pages — see metrics.duplicate_title.groups',
    });
  }
  if (metrics.hot_md_age.exists && metrics.hot_md_age.age_seconds > 7 * 24 * 3600) {
    actions.push({
      reason: `wiki/hot.md last updated ${metrics.hot_md_age.age_human} ago`,
      action: 'Refresh wiki/hot.md, or run a session that triggers PostCompact hook',
    });
  }
  if (metrics.last_ingest.exists && metrics.last_ingest.age_seconds > 24 * 3600) {
    actions.push({
      reason: `last session-log activity ${metrics.last_ingest.age_human} ago`,
      action: 'Verify session-logger hook is active',
      command: 'bash scripts/doctor.sh',
    });
  }
  if (metrics.unprocessed_logs.count > 5) {
    actions.push({
      reason: `${metrics.unprocessed_logs.count} unprocessed session-logs (ingested:false)`,
      action: 'Run auto-ingest manually, or wait for the next cron tick',
      command: 'bash scripts/auto-ingest.sh',
    });
  }
  return actions;
}

// Top-level orchestrator: 全 metric を 1 回の vault 走査で収集。
//
// options:
//   now                : Date — テスト用に "現在時刻" を fix
//   staleThresholdDays : number — stale 判定閾値 (default 30)
export async function collectHealthMetrics(vault, options = {}) {
  if (typeof vault !== 'string' || !vault) {
    throw new Error('collectHealthMetrics: vault path is required');
  }
  const now = options.now instanceof Date ? options.now : new Date();
  const thresholdDays = Number.isFinite(options.staleThresholdDays)
    ? options.staleThresholdDays
    : STALE_THRESHOLD_DAYS;

  const pageRefs = await listWikiPages(vault);
  const pages = [];
  for (const ref of pageRefs) {
    const meta = await readPageMeta(ref.abs);
    if (meta) pages.push({ rel: ref.rel, meta });
  }

  const orphans = detectOrphans(pages);
  const stale = detectStale(pages, { thresholdDays, now });
  const duplicates = detectDuplicateTitles(pages);
  const hotAge = await getHotMdAge(vault, now);
  const lastIngest = await getLastIngestInfo(vault, now);
  const unprocessed = await detectUnprocessedLogs(vault);

  const metrics = {
    orphan: { count: orphans.length, pages: orphans },
    stale: { count: stale.length, threshold_days: thresholdDays, pages: stale },
    duplicate_title: { count: duplicates.length, groups: duplicates },
    hot_md_age: hotAge,
    last_ingest: lastIngest,
    unprocessed_logs: unprocessed,
  };

  return {
    schema_version: HEALTH_SCHEMA_VERSION,
    generated_at: now.toISOString(),
    vault_pages_total: pages.length,
    metrics,
    next_actions: buildNextActions(metrics),
  };
}

// Test 用 internals (test 以外から import しないこと)
export const _internals = {
  isSystemPage,
  resolveTitle,
  parseUpdatedDate,
  humanDuration,
  listWikiPages,
  listSessionLogs,
  PATH_SAMPLE_LIMIT,
};
