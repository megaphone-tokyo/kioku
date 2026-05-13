// health-metrics.mjs — KIOKU 記憶品質 dashboard の metric 計算ライブラリ
//
// codex roadmap §P1 (plan/codex/260430_kioku-product-improvement-roadmap.md L283-315)
// に基づく "wiki が育っているか / 淀んでいるか" を測る 11 metrics:
//
// Core 6 metrics (Sprint 2 v0.7.4):
//   1. orphan pages           — 他から wikilink で参照されていない page
//   2. stale pages            — frontmatter `updated:` が 30 日以上前 (fallback: file mtime)
//   3. duplicate title groups — 同一 title (frontmatter > H1 > basename) の 2+ page
//   4. hot.md age             — wiki/hot.md の最終更新からの経過時間
//   5. last ingest activity   — session-logs/ の最新 mtime + ログ件数
//   6. unprocessed session-logs — frontmatter `ingested: false` の session-log 件数
//
// Stretch 5 metrics (Sprint 2 完走 v0.7.5):
//   7. broken wikilink        — `[[X]]` で参照される target が wiki 内に存在しない件数
//   8. source_sha256 duplicate — wiki/summaries/ 配下で同 sha256 の page 群件数
//   9. pages warm zone        — 7 ≤ updated < 30 日 (stale と fresh の中間帯)
//  10. page count by type     — concept/project/decision/summary/その他 の breakdown
//  11. summaries growth rate  — wiki/summaries/ への新規 add 件数 (直近 7d / 30d、git log 経由)
//
// Acceptance criteria (codex roadmap L310-315):
//   - 「Wiki が育っている / 淀んでいる」を見て分かる
//   - auto-lint の結果と重複しすぎない (auto-lint = session→wiki ingest 品質、
//     本 module = ingest 後 wiki 自体の状態、責務分離)
//   - 数字だけでなく next action を出す (buildNextActions が actionable 提案を生成)
//
// 設計方針:
//   - Node 18+ stdlib + 既存 lib (frontmatter / wikilinks) のみ、新規外部依存なし
//   - 読み取り専用: wiki/ session-logs/ を **絶対に modify しない**
//   - test 可能性を優先: 個別 metric 関数を export、orchestrator (collectHealthMetrics) で合成
//   - vault root を引数で受け取り、environment 変数依存を持たない
//   - git 依存 metric (summaries_growth_rate) は non-git vault で graceful degrade

import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { parseFrontmatter } from './frontmatter.mjs';
import { findWikilinks } from './wikilinks.mjs';
import {
  walkPages,
  listMarkdownRefs,
  inferPageType as inferPageTypeShared,
} from './wiki-walker.mjs';

const execFileAsync = promisify(execFile);

export const STALE_THRESHOLD_DAYS = 30;
export const WARM_ZONE_LOWER_DAYS = 7;
export const HEALTH_SCHEMA_VERSION = 2;

// Re-export for back-compat (Sprint 3 Phase 3 §46 N=3 refactor): inferPageType now
// lives in wiki-walker.mjs as the shared canonical impl. tests/health-metrics.test.mjs
// imports it directly from health-metrics; keep the named export stable.
export const inferPageType = inferPageTypeShared;

// wiki/ 走査時にスキップするディレクトリ (kioku_list の EXCLUDE と整合)
// Kept for back-compat — wiki-walker.mjs#DEFAULT_EXCLUDE_DIRS holds the canonical set.
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

