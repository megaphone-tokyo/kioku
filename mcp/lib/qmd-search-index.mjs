// qmd-search-index.mjs — Precompute top-N popular queries for shell snapshot mode.
//
// Plan: tools/claude-brain/plan/claude/26051402_v0-9-phase2-qmd-search-impl-plan.md §「PR A2」
// Architectural Decision: tools/claude-brain/plan/claude/26051403_meeting_phase2-architectural-decision-option-c.md
//   (Option C = Option A snapshot precomputed を Claude-augmented Search の Tier 1+2 design として意図化)
//
// Responsibility:
//   - Discover top-N "interesting queries" from vault state (referenced tags + recent headings).
//   - For each query, call kioku_search (lex/vec/hybrid) -> collect top-K results.
//   - Return shell-consumable JSON shape (no body leak, escape-ready strings).
//
// Exports:
//   buildSearchIndex(vault, options?) -> SearchIndex
//   SEARCH_INDEX_SCHEMA_VERSION (=1)
//   __test__ (internal helpers exposed for unit tests only)
//
// Security:
//   - Result snippets are textContent-safe strings (no HTML escape here; render layer responsible).
//   - No body / file path absolute leak (rel paths only, body field dropped by normalizeResults).
//   - Path C+beta boundary: no editor / Canvas write / Plugin loader / cloud connector / fetch family.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { handleSearch } from '../tools/search.mjs';
import { getFileHistory, isGitRepo } from './git-history.mjs';
import { scanSessionLogs } from './discoverqueries-learning.mjs';

export const SEARCH_INDEX_SCHEMA_VERSION = 1;

const DEFAULT_TOP_QUERIES = 10;
const DEFAULT_RESULTS_PER_QUERY = 10;
const MAX_TOP_QUERIES = 30;
const MAX_RESULTS_PER_QUERY = 20;

// Tag regex: #word-with-hyphen 形式、#1 等の純数字は除外、最低 2 文字。
// LEARN#13: regex literal 内 invisible unicode は禁止だが本 regex は ASCII のみで safe。
const TAG_RE = /(?:^|[^\w])#([a-z][a-z0-9-]{1,30})/gi;

// wikilink: [[name]] 形式 (name に ] を含まない)。
const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g;

// heading: # から始まる ATX h1-h3 (簡易抽出、log entry の "- " bullet は除外)。
const HEADING_RE = /^#{1,3}\s+(.+?)\s*$/gm;

// raw-sources / wiki/*.md broadly-referenced 用: ATX h1 + h2 のみ。
const HEADING_H1H2_RE = /^#{1,2}\s+(.+?)\s*$/gm;

// hot.md 単独行 #tag: 行頭 → #tag → 行末 (空白許容、ASCII tag 名のみ、log inline #tag と区別)。
// LEARN#13: ASCII のみ、invisible unicode 不使用。
const STANDALONE_TAG_RE = /^\s*#([a-z][a-z0-9-]{1,30})\s*$/gim;

// Source 3 / wiki/*.md heading scan cap (mirrors MAX_RAW_SOURCES_SCAN).
const MAX_SCAN_FILES = 30;

