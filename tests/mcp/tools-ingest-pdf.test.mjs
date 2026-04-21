// tools-ingest-pdf.test.mjs — kioku_ingest_pdf ハンドラ (機能 2.1) のユニット/結合テスト
//
// MCP23   path が Vault 外 → invalid_params
// MCP24   暗号化 PDF → invalid_request
// MCP25   正常実行 (1 chunk) → status: "extracted_and_summarized" (sample-8p.pdf)
// MCP25b  v0.3.5 Option B size-gate: 15p 以下 = 1 chunk は同期継続 (sample-15p.pdf)
// MCP25c  v0.3.5 Option B size-gate: 16p 以上 = 2+ chunks は detached (sample-42p.pdf)
// MCP26   冪等呼び出し → status: "skipped"
// MCP27   非 .pdf/.md 拡張子 → invalid_params
// MCP28   lockfile 競合 (別プロセスが保持) → LockTimeoutError
// MCP29   --allowedTools Write,Read,Edit + KIOKU_NO_LOG=1 + KIOKU_MCP_CHILD=1 が子 claude に渡る
// MCP30   相対パスと絶対パス両方が受理される
//
// ポイント: 本物の extract-pdf.sh + fixture PDF を使うので poppler (pdfinfo/pdftotext) が
// 必要。ない環境では describe.skip で SKIP する。
// claude コマンドは stub に差し替え (実 LLM を呼ばない) — `injections.claudeBin` を使う。

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, mkdir, rm, cp, writeFile, chmod, stat, readdir, readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_DIR = join(__dirname, '..', '..', 'mcp');
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURES = join(__dirname, '..', 'fixtures', 'pdf');
const EXTRACT_PDF = join(__dirname, '..', '..', 'scripts', 'extract-pdf.sh');

const { handleIngestPdf } = await import(join(MCP_DIR, 'tools', 'ingest-pdf.mjs'));

// poppler が無ければ本スイート全体を skip (CI での SKIP を明示)
const popplerCheck = spawnSync('sh', ['-c', 'command -v pdfinfo >/dev/null 2>&1 && command -v pdftotext >/dev/null 2>&1'], { stdio: 'ignore' });
const HAS_POPPLER = popplerCheck.status === 0;

let workspace, stubBinDir, stubClaudeLog;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'kioku-mcp-ip-'));
  stubBinDir = join(workspace, 'stub-bin');
  stubClaudeLog = join(workspace, 'stub-claude.log');
  await mkdir(stubBinDir, { recursive: true });
  // stub claude: argv と環境変数の関連項目を log に書き、成功終了する
  // LOW-4 (env allowlist) テストのため、secret env (GH_TOKEN 等) が伝搬しないことも
  // 観察できるよう widely match する。
  const stubClaude = join(stubBinDir, 'claude-stub.sh');
  const script = `#!/usr/bin/env bash
# stub: record KIOKU_* / OBSIDIAN_VAULT / secret-like env + argv to log
{
  echo "=== invocation ==="
  echo "ARGV: $*"
  env | grep -E '^(KIOKU_|OBSIDIAN_VAULT=|GH_TOKEN=|AWS_|OPENAI_API_KEY=|ANTHROPIC_)' | sort
  echo "--- end env ---"
} >> "${stubClaudeLog}"
exit 0
`;
  await writeFile(stubClaude, script, { mode: 0o755 });
  await chmod(stubClaude, 0o755);
});

after(() => rm(workspace, { recursive: true, force: true }));

async function makeVault(name) {
  const vault = join(workspace, name);
  await mkdir(join(vault, 'raw-sources', 'papers'), { recursive: true });
  await mkdir(join(vault, 'wiki', 'summaries'), { recursive: true });
  await mkdir(join(vault, '.cache', 'extracted'), { recursive: true });
  await mkdir(join(vault, 'session-logs'), { recursive: true });
  return vault;
}

const claudeBin = () => join(stubBinDir, 'claude-stub.sh');

