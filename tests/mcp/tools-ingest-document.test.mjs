// tools-ingest-document.test.mjs — kioku_ingest_document ハンドラ (機能 2.4 Phase 1/2/3) のテスト
//
// MCP-D1   tool def の shape (name/title/description/inputShape) 検証
// MCP-D7a  .epub が handleIngestEpub に dispatch される (FUTURE_EXTS ではなくなった)
// MCP-D7b  .docx が handleIngestDocx に dispatch される (Phase 3: FUTURE_EXTS ではなくなった)
// MCP-D4c  未対応拡張子の reject
// MCP-D5a/b/c  空 path / 欠落 path / null byte path の reject
// MCP-D2   .pdf delegate → handleIngestPdf → extracted_and_summarized (poppler 依存)
// MCP-D3   .md  delegate → handleIngestPdf → extracted_and_summarized (poppler 依存)
//
// E2E (MCP-D2/D3) は実 extract-pdf.sh + fixture PDF / stub claude を使うので
// poppler (pdfinfo/pdftotext) 必須。ない環境では E2E describe 全体を skip する。

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp, mkdir, rm, cp, writeFile, chmod, stat, readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_DIR = join(__dirname, '..', '..', 'mcp');
const FIXTURES = join(__dirname, '..', 'fixtures', 'pdf');
const popplerCheck = spawnSync(
  'sh',
  ['-c', 'command -v pdfinfo >/dev/null 2>&1 && command -v pdftotext >/dev/null 2>&1'],
  { stdio: 'ignore' },
);
const HAS_POPPLER = popplerCheck.status === 0;

const { INGEST_DOCUMENT_TOOL_DEF, handleIngestDocument } =
  await import(join(MCP_DIR, 'tools', 'ingest-document.mjs'));

describe('kioku_ingest_document tool definition', () => {
  test('MCP-D1 exports tool def with expected shape', () => {
    assert.equal(INGEST_DOCUMENT_TOOL_DEF.name, 'kioku_ingest_document');
    assert.match(INGEST_DOCUMENT_TOOL_DEF.title, /KIOKU/i);
    assert.match(INGEST_DOCUMENT_TOOL_DEF.description, /\.pdf/);
    assert.match(INGEST_DOCUMENT_TOOL_DEF.description, /\.md/);
    // inputShape は zod raw shape (object with zod fields)
    assert.ok(INGEST_DOCUMENT_TOOL_DEF.inputShape.path);
    assert.ok(INGEST_DOCUMENT_TOOL_DEF.inputShape.chunk_pages);
    assert.ok(INGEST_DOCUMENT_TOOL_DEF.inputShape.max_turns);
    assert.equal(typeof handleIngestDocument, 'function');
  });
});

describe('kioku_ingest_document EPUB dispatch', () => {
  const VAULT = '/tmp/nonexistent-vault-for-ext-test';
  test('MCP-D7a .epub dispatches to handleIngestEpub (extension validator passes, path guard fires)', async () => {
    // 実 vault なしなので assertInsideRawSources が throws する。
    // 目的: extension validator が通過して handleIngestEpub に dispatch される (= FUTURE_EXTS 経路ではない) こと。
    await assert.rejects(
      handleIngestDocument(VAULT, { path: 'raw-sources/books/foo.epub' }),
      (err) => err.code === 'invalid_params' || err.code === 'invalid_path' || err.code === 'base_missing' || /raw-sources|boundary|not found|missing/i.test(err.message),
    );
    // "Phase 2-3" message should NOT appear — epub is no longer FUTURE_EXTS
    let msg = '';
    try { await handleIngestDocument(VAULT, { path: 'raw-sources/books/foo.epub' }); } catch (e) { msg = e.message; }
    assert.ok(!/Phase 2-3/.test(msg), `epub should no longer be future-planned: ${msg}`);
  });
});

describe('kioku_ingest_document DOCX dispatch', () => {
  let vault;
  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'kioku-mcp-id-docx-'));
    await mkdir(join(vault, 'raw-sources', 'papers'), { recursive: true });
    await mkdir(join(vault, '.cache', 'extracted'), { recursive: true });
  });
  afterEach(async () => {
    if (vault) await rm(vault, { recursive: true, force: true });
  });

  test('MCP-D7b (Phase 3): .docx dispatches to handleIngestDocx', async () => {
    const { buildDocx } = await import('../fixtures/docx-builder.mjs');
    const docx = buildDocx();
    const p = join(vault, 'raw-sources', 'papers', 'routed.docx');
    await writeFile(p, docx);
    const r = await handleIngestDocument(vault, { path: 'raw-sources/papers/routed.docx' });
    assert.equal(r.status, 'extracted');
    assert.equal(r.chunks.length, 1);
    assert.match(r.chunks[0], /docx-papers--routed\.md$/);
  });
});