// Source 8 recency decay (v0.11 S6-7, axis F): session-logs 由来 candidate の
// score に指数減衰 0.5^(ageDays / halfLife) を掛ける。halfLife default は 14 日
// (暫定 default — meeting 26070701 G-5: 効果測定と再調整は publish 後の観察期間
// データで行う)。env KIOKU_DQ_HALFLIFE_DAYS で override 可。
const DQ_RECENCY_HALFLIFE_DAYS_DEFAULT = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// halfLife 解決: env が正の有限数ならその値、それ以外 (未設定 / 空 / NaN / 0 /
// 負値 / Infinity) は default 14 に fallback。負値をそのまま使うと
// 0.5^(age/負値) が指数増幅になるため、defensive に default へ落とす。
// 呼び出しの度に env を読む (test が動的に env を差し替えられるよう module
// load 時に固定しない)。
function resolveDqHalfLifeDays() {
  const raw = Number(process.env.KIOKU_DQ_HALFLIFE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DQ_RECENCY_HALFLIFE_DAYS_DEFAULT;
}

// Source 4 (raw-sources/) の上限 (cf. source 3 と同 MAX_SCAN_FILES、再帰 walker でも cap)。
const MAX_RAW_SOURCES_SCAN = 30;

// Source 4 traversal cap: `scanned` は .md file 単位 (= file 内容読込 cost)、
// `walks` は entry 単位 (= directory descent + file 検査 cost)。
// pathological raw-sources/ (大量の空 subdir / 非 .md file) で .md 30 個に辿り着く前の DoS surface を bound。
// 5x = .md と無関係 entry が 4 個ごとに 1 個 .md (= 80% noise) でも 30 file 完走可能なヘッドルーム。
const MAX_RAW_SOURCES_WALK = MAX_RAW_SOURCES_SCAN * 5;

// Source 5 (git commit) の直近 max 100 commits。
const MAX_RECENT_COMMITS = 100;

export async function buildSearchIndex(vault, options = {}) {
  if (typeof vault !== 'string' || vault.length === 0) {
    throw new Error('buildSearchIndex: vault path is required');
  }
  const topQueries = clamp(options.topQueries ?? DEFAULT_TOP_QUERIES, 1, MAX_TOP_QUERIES);
  const resultsPer = clamp(options.resultsPer ?? DEFAULT_RESULTS_PER_QUERY, 1, MAX_RESULTS_PER_QUERY);
  const mode = options.mode ?? 'hybrid';

  // Step 1: discover interesting queries from vault state
  const queries = await discoverQueries(vault, topQueries);

  // Step 2: invoke kioku_search per query, normalize results
  const items = [];
  for (const q of queries) {
    let res;
    try {
      res = await handleSearch(vault, { query: q, limit: resultsPer, mode });
    } catch {
      // 個別 query の失敗で全体を落とさない (build time precompute の robustness)
      continue;
    }
    items.push({
      query: q,
      mode,
      results: normalizeResults(res?.results ?? []),
    });
  }

  return {
    schema_version: SEARCH_INDEX_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    queries: items,
  };
}

/**
 * Discover top-N "interesting" queries from vault state.
 *
 * Sources (in priority order, weight noted):
 *   1. wiki/log.md tag refs (#tag) — weight 3
 *   2. wiki/index.md outgoing wikilinks ([[name]]) — weight 2
 *   3. wiki/*.md (log/index/hot 除く) top-level headings h1-h3 — weight 1
 *   4. raw-sources/ .md の h1 + h2 headings — weight 2
 *      (raw 取り込みされた素材の主題が popular query になりやすい)
 *   5. git commit subjects (直近 MAX_RECENT_COMMITS) — weight 1.5
 *      (実装の動向と整合する query、非 git repo は graceful skip)
 *   6. wiki/hot.md ATX heading (h1-h3) + standalone-line #tag — weight 2.5
 *      (hot context = 直近 priority、user 関心と整合度高)
 *   7. wiki/*.md broadly-referenced (>=2 files) — bonus 1.2 * (file_count - 1)
 *      (broadly referenced concept; source 3 と独立に bonus、double-count 回避は per-file Set で記録)
 *   8. session-logs/ user utilization scan (Sprint 5.5 PR A55) — weight 2.8
 *      × recency decay 0.5^(ageDays / halfLife) (v0.11 S6-7, axis F;
 *      ageDays = newest source-file mtime 起点、halfLife = env
 *      KIOKU_DQ_HALFLIFE_DAYS、default 14 日)
 *      (highest single-source weight: dynamic learning from actual user activity.
 *      Privacy contract: masking SSOT + opt-out file + 64KB usage log rotate.
 *      See mcp/lib/discoverqueries-learning.mjs for details.)
 *
 * Dedupe / score: Map で同 query 加算、最後に weight 降順 sort + limit clamp。
 *
 * @param {string} vault - absolute path to Obsidian vault root
 * @param {number} limit - max number of queries to return
 * @returns {Promise<string[]>}
 */
async function discoverQueries(vault, limit) {
  const wikiDir = join(vault, 'wiki');
  const counts = new Map();

  // Source 1: log.md tag refs (highest priority)
  const logPath = join(wikiDir, 'log.md');
  const logContent = await safeReadFile(logPath);
  if (logContent) {
    let m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(logContent)) !== null) {
      const tag = m[1].toLowerCase();
      counts.set(tag, (counts.get(tag) ?? 0) + 3); // tag weight = 3
    }
  }

  // Source 2: index.md outgoing wikilinks
  const indexPath = join(wikiDir, 'index.md');
  const indexContent = await safeReadFile(indexPath);
  if (indexContent) {
    let m;
    WIKILINK_RE.lastIndex = 0;
    while ((m = WIKILINK_RE.exec(indexContent)) !== null) {
      const name = m[1].trim().toLowerCase();
      if (name) counts.set(name, (counts.get(name) ?? 0) + 2); // wikilink weight = 2
    }
  }

  // Source 3: wiki/*.md (log/index/hot 除く) top-level headings
  // Source 7 (broadly-referenced) を同時計算するため、per-heading の出現 file set を tracking。
  const headingFileSets = new Map(); // heading -> Set<filename>
  let entries;
  try {
    entries = await readdir(wikiDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  let scanned = 0;
  for (const dirent of entries) {
    if (scanned >= MAX_SCAN_FILES) break;
    if (!dirent.isFile() || !dirent.name.endsWith('.md')) continue;
    // log/index は専用 source (1,2)、hot.md は source 6 で個別 scan
    if (dirent.name === 'log.md' || dirent.name === 'index.md' || dirent.name === 'hot.md') continue;
    scanned++;
    const content = await safeReadFile(join(wikiDir, dirent.name));
    if (!content) continue;
    let m;
    HEADING_RE.lastIndex = 0;
    while ((m = HEADING_RE.exec(content)) !== null) {
      const heading = m[1].trim().toLowerCase();
      if (heading.length < 2 || heading.length > 80) continue;
      counts.set(heading, (counts.get(heading) ?? 0) + 1); // heading weight = 1
      // Source 7 用: file set 記録 (Set で per-file uniq)
      let fileSet = headingFileSets.get(heading);
      if (!fileSet) {
        fileSet = new Set();
        headingFileSets.set(heading, fileSet);
      }
      fileSet.add(dirent.name);
    }
  }

  // Source 4: raw-sources/ 配下 .md の h1 + h2 headings (weight 2)
  // 再帰 walker、cap MAX_RAW_SOURCES_SCAN files で abort。
  const rawSourcesDir = join(vault, 'raw-sources');
  await scanRawSourcesHeadings(rawSourcesDir, counts);

  // Source 5: git commit subjects 直近 MAX_RECENT_COMMITS (weight 1.5)
  // 非 git repo / git 未インストールは graceful skip (getFileHistory が error shape で返す)
  await ingestGitSubjects(vault, counts);

  // Source 6: wiki/hot.md ATX heading + standalone-line #tag (weight 2.5)
  const hotContent = await safeReadFile(join(wikiDir, 'hot.md'));
  if (hotContent) {
    let m;
    HEADING_RE.lastIndex = 0;
    while ((m = HEADING_RE.exec(hotContent)) !== null) {
      const heading = m[1].trim().toLowerCase();
      if (heading.length < 2 || heading.length > 80) continue;
      counts.set(heading, (counts.get(heading) ?? 0) + 2.5);
    }
    STANDALONE_TAG_RE.lastIndex = 0;
    while ((m = STANDALONE_TAG_RE.exec(hotContent)) !== null) {
      const tag = m[1].toLowerCase();
      if (!tag) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 2.5);
    }
  }

  // Source 7: wiki/*.md broadly-referenced concept (>= 2 files) に bonus 加算。
  // 「重複度 high-N」 → file_count >= 2 の heading に bonus 1.2 * (file_count - 1) 加算。
  // Source 3 の per-occurrence weight 1 とは独立 (source 3 = 出現回数、source 7 = 出現 file 数の breadth)。
  for (const [heading, fileSet] of headingFileSets.entries()) {
    if (fileSet.size >= 2) {
      const bonus = 1.2 * (fileSet.size - 1);
      counts.set(heading, (counts.get(heading) ?? 0) + bonus);
    }
  }

  // Source 8 (NEW, Sprint 5.5 PR A55): user utilization log scan (weight 2.8).
  // session-logs/ scan with masking SSOT for credential safety + opt-out file
  // for user control + 64KB FIFO rotation for bounded persistence.
  // graceful skip on any failure: opt-out / session-logs absent / scan error
  // all yield an empty Map, preserving build precompute robustness.
  //
  // v0.11 S6-7 (axis F): recency decay. Each candidate carries the newest
  // source-file mtime; score = 2.8 * count * 0.5^(ageDays / halfLife) so a
  // fresh mid-frequency query can outrank a stale high-frequency one.
  // opt-out はこの decay 以前に scanSessionLogs 側で 8th source ごと skip
  // (empty Map) される — privacy contract 3 軸は不変。
  try {
    const usageMap = await scanSessionLogs(vault);
    const halfLifeDays = resolveDqHalfLifeDays();
    const nowMs = Date.now();
    for (const [query, entry] of usageMap.entries()) {
      // Defensive: tolerate legacy plain-number values alongside the
      // { count, mtimeMs } shape (cross-boundary drift guard, LEARN#6).
      const count =
        typeof entry === 'number'
          ? entry
          : entry && Number.isFinite(entry.count)
            ? entry.count
            : 0;
      if (!Number.isFinite(count) || count <= 0) continue;
      // Unknown / invalid mtime → treat as "now" (decay = 1, pre-S6-7
      // behavior) rather than nuking the signal with a huge age.
      const mtimeMs =
        entry && typeof entry === 'object' && Number.isFinite(entry.mtimeMs) && entry.mtimeMs > 0
          ? entry.mtimeMs
          : nowMs;
      const ageDays = Math.max(0, (nowMs - mtimeMs) / MS_PER_DAY);
      const decay = Math.pow(0.5, ageDays / halfLifeDays);
      counts.set(query, (counts.get(query) ?? 0) + 2.8 * count * decay);
    }
  } catch {
    // best-effort: dynamic learning failure must not abort discoverQueries
  }

  // sort by weighted score desc, take top N, dedupe (Map keys already unique)
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([q]) => q);
}

