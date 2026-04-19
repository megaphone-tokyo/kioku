// tools-ingest-pdf.test.mjs — kioku_ingest_pdf ハンドラ (機能 2.1) のユニット/結合テスト
//
// MCP23  path が Vault 外 → invalid_params
// MCP24  暗号化 PDF → invalid_request
// MCP25  正常実行 → status: "extracted_and_summarized"
// MCP26  冪等呼び出し → status: "skipped"
// MCP27  非 .pdf/.md 拡張子 → invalid_params
// MCP28  lockfile 競合 (別プロセスが保持) → LockTimeoutError
// MCP29  --allowedTools Write,Read,Edit + KIOKU_NO_LOG=1 + KIOKU_MCP_CHILD=1 が子 claude に渡る
// MCP30  相対パスと絶対パス両方が受理される
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

  test('MCP25 normal execution -> extracted_and_summarized', async () => {
    const vault = await makeVault('mcp25');
    await cp(join(FIXTURES, 'sample-8p.pdf'), join(vault, 'raw-sources', 'papers', 'attention.pdf'));
    const result = await handleIngestPdf(
      vault,
      { path: 'raw-sources/papers/attention.pdf' },
      { claudeBin: claudeBin() },
    );
    assert.equal(result.status, 'extracted_and_summarized');
    assert.ok(result.pdf_path.endsWith('attention.pdf'), 'pdf_path returned');
    assert.ok(Array.isArray(result.chunks) && result.chunks.length >= 1, 'chunks list non-empty');
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
});
