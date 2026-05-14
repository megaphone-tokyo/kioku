// qmd-search-index.test.mjs — Sprint 4 Phase 2 PR A2 BLUE-QMD-INDEX-1..5 + PR B2 BLUE-QMD-INDEX-6..9
//
// Plan: tools/claude-brain/plan/claude/26051402_v0-9-phase2-qmd-search-impl-plan.md §「PR A2」 + §「PR B2」
//
// F-number scope: per-file (NEW file = F1 から)
//
// Test 観点:
//   - F1 (BLUE-QMD-INDEX-1): buildSearchIndex shape (schema_version / generated_at / queries[])
//   - F2 (BLUE-QMD-INDEX-2): normalizeResults が body / abs_path を drop (security boundary)
//   - F3 (BLUE-QMD-INDEX-3): discoverQueries が wiki/log.md tag refs を extract
//   - F4 (BLUE-QMD-INDEX-snippet-escape): snippet 内 <script> / </script> / U+2028 を string で扱う
//   - F5 (BLUE-QMD-INDEX-empty-vault): empty vault でも空 SearchIndex を返す (no throw)
//   - F6 (BLUE-QMD-INDEX-6): raw-sources/ headings (h1 + h2) extraction (weight 2)
//   - F7 (BLUE-QMD-INDEX-7): git commit headlines (subject 中の ATX-like single-line) extraction + 非 git repo は graceful (weight 1.5)
//     - 7a: isGitRepo === false short-circuit (early-return path)
//     - 7b: getFileHistory が `{ commits: [], error: 'not_a_git_repo' }` shape を返した second-layer guard (defense-in-depth)
//   - F8 (BLUE-QMD-INDEX-8): wiki/hot.md content scan で ATX heading + 単独行 #tag 抽出 (weight 2.5)
//   - F9 (BLUE-QMD-INDEX-9): empty PM-Vault-like fixture (no log tags, no index wikilinks, no concept files) でも raw-sources + git + hot.md から >= 3 query 産出 (regression guard)

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutQmd as withMissingQmd } from './fixtures/test-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_PATH = join(__dirname, '..', 'mcp', 'lib', 'qmd-search-index.mjs');

const {
  buildSearchIndex,
  SEARCH_INDEX_SCHEMA_VERSION,
  __test__,
} = await import(LIB_PATH);

let workspace, vault;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'kioku-qmd-search-index-'));
  vault = join(workspace, 'vault');
  await mkdir(join(vault, 'wiki'), { recursive: true });
  await writeFile(
    join(vault, 'wiki', 'log.md'),
    [
      '---',
      'title: Log',
      '---',
      '',
      '# Log',
      '',
      '- 2026-05-14 #hot-cache について整理 #wiki',
      '- 2026-05-13 #visualizer の design 更新 #ui',
      '- 2026-05-12 #hot-cache の dogfood #wiki #ux',
      '- 2026-05-11 #doctor MVP land #release',
      '- 2026-05-10 #wiki の rotting check #drift',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(vault, 'wiki', 'index.md'),
    '# Index\n\n- [[hot-cache]]\n- [[visualizer]]\n- [[doctor]]\n',
  );
});

after(() => rm(workspace, { recursive: true, force: true }));

// qmd を見えなくして fallback Node grep path で kioku_search を回す helper は
// fixtures/test-helpers.mjs の withoutQmd を再利用 (LEARN#8b N=3 shared extract、
// PR B2 sibling: web-ui-shell.test.mjs / xss-search-result-escape.test.mjs).
// 旧 local 実装は /nonexistent-bin-only 単発 path だったが shared 版は
// /usr/bin:/bin:/usr/sbin:/sbin で git を残しつつ qmd を hide する (F7 git 操作互換).