// Back-compat shim: tests/health-metrics.test.mjs accesses `_internals.listWikiPages`.
// Real walk now lives in wiki-walker.mjs (§46 N=3 refactor). Returns [{abs, rel}].
async function listWikiPages(vault) {
  return listMarkdownRefs(vault, { subDir: 'wiki' });
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

// ---------------------------------------------------------------------------
// Stretch metrics (Sprint 2 完走 v0.7.5)
// ---------------------------------------------------------------------------

// Metric 7: broken wikilink count
//
// `[[X]]` 形式で参照される target が wiki 内に解決できないリンクを返す。
// detectOrphans の inverse (orphan = inbound 不足、broken = outbound 解決不能)。
//
// 解決規則 (Obsidian と detectOrphans 両者と整合):
//   target が以下いずれかに hit すれば valid:
//     - p.rel そのもの (例: "concepts/jwt.md")
//     - p.rel から .md を除去 (例: "concepts/jwt")
//     - basename (例: "jwt")
//
// system page も含めて全 page を target 候補にする (orphan 判定で除外する system page でも
// link target としては valid なため。例: `[[index]]` は valid link)。
const BROKEN_WIKILINK_SAMPLE_LIMIT = 30;

export function detectBrokenWikilinks(pages) {
  const pathSet = new Set();
  for (const p of pages) {
    pathSet.add(p.rel);
    pathSet.add(p.rel.replace(/\.md$/, ''));
    pathSet.add(basename(p.rel, '.md'));
  }
  const broken = [];
  for (const p of pages) {
    for (const target of p.meta.wikilinks) {
      const t = String(target).trim();
      if (!t) continue;
      if (pathSet.has(t)) continue;
      // 大文字小文字を吸収した二次マッチ (Obsidian の wikilink 解決は基本 case-insensitive)
      const lower = t.toLowerCase();
      let resolvedCaseInsensitive = false;
      for (const candidate of pathSet) {
        if (candidate.toLowerCase() === lower) {
          resolvedCaseInsensitive = true;
          break;
        }
      }
      if (resolvedCaseInsensitive) continue;
      broken.push({ source: p.rel, target: t });
    }
  }
  // sort: source path then target — deterministic
  broken.sort((a, b) => {
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    return a.target.localeCompare(b.target);
  });
  return {
    count: broken.length,
    samples: broken.slice(0, BROKEN_WIKILINK_SAMPLE_LIMIT),
    sample_truncated: broken.length > BROKEN_WIKILINK_SAMPLE_LIMIT,
  };
}

// Metric 8: source_sha256 duplicate groups
//
// wiki/summaries/ 配下の page が `source_sha256:` frontmatter を持つ場合、同 sha256 値の
// page を group 化し count >= 2 の group 数を返す。同 source PDF/URL から複数の summary
// が誤生成された (idempotent ingest が壊れた) 警告として機能。
//
// 設計: summaries/ 以外も `source_sha256:` を持ちうる (mcp-note の一部) ため、frontmatter
// 持ちの全 page を対象にする。実害は同じく "同 source の重複 page" を検出すること。
export function detectSourceSha256Duplicates(pages) {
  const sha256Map = new Map();
  for (const p of pages) {
    const sha = p.meta.frontmatter?.source_sha256;
    if (typeof sha !== 'string') continue;
    const key = sha.trim().toLowerCase();
    if (!key) continue;
    if (!sha256Map.has(key)) sha256Map.set(key, []);
    sha256Map.get(key).push(p.rel);
  }
  const groups = [];
  for (const [sha256, paths] of sha256Map.entries()) {
    if (paths.length >= 2) {
      groups.push({ source_sha256: sha256, paths: paths.slice().sort() });
    }
  }
  groups.sort((a, b) => a.source_sha256.localeCompare(b.source_sha256));
  return { count: groups.length, groups };
}

// Metric 9: pages in warm zone
//
// `updated:` (or fallback file mtime) が WARM_ZONE_LOWER_DAYS ≤ age < staleThresholdDays
// の page を返す。stale と fresh の中間帯で「そろそろ revisit したほうがいい」signal。
// system page は除外 (stale と同じ logic)。
export function detectWarmZonePages(
  pages,
  {
    lowerDays = WARM_ZONE_LOWER_DAYS,
    upperDays = STALE_THRESHOLD_DAYS,
    now = new Date(),
  } = {},
) {
  const lowerMs = lowerDays * 24 * 60 * 60 * 1000;
  const upperMs = upperDays * 24 * 60 * 60 * 1000;
  const out = [];
  for (const p of pages) {
    if (isSystemPage(p.rel)) continue;
    const updatedDate = parseUpdatedDate(p.meta.frontmatter?.updated, p.meta.mtime);
    const ageMs = now.getTime() - updatedDate.getTime();
    if (ageMs >= lowerMs && ageMs < upperMs) {
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

// Metric 10: page count by type
//
// type 推論の優先順位: system page (index/log/hot) → frontmatter.type → top-dir map → 'other'。
// Implementation moved to wiki-walker.mjs#inferPageType (§46 N=3 refactor).
// `export const inferPageType` near the top of the file is the active binding;
// keeping countPagesByType here keeps the metrics API surface stable.

export function countPagesByType(pages) {
  const counts = {};
  for (const p of pages) {
    const t = inferPageType(p.rel, p.meta.frontmatter);
    counts[t] = (counts[t] || 0) + 1;
  }
  // ascending key で出力 — UI 表示の安定性
  const sorted = {};
  for (const k of Object.keys(counts).sort()) {
    sorted[k] = counts[k];
  }
  return { total: pages.length, by_type: sorted };
}

// Metric 11: summaries growth rate
//
// 直近 7 日 / 30 日に wiki/summaries/ 配下に新規追加された .md (`-summary.md` 限定ではなく
// 全 .md、Obsidian filename ゆれに頑健) の件数を git log から数える。
//
// 戻り値:
//   {
//     vault_is_git: boolean,
//     day_7:  { added: number, per_day: number },
//     day_30: { added: number, per_day: number },
//     error?: 'not_a_git_repo' | 'git_failed'  // vault_is_git=false の時のみ
//   }
//
// non-git vault では vault_is_git: false + 0 件で graceful degrade (acceptance: crash させない)。
// git is_inside_work_tree check は cwd dependent なので {cwd: vault} で実行。
async function gitAddCountSince(vault, sinceDays) {
  // --diff-filter=A: addition only / --since=<n> days ago (relative date)
  // --pretty=format: 空にして name-only のみ印字 / 最後 --: pathspec 区切り
  const args = [
    'log',
    `--since=${sinceDays} days ago`,
    '--diff-filter=A',
    '--name-only',
    '--pretty=format:',
    '--',
    'wiki/summaries/',
  ];
  const { stdout } = await execFileAsync('git', args, {
    cwd: vault,
    timeout: 10_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const lines = stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.endsWith('.md'));
  return lines.length;
}

export async function getSummariesGrowthRate(vault, { now = new Date() } = {}) {
  // ignore now param for git command (git interprets relative dates from current time);
  // signature accepts now for future-proofing if we move to absolute --since=ISO.
  void now;

  // step 1: git work tree check
  let isInsideWorkTree = false;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      { cwd: vault, timeout: 5_000 },
    );
    isInsideWorkTree = stdout.trim() === 'true';
  } catch {
    return {
      vault_is_git: false,
      day_7: { added: 0, per_day: 0 },
      day_30: { added: 0, per_day: 0 },
      error: 'not_a_git_repo',
    };
  }
  if (!isInsideWorkTree) {
    return {
      vault_is_git: false,
      day_7: { added: 0, per_day: 0 },
      day_30: { added: 0, per_day: 0 },
      error: 'not_a_git_repo',
    };
  }

  // step 2: count adds in 7d / 30d windows
  try {
    const [day7, day30] = await Promise.all([
      gitAddCountSince(vault, 7),
      gitAddCountSince(vault, 30),
    ]);
    return {
      vault_is_git: true,
      day_7: { added: day7, per_day: Math.round((day7 / 7) * 100) / 100 },
      day_30: { added: day30, per_day: Math.round((day30 / 30) * 100) / 100 },
    };
  } catch {
    return {
      vault_is_git: true,
      day_7: { added: 0, per_day: 0 },
      day_30: { added: 0, per_day: 0 },
      error: 'git_failed',
    };
  }
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
  // Stretch metrics next_actions (Sprint 2 完走 v0.7.5)
  if (metrics.broken_wikilink && metrics.broken_wikilink.count > 0) {
    actions.push({
      reason: `${metrics.broken_wikilink.count} broken wikilinks ([[X]] target が wiki に存在しない)`,
      action: 'orphan link を修正 (target page を作成 or 命名揺れを fix)、または link 元 page を整理',
      command: 'cat wiki/meta/health.md  # see metrics.broken_wikilink.samples',
    });
  }
  if (metrics.source_sha256_duplicate && metrics.source_sha256_duplicate.count > 0) {
    actions.push({
      reason: `${metrics.source_sha256_duplicate.count} source_sha256 duplicate group(s) — 同一 source から重複 page`,
      action: '重複 page を merge or archive (idempotent ingest が壊れている可能性あり、ingest path を確認)',
    });
  }
  if (metrics.pages_warm_zone && metrics.pages_warm_zone.count > 5) {
    actions.push({
      reason: `${metrics.pages_warm_zone.count} pages in warm zone (7-${metrics.pages_warm_zone.upper_days} days)`,
      action: '更新候補が溜まっている。stale 化する前に revisit / 内容更新 / 関連リンク補強を検討',
    });
  }
  if (metrics.summaries_growth_rate) {
    const r = metrics.summaries_growth_rate;
    if (r.vault_is_git === false) {
      // graceful info: git ではない vault では本 metric は計測不能。next action は提示しない。
    } else if (r.day_7.added === 0 && r.day_30.added === 0) {
      actions.push({
        reason: 'No new summaries added in the last 30 days (ingest pipeline idle?)',
        action: 'PDF/URL ingest cron が回っているか確認、または新規 source を投入',
        command: 'bash scripts/auto-ingest.sh',
      });
    }
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

  // §46 N=3 refactor: single-pass walk via wiki-walker.mjs (replaces listWikiPages+readPageMeta).
  // Mapped to legacy {rel, meta} shape so the existing detect* helpers (orphan / stale / dup / ...) keep working.
  const walked = await walkPages(vault, {
    subDir: 'wiki',
    withBody: true,
    withMtime: true,
  });
  const pages = walked.map((p) => ({
    rel: p.rel,
    meta: {
      abs: p.abs,
      text: p.text,
      body: p.body,
      frontmatter: p.frontmatter,
      mtime: p.mtime,
      wikilinks: p.wikilinks,
    },
  }));

  const orphans = detectOrphans(pages);
  const stale = detectStale(pages, { thresholdDays, now });
  const duplicates = detectDuplicateTitles(pages);
  const hotAge = await getHotMdAge(vault, now);
  const lastIngest = await getLastIngestInfo(vault, now);
  const unprocessed = await detectUnprocessedLogs(vault);

  // Stretch 5 (Sprint 2 完走 v0.7.5)
  const broken = detectBrokenWikilinks(pages);
  const sha256Dups = detectSourceSha256Duplicates(pages);
  const warm = detectWarmZonePages(pages, {
    lowerDays: WARM_ZONE_LOWER_DAYS,
    upperDays: thresholdDays,
    now,
  });
  const byType = countPagesByType(pages);
  const growth = await getSummariesGrowthRate(vault, { now });

  const metrics = {
    orphan: { count: orphans.length, pages: orphans },
    stale: { count: stale.length, threshold_days: thresholdDays, pages: stale },
    duplicate_title: { count: duplicates.length, groups: duplicates },
    hot_md_age: hotAge,
    last_ingest: lastIngest,
    unprocessed_logs: unprocessed,
    broken_wikilink: broken,
    source_sha256_duplicate: sha256Dups,
    pages_warm_zone: {
      count: warm.length,
      lower_days: WARM_ZONE_LOWER_DAYS,
      upper_days: thresholdDays,
      pages: warm,
    },
    page_count_by_type: byType,
    summaries_growth_rate: growth,
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
  BROKEN_WIKILINK_SAMPLE_LIMIT,
};
