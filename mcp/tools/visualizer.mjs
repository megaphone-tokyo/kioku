// visualizer.mjs — kioku_generate_viz MCP tool (Phase D α V-2)
//
// wiki/ の git 履歴から timeline + diff 情報を抽出し、self-contained HTML を
// $OBSIDIAN_VAULT/.cache/viz/<name>.html として書き出す。
// 出力は外部ネットワークを呼ばず、vault 内の local file として browser で直接開ける。
//
// Security / Trust boundary (plan/claude/26042402 §Security boundary 準拠):
//   - output path は .cache/viz/ 配下限定 (assertInsideBase で境界 check)
//   - git 呼び出しは git-history.mjs 経由で SAFE_CONFIG + argv 配列渡し
//   - snapshot の body は除外、frontmatter + wikilink のみ embed (P1 絶対契約)
//   - frontmatter は applyMasks + key-name redaction 済 (wiki-snapshot.mjs で吸収)
//   - HTML 内 inline JSON は `</` を `</` に escape し script close tag を封じる
//   - 外部ネットワーク一切呼ばない、embeddings view (View 4) は v0.8 defer で explicit reject

import { z } from 'zod';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertInsideBase, PathBoundaryError } from '../lib/vault-path.mjs';
import { getFileHistory } from '../lib/git-history.mjs';
import { buildWikiSnapshot, diffSnapshots } from '../lib/wiki-snapshot.mjs';
import { collectHealthMetrics } from '../lib/health-metrics.mjs';
import { collectFirstViewData } from '../lib/visualizer-data.mjs';
import { buildLineageGraph } from '../lib/lineage-graph.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, '..', 'templates', 'viz-template.html');

const OUTPUT_BASE = '.cache/viz';
const DEFAULT_OUTPUT_REL = `${OUTPUT_BASE}/wiki-graph.html`;
const SINCE_RE = /^\d{4}-\d{2}-\d{2}$/; // ISO date YYYY-MM-DD のみ許容 (git 任意書式より安全優先)
const DATA_PLACEHOLDER = '__KIOKU_VIZ_DATA__';

// default since = 今から 1 年前の ISO date
function defaultSince() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

export const VISUALIZER_TOOL_DEF = {
  name: 'kioku_generate_viz',
  title: 'Generate KIOKU wiki visualizer (local HTML)',
  description:
    'Generates a self-contained HTML visualizer of the wiki with 4 views: Overview (first view = vault overview + health focus + graph preview + action queue), Timeline Player (temporal evolution), Diff Viewer (2 時点の差分), and Lineage (raw-sources → summaries → wiki best-effort 3 layer lineage graph, Sprint 3 v0.8 β). Data is embedded as inline JSON — only frontmatter and wikilinks, never page body. Output is written to the vault .cache/viz/ directory and opened directly in a browser (no external network). Does NOT modify wiki/. Requires the vault to be a git repository.',
  inputShape: {
    output_path: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe(`Vault-relative output path. Must be under ${OUTPUT_BASE}/. Default: ${DEFAULT_OUTPUT_REL}`),
    since: z
      .string()
      .regex(SINCE_RE, 'since must be ISO date YYYY-MM-DD')
      .optional()
      .describe('ISO 8601 date (YYYY-MM-DD) — commits since this date. Default: 1 year ago.'),
    max_commits: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .optional()
      .describe('Upper bound on commits to scan. Default: 50 (performance trade-off, each commit triggers a full wiki snapshot).'),
    embeddings: z
      .boolean()
      .optional()
      .describe('Semantic cluster view (View 4). Deferred to v0.8; currently rejected if true.'),
  },
};