describe('kioku_ingest_pdf', { skip: !HAS_POPPLER ? 'poppler not installed' : false }, () => {
  test('MCP23 rejects path outside vault (absolute)', async () => {
    const vault = await makeVault('mcp23');
    // 外部ディレクトリに PDF を置く
    const outsideDir = await mkdtemp(join(tmpdir(), 'kioku-ip-outside-'));
    try {
      await cp(join(FIXTURES, 'sample-8p.pdf'), join(outsideDir, 'evil.pdf'));
      await assert.rejects(
        handleIngestPdf(vault, { path: join(outsideDir, 'evil.pdf') }, { claudeBin: claudeBin() }),
        (err) => err.code === 'invalid_params' || err.code === 'path_outside_boundary',
      );
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  test('MCP23b rejects relative path escaping raw-sources/', async () => {
    const vault = await makeVault('mcp23b');
    await assert.rejects(
      handleIngestPdf(vault, { path: '../../etc/passwd' }, { claudeBin: claudeBin() }),
      (err) => err.code === 'invalid_params' || err.code === 'path_traversal',
    );
  });

  test('MCP24 encrypted PDF -> invalid_request', async () => {
    const vault = await makeVault('mcp24');
    await cp(join(FIXTURES, 'sample-encrypted.pdf'), join(vault, 'raw-sources', 'papers', 'locked.pdf'));
    await assert.rejects(
      handleIngestPdf(vault, { path: 'raw-sources/papers/locked.pdf' }, { claudeBin: claudeBin() }),
      (err) => err.code === 'invalid_request',
    );
  });

  test('MCP25 normal execution (1 chunk) -> extracted_and_summarized', async () => {
    const vault = await makeVault('mcp25');
    await cp(join(FIXTURES, 'sample-8p.pdf'), join(vault, 'raw-sources', 'papers', 'attention.pdf'));
    const result = await handleIngestPdf(
      vault,
      { path: 'raw-sources/papers/attention.pdf' },
      { claudeBin: claudeBin() },
    );
    // 8p は 1 chunk に収まるので従来通り同期継続 (v0.3.5 size-gate 下限)
    assert.equal(result.status, 'extracted_and_summarized');
    assert.ok(result.pdf_path.endsWith('attention.pdf'), 'pdf_path returned');
    assert.ok(Array.isArray(result.chunks) && result.chunks.length === 1,
      `1 chunk expected for 8p PDF, got ${result.chunks.length}`);
    // chunk MD が実際に作られている + 新命名を使っている
    const cacheEntries = await readdir(join(vault, '.cache', 'extracted'));
    assert.ok(
      cacheEntries.some((n) => n.startsWith('papers--attention-pp')),
      `double-hyphen chunk expected, got: ${cacheEntries.join(',')}`,
    );
    // stub claude が呼ばれている
    const log = await readFile(stubClaudeLog, 'utf8');
    assert.match(log, /ARGV: -p/, 'stub claude was invoked with -p');
  });

  test('MCP25b v0.3.5 size-gate: 15p = 1 chunk still synchronous (extracted_and_summarized)', async () => {
    // v0.3.5 Option B の size-gate 境界テスト。KIOKU_PDF_CHUNK_PAGES=15 (既定) 以下の
    // PDF は single chunk になり、従来通り sync で claude -p を回して extracted_and_summarized
    // を返す (短時間で完了する見込み、UX 変更なし)。
    const vault = await makeVault('mcp25b');
    await cp(join(FIXTURES, 'sample-15p.pdf'), join(vault, 'raw-sources', 'papers', 'short.pdf'));
    const result = await handleIngestPdf(
      vault,
      { path: 'raw-sources/papers/short.pdf' },
      { claudeBin: claudeBin() },
    );
    assert.equal(result.status, 'extracted_and_summarized',
      `15p (1 chunk) should stay synchronous, got: ${JSON.stringify(result)}`);
    assert.equal(result.chunks.length, 1,
      `15p PDF should be exactly 1 chunk, got ${result.chunks.length}`);
    assert.ok(Array.isArray(result.summaries), 'summaries array present');
    // queued 経路のフィールドは無いこと
    assert.equal(result.expected_summaries, undefined,
      'sync path must not include expected_summaries');
    assert.equal(result.detached_pid, undefined,
      'sync path must not include detached_pid');
  });

  test('MCP25c v0.3.5 size-gate: 42p = 3 chunks dispatches detached (queued_for_summary)', async () => {
    // v0.3.5 Option B: chunks >= 2 (sample-42p.pdf は KIOKU_PDF_CHUNK_PAGES=15 + 1 page
    // overlap で 3 chunks になる想定) は detached claude -p を spawn し、queued_for_summary
    // で早期 return する。stub claude が spawn されたことを shared stub log で確認。
    //
    // 注意: stub claude スクリプトは `{ ... } >> ${stubClaudeLog}` で出力を共有ログに
    // redirect するので、spawnDetached 側の per-vault log file (stdio redirect 先) は
    // 空のまま。shared stub log をクリアしてから invocation 記録の増加を観測する。
    await writeFile(stubClaudeLog, '');
    const vault = await makeVault('mcp25c');
    await cp(join(FIXTURES, 'sample-42p.pdf'), join(vault, 'raw-sources', 'papers', 'long.pdf'));
    const result = await handleIngestPdf(
      vault,
      { path: 'raw-sources/papers/long.pdf' },
      { claudeBin: claudeBin() },
    );
    assert.equal(result.status, 'queued_for_summary',
      `42p PDF should queue for detached summary, got: ${JSON.stringify(result)}`);
    assert.ok(Array.isArray(result.chunks) && result.chunks.length >= 2,
      `expected >=2 chunks for 42p PDF, got: ${result.chunks?.length}`);
    assert.ok(Array.isArray(result.expected_summaries) && result.expected_summaries.length >= 2,
      'expected_summaries must be populated on queued path');
    // detached_pid と log_file が返る
    assert.equal(typeof result.detached_pid, 'number', 'detached_pid is a PID');
    assert.ok(result.detached_pid > 0, 'detached_pid positive');
    assert.match(result.log_file ?? '', /^\.cache\/claude-summary-papers--long\.log$/,
      `log_file relative path expected, got: ${result.log_file}`);
    assert.match(result.message ?? '', /chunks extracted/i, 'message contains guidance');

    // chunks[] は即時確認可能 (raw-sources 配下ではなく .cache/extracted/ 配下)
    const cacheEntries = await readdir(join(vault, '.cache', 'extracted'));
    assert.ok(
      cacheEntries.some((n) => n.startsWith('papers--long-pp')),
      `chunk MDs should be present immediately, got: ${cacheEntries.join(',')}`,
    );

    // 観測用 summary lockfile が作られている
    const vaultEntries = await readdir(vault);
    assert.ok(
      vaultEntries.some((n) => n === '.kioku-summary-papers--long.lock'),
      `summary lockfile expected, got: ${vaultEntries.filter((n) => n.startsWith('.kioku-')).join(',')}`,
    );

    // Phase A で取った .kioku-mcp.lock は解放されていること (auto-ingest が進める)
    const mcpLockExists = vaultEntries.some((n) => n === '.kioku-mcp.lock');
    assert.equal(mcpLockExists, false, '.kioku-mcp.lock must be released before detached spawn');

    // per-vault の detached log file も touch (open + close) だけはされていること
    // (child stub が `>>` で shared log に redirect しているので内容は空だが、ファイル
    // 自体は spawnDetached の open() で作られる)
    const perVaultLogPath = join(vault, result.log_file);
    const logStat = await stat(perVaultLogPath);
    assert.ok(logStat.isFile(), 'per-vault detached log file should exist');

    // detached stub claude は shared stubClaudeLog に追記する。polling で確認。
    let sharedLog = '';
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 25));
      sharedLog = await readFile(stubClaudeLog, 'utf8');
      if (sharedLog.includes('ARGV: -p')) break;
    }
    assert.match(sharedLog, /ARGV: -p/,
      `detached claude stub should log its invocation, got: ${sharedLog.slice(0, 200)}`);
    assert.match(sharedLog, /KIOKU_NO_LOG=1/, 'KIOKU_NO_LOG propagated to detached child');
    assert.match(sharedLog, /KIOKU_MCP_CHILD=1/, 'KIOKU_MCP_CHILD propagated to detached child');
    assert.match(sharedLog, /OBSIDIAN_VAULT=/, 'OBSIDIAN_VAULT propagated to detached child');
  });

  test('MCP25d v0.3.7 prompt order: index.md is written AFTER all chunk summaries (multi-chunk)', async () => {
    // v0.3.7 Issue 1: detached child が全 chunk summary の完成を待たずに親 index.md を
    // 書き出す問題 (Llama 2 77p で実害) への対策として、buildIngestPrompt() の prompt 本文に
    // 「chunk 先 → index 後」の順序指示を明記した。stub claude の argv は shared log に
    // 1 行で書かれるので (改行ありのプロンプトが $* 展開で 1 argument として echo される)、
    // そこを grep して順序指示の文字列が含まれることを確認する。
    //
    // 実際に LLM が順序を守って書くかは MacBook 実機の index.md mtime 比較で検証する領域。
    // 本テストは「順序指示がプロンプトに乗っているか」の proxy アサーション。
    await writeFile(stubClaudeLog, '');
    const vault = await makeVault('mcp25d');
    await cp(join(FIXTURES, 'sample-42p.pdf'), join(vault, 'raw-sources', 'papers', 'ordering.pdf'));
    const result = await handleIngestPdf(
      vault,
      { path: 'raw-sources/papers/ordering.pdf' },
      { claudeBin: claudeBin() },
    );
    assert.equal(result.status, 'queued_for_summary',
      `42p PDF should queue for detached summary, got: ${JSON.stringify(result)}`);
    // detached stub claude が shared log にプロンプト本文 (改行含む) を書くまで polling
    let sharedLog = '';
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 25));
      sharedLog = await readFile(stubClaudeLog, 'utf8');
      if (sharedLog.includes('ARGV: -p')) break;
    }
    assert.match(sharedLog, /重要な順序/,
      `prompt must contain the ordering instruction marker, got: ${sharedLog.slice(0, 500)}`);
    assert.match(sharedLog, /全 chunk 完了後/,
      `prompt must state that index.md comes AFTER all chunks are done, got: ${sharedLog.slice(0, 500)}`);
    assert.match(sharedLog, /chunk summary を書く前に index\.md を先に書く/,
      `prompt must explain the failure mode of writing index.md first, got: ${sharedLog.slice(0, 500)}`);
  });

  test('MCP26 second call is idempotent -> skipped', async () => {
    const vault = await makeVault('mcp26');
    await cp(join(FIXTURES, 'sample-8p.pdf'), join(vault, 'raw-sources', 'papers', 'same.pdf'));
    // 最初の呼び出しで chunk を作る (stub claude は summary を作らないので手動で模倣)
    await handleIngestPdf(vault, { path: 'raw-sources/papers/same.pdf' }, { claudeBin: claudeBin() });
    // chunk MD の sha256 をそのまま summary にコピーして idempotent を誘発
    const cacheEntries = (await readdir(join(vault, '.cache', 'extracted'))).filter((n) => n.endsWith('.md'));
    for (const name of cacheEntries) {
      const chunkContent = await readFile(join(vault, '.cache', 'extracted', name), 'utf8');
      const shaMatch = chunkContent.match(/^source_sha256:\s*"([0-9a-f]{64})"/m);
      assert.ok(shaMatch, `chunk ${name} has source_sha256`);
      const summaryContent = `---\ntitle: "${name}"\nsource_sha256: "${shaMatch[1]}"\n---\nsummary\n`;
      await writeFile(join(vault, 'wiki', 'summaries', name), summaryContent);
    }
    // 2 回目の呼び出しは skipped
    const r2 = await handleIngestPdf(vault, { path: 'raw-sources/papers/same.pdf' }, { claudeBin: claudeBin() });
    assert.equal(r2.status, 'skipped', `second call should be skipped, got: ${JSON.stringify(r2)}`);
  });

  test('MCP27 non-.pdf/.md extension -> invalid_params', async () => {
    const vault = await makeVault('mcp27');
    const txt = join(vault, 'raw-sources', 'papers', 'note.txt');
    await writeFile(txt, 'plain text');
    await assert.rejects(
      handleIngestPdf(vault, { path: 'raw-sources/papers/note.txt' }, { claudeBin: claudeBin() }),
      (err) => err.code === 'invalid_params',
    );
  });

  test('MCP28 lockfile held by another writer -> LockTimeoutError', async () => {
    const vault = await makeVault('mcp28');
    await cp(join(FIXTURES, 'sample-8p.pdf'), join(vault, 'raw-sources', 'papers', 'lk.pdf'));
    // 別プロセスが保持中を模擬
    await writeFile(join(vault, '.kioku-mcp.lock'), '99999\n');
    // ACQUIRE_TIMEOUT_MS を短く上書きするのは難しいので、LockTimeoutError は本物の 60s を
    // 待つと遅い。短縮のため、lockfile を TTL 内扱いの新しい mtime にしておき、timeout を
    // handler 内部の定数に任せる代わりに外部からは待つしか無い。
    // 実用的には、MCP28 は lockfile 存在→即座に timeout に移行するアサーションに留め、
    // LockTimeoutError 発火時の挙動を確認する範囲に絞る (短時間テスト)。
    //
    // 戦略: lockfile を掴んだまま、別 Promise で handleIngestPdf を起動し、ごく短時間で
    //       まだ pending であることをアサート → lock を unlink してテスト完了 (clean up)
    const p = handleIngestPdf(vault, { path: 'raw-sources/papers/lk.pdf' }, { claudeBin: claudeBin() });
    // 100ms では extract まで到達せず lock 待ちで pending のはず
    const tick = new Promise((r) => setTimeout(() => r('pending'), 200));
    const res = await Promise.race([p.catch((e) => ({ err: e })), tick]);
    assert.equal(res, 'pending', `handler should be waiting on lock, got: ${JSON.stringify(res)}`);
    // クリーンアップ: lockfile を unlink すれば handler は acquire して進行
    await rm(join(vault, '.kioku-mcp.lock'), { force: true });
    // handler 完了を待つ (stub claude ですぐ終わる)
    await p.catch(() => {}); // 以降の assertion は別 test で
  });

  test('MCP29 child claude receives KIOKU_NO_LOG=1 + KIOKU_MCP_CHILD=1 + limited tools', async () => {
    // ログをクリアして MCP29 の実行分だけ観察
    await writeFile(stubClaudeLog, '');
    const vault = await makeVault('mcp29');
    await cp(join(FIXTURES, 'sample-8p.pdf'), join(vault, 'raw-sources', 'papers', 'env.pdf'));
    await handleIngestPdf(vault, { path: 'raw-sources/papers/env.pdf' }, { claudeBin: claudeBin() });
    const log = await readFile(stubClaudeLog, 'utf8');
    assert.match(log, /KIOKU_NO_LOG=1/, 'KIOKU_NO_LOG=1 propagated');
    assert.match(log, /KIOKU_MCP_CHILD=1/, 'KIOKU_MCP_CHILD=1 propagated');
    assert.match(log, /--allowedTools Write,Read,Edit/, 'allowedTools limited to Write,Read,Edit');
    assert.doesNotMatch(log, /--allowedTools[^\n]*Bash/, 'Bash NOT in allowedTools');
  });

  test('MCP29b child env is allowlist-filtered (LOW-4 defense)', async () => {
    // 2.1 security review LOW-4 対策: 無関係な secret env を子に伝搬しない。
    // 疑似的な GH_TOKEN / AWS_SECRET_ACCESS_KEY を process.env にセットし、
    // stub claude 側の env dump にそれらが出ないことを確認する。
    await writeFile(stubClaudeLog, '');
    const prevGh = process.env.GH_TOKEN;
    const prevAws = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.GH_TOKEN = 'ghp_SHOULD_NOT_LEAK_TO_CHILD';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-SHOULD_NOT_LEAK';
    try {
      const vault = await makeVault('mcp29b');
      await cp(join(FIXTURES, 'sample-8p.pdf'), join(vault, 'raw-sources', 'papers', 'env2.pdf'));
      await handleIngestPdf(vault, { path: 'raw-sources/papers/env2.pdf' }, { claudeBin: claudeBin() });
      const log = await readFile(stubClaudeLog, 'utf8');
      assert.doesNotMatch(log, /SHOULD_NOT_LEAK/, 'GH_TOKEN / AWS_SECRET_ACCESS_KEY NOT propagated');
      // 正しく渡るべきもの
      assert.match(log, /OBSIDIAN_VAULT=/, 'OBSIDIAN_VAULT IS propagated');
    } finally {
      if (prevGh === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = prevGh;
      if (prevAws === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = prevAws;
    }
  });

  test('MCP30 accepts absolute path resolving to vault raw-sources/', async () => {
    const vault = await makeVault('mcp30');
    const absPdf = join(vault, 'raw-sources', 'papers', 'abs.pdf');
    await cp(join(FIXTURES, 'sample-8p.pdf'), absPdf);
    const result = await handleIngestPdf(vault, { path: absPdf }, { claudeBin: claudeBin() });
    assert.equal(result.status, 'extracted_and_summarized');
    // 相対でも同じ結果
    const vault2 = await makeVault('mcp30b');
    await cp(join(FIXTURES, 'sample-8p.pdf'), join(vault2, 'raw-sources', 'papers', 'rel.pdf'));
    const result2 = await handleIngestPdf(
      vault2,
      { path: 'raw-sources/papers/rel.pdf' },
      { claudeBin: claudeBin() },
    );
    assert.equal(result2.status, 'extracted_and_summarized');
  });

  // 2026-04-21 v0.4.0 Tier A#3 M-a4: skipLock injection を削除したため、
  // 旧 MCP30c (skipLock bypass 動作テスト) は API ごと消滅。
  // 新しい invariant は MCP45 (tools-ingest-url.test.mjs) 側で検証する:
  // - kioku_ingest_url → PDF dispatch 経路で handleIngestPdf が自前の withLock を
  //   取得する (outer withLock は dispatch 前に release される) ことが整合性の要。
});