describe('kioku_ingest_document extension validation', () => {
  const VAULT = '/tmp/nonexistent-vault-for-ext-test'; // 実 filesystem には触らない

  test('MCP-D4c rejects unsupported extension with explicit list', async () => {
    await assert.rejects(
      handleIngestDocument(VAULT, { path: 'raw-sources/misc/foo.txt' }),
      (err) => err.code === 'invalid_params' && /Supported: \.pdf, \.md, \.epub, \.docx/.test(err.message),
    );
  });

  test('MCP-D5a rejects empty path', async () => {
    await assert.rejects(
      handleIngestDocument(VAULT, { path: '' }),
      (err) => err.code === 'invalid_params',
    );
  });

  test('MCP-D5b rejects missing args', async () => {
    await assert.rejects(
      handleIngestDocument(VAULT, {}),
      (err) => err.code === 'invalid_params',
    );
  });

  test('MCP-D5c rejects null byte path (delegated to handleIngestPdf)', async () => {
    // extname('foo\0.pdf') は '.pdf' になるので FUTURE/UNSUPPORTED ガードは通過、
    // handleIngestPdf 内の validate() で null byte が拒否される。
    await assert.rejects(
      handleIngestDocument(VAULT, { path: 'raw-sources/foo\0.pdf' }),
      (err) => err.code === 'invalid_params',
    );
  });
});

describe('kioku_ingest_document E2E delegate', { skip: !HAS_POPPLER ? 'poppler not installed' : false }, () => {
  let workspace, stubBinDir, stubClaudeLog;

  before(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'kioku-mcp-id-'));
    stubBinDir = join(workspace, 'stub-bin');
    stubClaudeLog = join(workspace, 'stub-claude.log');
    await mkdir(stubBinDir, { recursive: true });
    const stubClaude = join(stubBinDir, 'claude-stub.sh');
    // stub: chunk frontmatter の source_sha256 を読んで、一致する summary を生成。
    // .pdf chunks は .cache/extracted/*.md に、.md は raw-sources/ 配下に存在する。
    const script = `#!/usr/bin/env bash
# stub: .cache/extracted/*.md の source_sha256 を copy して wiki/summaries/ に summary を作る
set -euo pipefail
# invocation marker (I3: log を dead code から実際に使う assert 用シグナルに変更)
echo "=== invocation at $(date -u +%s) argv: $* ===" >> "${stubClaudeLog}"
SUM_DIR="\${OBSIDIAN_VAULT}/wiki/summaries"
mkdir -p "\${SUM_DIR}"
# PDF chunk の場合
for f in "\${OBSIDIAN_VAULT}"/.cache/extracted/*.md; do
  [ -f "\$f" ] || continue
  base="\$(basename "\$f")"
  sha="\$(sed -n 's/^source_sha256: "\\([0-9a-f]*\\)".*/\\1/p' "\$f" | head -1)"
  cat > "\${SUM_DIR}/\${base}" <<FM
---
source_sha256: "\${sha}"
---
# stub summary for \${base}
FM
done
# MD の場合 (raw-sources/ 直接) — chunk = [absPath] なので raw-sources/ 側を見る。
# macOS 標準 bash 3.2 には globstar が無いので find で再帰列挙する。
while IFS= read -r f; do
  [ -f "\$f" ] || continue
  base="\$(basename "\$f")"
  cat > "\${SUM_DIR}/\${base}" <<FM
---
source_type: md
---
# stub summary for \${base}
FM
done < <(find "\${OBSIDIAN_VAULT}/raw-sources" -type f -name '*.md' 2>/dev/null)
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

  test('MCP-D2 .pdf delegates to handleIngestPdf and returns extracted_and_summarized', async () => {
    const vault = await makeVault('mcp-d2');
    await cp(join(FIXTURES, 'sample-8p.pdf'), join(vault, 'raw-sources', 'papers', 'foo.pdf'));
    const result = await handleIngestDocument(
      vault,
      { path: 'raw-sources/papers/foo.pdf' },
      { claudeBin: join(stubBinDir, 'claude-stub.sh') },
    );
    assert.equal(result.status, 'extracted_and_summarized');
    assert.ok(result.chunks.length >= 1);
    assert.ok(result.summaries.length >= 1);
    // I2: chunks / summaries の path 内容も検証 (path 破綻検出)
    assert.ok(
      result.chunks[0].includes('foo'),
      `chunks[0] should reference the source stem, got: ${result.chunks[0]}`,
    );
    assert.ok(
      result.summaries[0].startsWith('wiki/summaries/'),
      `summaries should be under wiki/summaries/, got: ${result.summaries[0]}`,
    );
    // I3: stub が実際に invoke されたことを確認 (log は before で初期化、appending)
    const log = await readFile(stubClaudeLog, 'utf8');
    assert.match(log, /=== invocation/, 'claude stub should have been invoked');
  });

  test('MCP-D3 .md delegates to handleIngestPdf and returns extracted_and_summarized', async () => {
    const vault = await makeVault('mcp-d3');
    const mdPath = join(vault, 'raw-sources', 'papers', 'note.md');
    await writeFile(mdPath, '---\ntitle: test\n---\n# Test note\n', 'utf8');
    const result = await handleIngestDocument(
      vault,
      { path: 'raw-sources/papers/note.md' },
      { claudeBin: join(stubBinDir, 'claude-stub.sh') },
    );
    assert.equal(result.status, 'extracted_and_summarized');
    // I1: status だけでは stub が summary を一切書かなくても pass するので
    // filesystem 側で summary file の実在を確認する (status 脆弱性解消)
    const summaryPath = join(vault, 'wiki', 'summaries', 'note.md');
    const summaryExists = await stat(summaryPath).then(() => true, () => false);
    assert.ok(summaryExists, 'stub summary should be written to wiki/summaries/note.md');
    // I3: stub が実際に invoke されたことを確認
    const log = await readFile(stubClaudeLog, 'utf8');
    assert.match(log, /=== invocation/, 'claude stub should have been invoked');
  });
});