// Source 4 helper: raw-sources/ 配下 .md を再帰 walk、h1 + h2 headings を抽出。
// readdir({ recursive: true }) は Node 20+ なので、明示 walker で Node 18 互換。
//
// 2 段 budget で cost を bound:
//   - `scanned`: .md file の内容読込数 (= file-content cost、上限 MAX_RAW_SOURCES_SCAN)
//   - `walks`: directory descent + file entry 検査の総数 (= traversal cost、上限 MAX_RAW_SOURCES_WALK)
// pathological 入力 (大量の空 subdir / 非 .md file 山) でも walker が完走 → DoS surface を bound。
async function scanRawSourcesHeadings(rootDir, counts) {
  let scanned = 0;
  let walks = 0;
  async function walk(dir) {
    if (scanned >= MAX_RAW_SOURCES_SCAN) return;
    if (walks >= MAX_RAW_SOURCES_WALK) return;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (scanned >= MAX_RAW_SOURCES_SCAN) return;
      if (walks >= MAX_RAW_SOURCES_WALK) return;
      walks++;
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(full);
      } else if (dirent.isFile() && dirent.name.endsWith('.md')) {
        scanned++;
        const content = await safeReadFile(full);
        if (!content) continue;
        let m;
        HEADING_H1H2_RE.lastIndex = 0;
        while ((m = HEADING_H1H2_RE.exec(content)) !== null) {
          const heading = m[1].trim().toLowerCase();
          if (heading.length < 2 || heading.length > 80) continue;
          counts.set(heading, (counts.get(heading) ?? 0) + 2); // raw-sources weight = 2
        }
      }
    }
  }
  await walk(rootDir);
}