// SAFE git invoke for fixtures (visualizer-vaults.mjs と同 pattern、test-local helper)
// - GIT_CONFIG_NOSYSTEM=1 + core.fsmonitor=false + core.hooksPath=/dev/null
// - inline AUTHOR / COMMITTER identity (user global config 継承しない reproducibility)
const GIT_SAFE_ARGS = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.version=2'];
const GIT_SAFE_ENV = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_AUTHOR_NAME: 'qmd-search-index-test',
  GIT_AUTHOR_EMAIL: 'qmd-test@test.local',
  GIT_COMMITTER_NAME: 'qmd-search-index-test',
  GIT_COMMITTER_EMAIL: 'qmd-test@test.local',
};
async function runGitTest(cwd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', [...GIT_SAFE_ARGS, ...args], {
      cwd,
      env: { ...process.env, ...GIT_SAFE_ENV },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let settled = false;
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(' ')} failed (code ${code}): ${stderr.trim()}`));
    });
  });
}

async function isGitAvailable() {
  return new Promise((resolve) => {
    const proc = spawn('git', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}

describe('qmd-search-index', () => {
  test('BLUE-QMD-INDEX-1 (F1): buildSearchIndex shape', async () => {
    await withMissingQmd(async () => {
      const idx = await buildSearchIndex(vault, { topQueries: 3, resultsPer: 5 });
      assert.equal(typeof idx, 'object');
      assert.equal(idx.schema_version, SEARCH_INDEX_SCHEMA_VERSION);
      assert.equal(idx.schema_version, 1);
      assert.match(idx.generated_at, /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(Array.isArray(idx.queries));
      assert.ok(idx.queries.length <= 3);
      for (const q of idx.queries) {
        assert.equal(typeof q.query, 'string');
        assert.ok(q.query.length > 0);
        assert.equal(typeof q.mode, 'string');
        assert.ok(['lex', 'vec', 'hybrid'].includes(q.mode));
        assert.ok(Array.isArray(q.results));
      }
    });
  });

  test('BLUE-QMD-INDEX-2 (F2): normalizeResults drops body and abs_path', () => {
    assert.ok(__test__, '__test__ export must be available for internal verify');
    const { normalizeResults } = __test__;
    const raw = [
      {
        title: 'Safe Title',
        rel: 'concepts/foo.md',
        snippet: 'safe snippet',
        score: 0.9,
        body: 'SECRET BODY MUST NOT LEAK',
        abs_path: '/Users/secret/vault/wiki/concepts/foo.md',
      },
      {
        title: 'Path Fallback',
        path: 'concepts/bar.md',
        snippet: 'another',
        score: 0.5,
        body: 'BODY LEAK',
        abs_path: '/abs/leak.md',
      },
    ];
    const out = normalizeResults(raw);
    assert.equal(out.length, 2);
    for (const r of out) {
      assert.ok(!('body' in r), 'body must be dropped');
      assert.ok(!('abs_path' in r), 'abs_path must be dropped');
      assert.equal(typeof r.title, 'string');
      assert.equal(typeof r.rel, 'string');
      assert.equal(typeof r.snippet, 'string');
    }
    assert.equal(out[0].rel, 'concepts/foo.md');
    // path fallback (when rel is absent)
    assert.equal(out[1].rel, 'concepts/bar.md');
  });

  test('BLUE-QMD-INDEX-3 (F3): discoverQueries extracts wiki/log.md tag refs', async () => {
    assert.ok(__test__, '__test__ export must be available');
    const { discoverQueries } = __test__;
    const queries = await discoverQueries(vault, 10);
    assert.ok(Array.isArray(queries));
    assert.ok(queries.length > 0, 'queries must not be empty');
    // log.md fixture has #hot-cache (freq 2) which should rank高
    const lowered = queries.map((q) => q.toLowerCase());
    assert.ok(
      lowered.some((q) => q.includes('hot-cache')),
      `expected hot-cache in queries, got: ${queries.join(', ')}`,
    );
    // no duplicate
    const uniq = new Set(queries);
    assert.equal(uniq.size, queries.length, 'discoverQueries must dedupe');
    // limit honored
    assert.ok(queries.length <= 10);
  });

  test('BLUE-QMD-INDEX-snippet-escape (F4): snippet preserves dangerous chars as strings', () => {
    assert.ok(__test__);
    const { normalizeResults } = __test__;
    // U+2028 = LINE SEPARATOR. LEARN#13: regex literal は禁止、string literal は parser-safe。
    // escape sequence で表記して source readability を確保。
    const u2028 = '\u2028';
    const dangerous = `foo <script>alert(1)</script> bar${u2028}baz </script> end`;
    const out = normalizeResults([
      { title: 't', rel: 'r', snippet: dangerous, score: 0.5 },
    ]);
    assert.equal(out.length, 1);
    // String 型で保持されている (downstream で textContent rendering される前提)
    assert.equal(typeof out[0].snippet, 'string');
    // 文字列内容は変化していない (escape は render layer の責務、normalize 層では type-cast のみ)
    assert.ok(out[0].snippet.includes('<script>'));
    assert.ok(out[0].snippet.includes('</script>'));
    assert.ok(out[0].snippet.includes(u2028));
  });

  test('BLUE-QMD-INDEX-5 (F5): empty vault returns empty SearchIndex without throw', async () => {
    const emptyWorkspace = await mkdtemp(join(tmpdir(), 'kioku-empty-vault-'));
    const emptyVault = join(emptyWorkspace, 'vault');
    await mkdir(join(emptyVault, 'wiki'), { recursive: true });
    try {
      await withMissingQmd(async () => {
        const idx = await buildSearchIndex(emptyVault, { topQueries: 5 });
        assert.equal(idx.schema_version, 1);
        assert.ok(Array.isArray(idx.queries));
        // empty vault → no queries discovered → empty queries array
        assert.equal(idx.queries.length, 0);
      });
    } finally {
      await rm(emptyWorkspace, { recursive: true, force: true });
    }
  });

  test('validates vault arg', async () => {
    await assert.rejects(buildSearchIndex(''), /vault/);
    await assert.rejects(buildSearchIndex(null), /vault/);
  });

  test('clamp options honor MAX_TOP_QUERIES and MAX_RESULTS_PER_QUERY', () => {
    assert.ok(__test__);
    const { clamp } = __test__;
    assert.equal(clamp(100, 1, 30), 30);
    assert.equal(clamp(-5, 1, 30), 1);
    assert.equal(clamp(15, 1, 30), 15);
    assert.equal(clamp(undefined, 1, 30), 1);
  });

  // ─── Sprint 4 Phase 2 PR B2: BLUE-QMD-INDEX-6..9 (discoverQueries 戦略拡張) ───
  //
  // 背景: PR A2 land 後の PM Vault dogfood で `discoverQueries` が 1 query しか返さず Tier 1 UX が
  // hollow になる risk が発覚 (wiki/log.md は ATX heading 113 個 vs inline #tag 0)。
  // PR B2 で source を 3 → 7 に拡張:
  //   4. raw-sources/ headings (h1 + h2) — weight 2
  //   5. git commit subjects (直近 100 commits) — weight 1.5
  //   6. wiki/hot.md ATX headings + 単独行 #tag — weight 2.5
  //   7. wiki/*.md broadly-referenced headings (>= 2 files に出現) — bonus weight 1.2 * (file_count - 1)

  test('BLUE-QMD-INDEX-6 (F6): discoverQueries extracts raw-sources/ headings (h1+h2)', async () => {
    assert.ok(__test__);
    const { discoverQueries } = __test__;
    const ws = await mkdtemp(join(tmpdir(), 'kioku-qmd-f6-'));
    const v = join(ws, 'vault');
    try {
      await mkdir(join(v, 'wiki'), { recursive: true });
      await mkdir(join(v, 'raw-sources'), { recursive: true });
      await writeFile(
        join(v, 'raw-sources', 'article.md'),
        [
          '# Hot Cache Design',
          '',
          '## Memory Layout',
          '',
          'body content here',
          '',
          '### Deeply Nested Heading Should Not Appear',
          '',
          '## Disk Persistence',
          '',
        ].join('\n'),
      );
      const queries = await discoverQueries(v, 20);
      assert.ok(Array.isArray(queries));
      assert.ok(queries.length >= 2, `expected >= 2 queries from raw-sources, got: ${queries.join(', ')}`);
      const lowered = queries.map((q) => q.toLowerCase());
      assert.ok(lowered.includes('hot cache design'), `h1 missing in: ${queries.join(', ')}`);
      assert.ok(
        lowered.includes('memory layout') || lowered.includes('disk persistence'),
        `h2 missing in: ${queries.join(', ')}`,
      );
      // h3 (#### ...) は対象外 (spec: top-level + h2 only)
      assert.ok(
        !lowered.includes('deeply nested heading should not appear'),
        `h3 must not be included in: ${queries.join(', ')}`,
      );
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test('BLUE-QMD-INDEX-7 (F7): discoverQueries extracts git commit subjects + graceful on non-git-repo', async () => {
    assert.ok(__test__);
    const { discoverQueries } = __test__;

    // (a) graceful: 非 git repo (no .git dir) は throw せず、git source 0 contribution
    const wsNoGit = await mkdtemp(join(tmpdir(), 'kioku-qmd-f7-nogit-'));
    const vNoGit = join(wsNoGit, 'vault');
    try {
      await mkdir(join(vNoGit, 'wiki'), { recursive: true });
      const queriesNoGit = await discoverQueries(vNoGit, 10);
      // throw しない、空配列 (or 他 source 由来) を返すこと
      assert.ok(Array.isArray(queriesNoGit));
      // 何も無い vault → 空のはず (sanity)
      assert.equal(queriesNoGit.length, 0, `non-git empty vault should yield 0 queries, got: ${queriesNoGit.join(', ')}`);
    } finally {
      await rm(wsNoGit, { recursive: true, force: true });
    }

    // (b) git repo: commit subject が query 候補に入る
    if (!(await isGitAvailable())) {
      // 開発環境に git が無い場合は assertion skip (test 自体は pass、graceful path のみで verify 済)
      return;
    }
    const ws = await mkdtemp(join(tmpdir(), 'kioku-qmd-f7-git-'));
    const v = join(ws, 'vault');
    try {
      await mkdir(join(v, 'wiki'), { recursive: true });
      // 何も file が無い状態で commit (allow-empty) して subject だけ生やす
      await runGitTest(v, ['init', '-q', '-b', 'main']);
      await runGitTest(v, ['commit', '-q', '--allow-empty', '-m', 'claude-brain: implement Search tab UI']);
      await runGitTest(v, ['commit', '-q', '--allow-empty', '-m', 'visualizer: add graph snapshot mode']);
      const queries = await discoverQueries(v, 20);
      assert.ok(Array.isArray(queries));
      assert.ok(queries.length >= 1, `expected >= 1 query from git subjects, got: ${queries.join(', ')}`);
      const lowered = queries.map((q) => q.toLowerCase());
      // subject の一部 (substring match) が query に含まれること
      const hasSearchTab = lowered.some((q) => q.includes('search tab') || q.includes('implement search'));
      const hasVisualizer = lowered.some((q) => q.includes('visualizer') || q.includes('graph snapshot'));
      assert.ok(
        hasSearchTab || hasVisualizer,
        `expected at least one commit-derived query, got: ${queries.join(', ')}`,
      );
    } finally {
      await rm(ws, { recursive: true, force: true });
    }

    // (c) BLUE-QMD-INDEX-7b: defense-in-depth — second-layer guard で getFileHistory が
    // `{ commits: [], error: 'not_a_git_repo' }` shape (web-ui-shell.mjs:128 で visible) を返した時、
    // ingestGitSubjects が throw せず counts に 0 contribution であること。
    // F7 (a) は isGitRepo === false で early-return path を verify するが、isGitRepo が true を
    // 返した上で getFileHistory が error shape を返す race / borderline ケース (例: .git dir 自体は
    // あるが本物の repo として init されていない) を直接 verify する。
    // 実 file system では race を組みづらいため、__test__ 経由で historyProvider を injection する。
    assert.ok(__test__.ingestGitSubjects, 'ingestGitSubjects must be exposed via __test__');
    const { ingestGitSubjects } = __test__;
    const counts = new Map();
    let providerCalled = 0;
    const stubHistoryProvider = async () => {
      providerCalled++;
      return { commits: [], truncated: false, error: 'not_a_git_repo' };
    };
    const stubIsRepoProvider = async () => true; // bypass real isGitRepo check
    await assert.doesNotReject(
      ingestGitSubjects('/nonexistent-vault-path-fixture', counts, {
        isRepoProvider: stubIsRepoProvider,
        historyProvider: stubHistoryProvider,
      }),
      'ingestGitSubjects must not throw when getFileHistory returns not_a_git_repo error shape',
    );
    assert.equal(providerCalled, 1, 'historyProvider should be invoked once (isRepo gate passed)');
    assert.equal(counts.size, 0, `counts must receive 0 contribution from not_a_git_repo shape, got: ${counts.size}`);
  });

  test('BLUE-QMD-INDEX-8 (F8): discoverQueries extracts wiki/hot.md ATX headings + 単独行 #tag', async () => {
    assert.ok(__test__);
    const { discoverQueries } = __test__;
    const ws = await mkdtemp(join(tmpdir(), 'kioku-qmd-f8-'));
    const v = join(ws, 'vault');
    try {
      await mkdir(join(v, 'wiki'), { recursive: true });
      await writeFile(
        join(v, 'wiki', 'hot.md'),
        [
          '# Recent Context',
          '',
          '#hot-cache',
          '#wiki-rotting',
          '',
          '## Other Heading',
          '',
          'body line mentions #embedded-tag inline which should NOT be picked up as 単独行 tag',
          '',
          '### h3 heading also OK',
          '',
        ].join('\n'),
      );
      const queries = await discoverQueries(v, 20);
      assert.ok(Array.isArray(queries));
      assert.ok(queries.length >= 3, `expected >= 3 queries from hot.md, got: ${queries.join(', ')}`);
      const lowered = queries.map((q) => q.toLowerCase());
      // ATX heading (h1/h2/h3 all in scope per spec)
      assert.ok(lowered.includes('recent context'), `h1 missing in: ${queries.join(', ')}`);
      assert.ok(lowered.includes('other heading'), `h2 missing in: ${queries.join(', ')}`);
      // 単独行 #tag
      assert.ok(lowered.includes('hot-cache'), `standalone tag #hot-cache missing in: ${queries.join(', ')}`);
      assert.ok(lowered.includes('wiki-rotting'), `standalone tag #wiki-rotting missing in: ${queries.join(', ')}`);
      // body 中の inline tag は 単独行 ではないため除外 (spec: 「単独行に出る #tag」)
      assert.ok(
        !lowered.includes('embedded-tag'),
        `inline body #tag must not be picked up as 単独行: ${queries.join(', ')}`,
      );
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test('BLUE-QMD-INDEX-9 (F9): empty PM-Vault-like fixture (no log tags / no index wikilinks / no concept files) yields >= 3 queries from raw-sources + git + hot.md', async () => {
    assert.ok(__test__);
    const { discoverQueries } = __test__;
    if (!(await isGitAvailable())) {
      // git absent: regression guard を verify する fixture が組めないので skip 相当
      // (発火 condition: git source は PM vault では常に存在前提なので、開発環境で git 無い場合のみ)
      return;
    }
    const ws = await mkdtemp(join(tmpdir(), 'kioku-qmd-f9-'));
    const v = join(ws, 'vault');
    try {
      await mkdir(join(v, 'wiki'), { recursive: true });
      await mkdir(join(v, 'raw-sources'), { recursive: true });

      // ※ 意図的に空 / inline #tag 無し / [[wikilink]] 無し / concept file 無し:
      // PM Vault dogfood で再現した「discoverQueries が 1 query しか返さない」condition を guard
      await writeFile(
        join(v, 'wiki', 'log.md'),
        ['# Log', '', '## 2026-05-14', '## 2026-05-13', ''].join('\n'),
      );
      await writeFile(
        join(v, 'wiki', 'index.md'),
        ['# Index', '', 'plain text only, no wikilinks.', ''].join('\n'),
      );

      // raw-sources/ から 2 heading
      await writeFile(
        join(v, 'raw-sources', 'article-a.md'),
        ['# Quantum Computing Intro', '', '## Qubit Basics', ''].join('\n'),
      );
      // hot.md から 2 heading
      await writeFile(
        join(v, 'wiki', 'hot.md'),
        ['# Sprint 4 Phase 2', '', '## Phase 2 Goals', ''].join('\n'),
      );

      // git history で 2 commit
      await runGitTest(v, ['init', '-q', '-b', 'main']);
      await runGitTest(v, ['commit', '-q', '--allow-empty', '-m', 'kioku: precompute search index']);
      await runGitTest(v, ['commit', '-q', '--allow-empty', '-m', 'docs: update phase 2 plan']);

      const queries = await discoverQueries(v, 20);
      assert.ok(Array.isArray(queries));
      assert.ok(
        queries.length >= 3,
        `PM-Vault-like fixture regression guard: expected >= 3 queries, got ${queries.length}: ${queries.join(', ')}`,
      );
      // duplicate なし
      const uniq = new Set(queries);
      assert.equal(uniq.size, queries.length, 'discoverQueries must dedupe');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});