export async function handleGenerateViz(vault, args = {}) {
  const embeddings = args.embeddings === true;
  if (embeddings) {
    throw new Error('embeddings view (View 4) is deferred to v0.8 and not yet supported. Call without embeddings=true.');
  }

  const outputPathRel = typeof args.output_path === 'string' && args.output_path.length > 0
    ? args.output_path
    : DEFAULT_OUTPUT_REL;
  if (!outputPathRel.startsWith(`${OUTPUT_BASE}/`)) {
    throw new Error(`output_path must start with "${OUTPUT_BASE}/" (got: ${outputPathRel})`);
  }
  const fileNameRel = outputPathRel.slice(OUTPUT_BASE.length + 1); // strip ".cache/viz/"
  if (fileNameRel.length === 0 || !fileNameRel.endsWith('.html')) {
    throw new Error('output_path must end with .html');
  }

  const since = typeof args.since === 'string' && SINCE_RE.test(args.since)
    ? args.since
    : defaultSince();
  const maxCommits = typeof args.max_commits === 'number' && args.max_commits >= 1
    ? Math.min(Math.floor(args.max_commits), 5000)
    : 50;

  // output path boundary check (vault 外脱出防御、symlink trap 防御)
  // assertInsideBase は base が実在することを要求するので、先に mkdir しておく。
  // OUTPUT_BASE は hard-code 値なのでこの mkdir は攻撃面にならない。
  await mkdir(join(vault, OUTPUT_BASE), { recursive: true });
  let absOutputPath;
  try {
    absOutputPath = await assertInsideBase(vault, OUTPUT_BASE, fileNameRel);
  } catch (err) {
    if (err instanceof PathBoundaryError) {
      throw new Error(`invalid output_path: ${err.message}`);
    }
    throw err;
  }

  // 1. git history 収集
  const histRes = await getFileHistory(vault, { since, subPath: 'wiki/', maxCommits });
  if (histRes.error === 'not_a_git_repo') {
    throw new Error('vault is not a git repository — visualizer requires git history');
  }
  if (histRes.error) {
    throw new Error(`git history error: ${histRes.error}`);
  }

  // 2. 各 commit の wiki snapshot 構築
  // MVP: 順次実行 (並列化は open-issues §22 PERF-WIKI-SNAPSHOT-PARALLEL-FETCH で defer)
  const snapshots = [];
  for (const c of histRes.commits) {
    const snap = await buildWikiSnapshot(vault, c.sha, {
      subPath: 'wiki/',
      timestamp: c.timestamp,
    });
    snapshots.push({
      sha: snap.sha,
      shortSha: c.shortSha,
      timestamp: snap.timestamp ?? c.timestamp,
      author: c.author,
      subject: c.subject,
      pages: snap.pages,
      links: snap.links,
      truncated: Boolean(snap.truncated),
      error: snap.error ?? null,
    });
  }

  // 3. template 読込
  let template;
  try {
    template = await readFile(TEMPLATE_PATH, 'utf8');
  } catch (err) {
    throw new Error(`visualizer template not found at ${TEMPLATE_PATH}: ${err.message}`);
  }
  if (!template.includes(DATA_PLACEHOLDER)) {
    throw new Error(`template is missing ${DATA_PLACEHOLDER} placeholder`);
  }

  // 4. data embed
  //   Phase 1 v0.8 Visualizer β: first_view を top-level に追加。
  //   既存 Timeline / Diff が依存する snapshots / since / commits_total 等は
  //   schema を破壊しないよう保持 (BLUE-VIZ-FIRSTVIEW-5 schema isolation 担保)。
  //   health metrics 取得失敗時 (orphan health module deps 等) は warnings に積み、
  //   first_view を null とし既存 view は維持 (LEARN#6 graceful degrade)。
  const now = new Date();
  let firstView = null;
  let firstViewError = null;
  try {
    const health = await collectHealthMetrics(vault, { now });
    firstView = await collectFirstViewData(vault, { now, snapshots, health });
  } catch (err) {
    firstViewError = err instanceof Error ? err.message : String(err);
  }
  // Phase 3 v0.8 β: best-effort 3 layer lineage graph (raw-sources → summaries → wiki).
  // Failure is non-fatal — Overview/Timeline/Diff continue working with lineage=null.
  let lineage = null;
  let lineageError = null;
  try {
    lineage = await buildLineageGraph(vault, { now });
  } catch (err) {
    lineageError = err instanceof Error ? err.message : String(err);
  }
  const data = {
    // schema_version 履歴: 1 (V-1 base) / 2 (Phase 1 first_view) / 3 (Phase 3 lineage) /
    //                      4 (Phase 4 auto-lint drawer in first_view.auto_lint)
    schema_version: 4,
    generated_at: now.toISOString(),
    vault_name: basename(vault),
    since,
    max_commits: maxCommits,
    commits_total: histRes.commits.length,
    history_truncated: Boolean(histRes.truncated),
    snapshots, // 新しい順 (git log --max-count)
    first_view: firstView, // Sprint 3 v0.8 β Phase 1/2、null の場合は Overview tab で degraded UI 表示
    first_view_error: firstViewError, // null / string、warning banner 用
    lineage,           // Sprint 3 v0.8 β Phase 3、null は Lineage tab で degraded UI 表示
    lineage_error: lineageError,
  };
  const dataJson = safeJsonForScript(data);
  const html = template.replace(DATA_PLACEHOLDER, dataJson);

  // 5. atomic write (temp + rename)
  await mkdir(dirname(absOutputPath), { recursive: true });
  const tmpPath = `${absOutputPath}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(tmpPath, html, 'utf8');
    await rename(tmpPath, absOutputPath);
  } catch (err) {
    // cleanup tmp on failure
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }

  // 6. summary
  const latestPagesCount = snapshots.length > 0 ? snapshots[0].pages.length : 0;
  return {
    path: absOutputPath,
    path_relative: outputPathRel,
    commits: histRes.commits.length,
    snapshots: snapshots.length,
    latest_pages: latestPagesCount,
    since,
    history_truncated: Boolean(histRes.truncated),
    views: ['overview', 'timeline-player', 'diff-viewer', 'lineage'],
    first_view_present: firstView !== null,
    first_view_error: firstViewError,
    auto_lint_present: Boolean(firstView && firstView.auto_lint && firstView.auto_lint.report_exists),
    lineage_present: lineage !== null,
    lineage_error: lineageError,
    lineage_totals: lineage ? lineage.totals : null,
    note: 'Open the generated HTML file in a browser. No external network required.',
  };
}

// HTML <script> ブロック内に JSON を埋め込むときの XSS hardening。
// </script> で script タグを閉じられる attack を封じるため `</` を `</` に置換。
// あわせて U+2028 / U+2029 (JS parser で line terminator 扱い) も escape。
function safeJsonForScript(obj) {
  const raw = JSON.stringify(obj);
  return raw
    .replace(/<\//g, '\\u003c/')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
}

// 単体テスト用 (tests/mcp/visualizer.test.mjs から import)
// `diffSnapshots` を import しているのは context.md で view 2 の挙動を明確化するため
export const _internals = { diffSnapshots, DATA_PLACEHOLDER, OUTPUT_BASE, safeJsonForScript };