// Source 5 helper: git log の subject から query 候補を抽出 (weight 1.5)。
// git-history.mjs の getFileHistory を再利用 (SAFE_CONFIG + GIT_CONFIG_NOSYSTEM hardened spawn)、
// 非 git repo / git 未インストール / getFileHistory error は graceful skip。
// subject 全体を 1 つの query として登録 (subject は通常 short = popular query 候補に適している)。
//
// 第 3 引数 options.historyProvider は test 用 injection (defense-in-depth で getFileHistory が
// `{ commits: [], error: 'not_a_git_repo' }` shape を返した場合の graceful path を直接 verify する用途)。
// production code は呼ばない (default で real isGitRepo / getFileHistory を使用)。
async function ingestGitSubjects(vault, counts, options = {}) {
  const isRepoFn = options.isRepoProvider ?? isGitRepo;
  const historyFn = options.historyProvider ?? getFileHistory;
  let isRepo;
  try {
    isRepo = await isRepoFn(vault);
  } catch {
    return; // git binary 不在 等で throw した場合も graceful
  }
  if (!isRepo) return;
  let history;
  try {
    history = await historyFn(vault, { maxCommits: MAX_RECENT_COMMITS });
  } catch {
    return;
  }
  if (!history || history.error || !Array.isArray(history.commits)) return;
  for (const c of history.commits) {
    if (!c || typeof c.subject !== 'string') continue;
    const subject = c.subject.trim().toLowerCase();
    // 安全 / 長さ filter (短すぎ / 長すぎは query として無用)
    if (subject.length < 4 || subject.length > 120) continue;
    counts.set(subject, (counts.get(subject) ?? 0) + 1.5);
  }
}

/**
 * Normalize raw kioku_search results to a whitelist shape.
 * Drops `body`, `abs_path`, and any other non-whitelisted field for security.
 *
 * @param {Array<object>} rawResults
 * @returns {Array<{title: string, rel: string, snippet: string, score: number|null}>}
 */
function normalizeResults(rawResults) {
  if (!Array.isArray(rawResults)) return [];
  return rawResults.slice(0, MAX_RESULTS_PER_QUERY).map((r) => ({
    title: String(r?.title ?? '').slice(0, 200),
    rel: String(r?.rel ?? r?.path ?? '').slice(0, 300),
    snippet: String(r?.snippet ?? r?.excerpt ?? '').slice(0, 500),
    score: typeof r?.score === 'number' ? r.score : null,
    // 注意: body / abs_path / 他 field は whitelist で必ず drop。
    // (Phase 1 normalizeRenderedPage と同じ XSS / path-leak 防御原則)
  }));
}

function clamp(val, min, max) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return min;
  return Math.max(min, Math.min(max, Math.trunc(val)));
}

async function safeReadFile(p) {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

// Internal helpers exposed for unit tests only. Production code should not use this.
export const __test__ = Object.freeze({
  discoverQueries,
  ingestGitSubjects,
  normalizeResults,
  clamp,
  resolveDqHalfLifeDays,
  DQ_RECENCY_HALFLIFE_DAYS_DEFAULT,
  TAG_RE,
  WIKILINK_RE,
  HEADING_RE,
  MAX_TOP_QUERIES,
  MAX_RESULTS_PER_QUERY,
});
