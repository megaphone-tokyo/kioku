import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { llmFallbackExtract } from '../mcp/lib/llm-fallback.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let workspace, stubBin;
before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'kioku-llmfb-'));
  stubBin = join(workspace, 'claude-stub.sh');
  // stub writes a known markdown to the target file then exits 0
  await writeFile(stubBin, `#!/usr/bin/env bash
# Stub claude: write a marker file to the CWD-relative path passed via prompt.
# We rely on the handler passing the target path via env KIOKU_LLM_FB_OUT.
echo "# Stub Extracted Title" > "$KIOKU_LLM_FB_OUT"
echo "" >> "$KIOKU_LLM_FB_OUT"
echo "Stub body content derived from HTML." >> "$KIOKU_LLM_FB_OUT"
echo "ARGV: $*" > "$KIOKU_LLM_FB_LOG"
env | sort >> "$KIOKU_LLM_FB_LOG"
exit 0
`);
  await chmod(stubBin, 0o755);
});
after(() => rm(workspace, { recursive: true, force: true }));

describe('llm-fallback', () => {
  test('UE6 stub claude writes markdown and llmFallbackExtract returns it', async () => {
    const out = await llmFallbackExtract({
      html: '<html><body><div>Sparse</div></body></html>',
      url: 'https://example.com/',
      cacheDir: workspace,
      claudeBin: stubBin,
    });
    assert.match(out.markdown, /Stub Extracted Title/);
    assert.equal(out.success, true);
  });

  test('UE7 timeout triggers failure', async () => {
    const slowStub = join(workspace, 'claude-slow.sh');
    await writeFile(slowStub, '#!/usr/bin/env bash\nsleep 60\nexit 0\n');
    await chmod(slowStub, 0o755);
    const out = await llmFallbackExtract({
      html: '<html></html>',
      url: 'https://example.com/',
      cacheDir: workspace,
      claudeBin: slowStub,
      timeoutMs: 200,
    });
    assert.equal(out.success, false);
    assert.match(out.error, /timeout/i);
  });

  test('UE8 --allowedTools pattern + KIOKU_NO_LOG + KIOKU_MCP_CHILD + secrets stripped', async () => {
    const logPath = join(workspace, 'argv-env.log');
    process.env.KIOKU_LLM_FB_LOG = logPath;
    // Set sentinel secrets that should NOT propagate
    process.env.AWS_SECRET_ACCESS_KEY = 'SHOULD_NOT_LEAK_AWS';
    process.env.GITHUB_TOKEN = 'SHOULD_NOT_LEAK_GH';
    try {
      await llmFallbackExtract({
        html: '<html><body><p>x</p></body></html>',
        url: 'https://example.com/',
        cacheDir: workspace,
        claudeBin: stubBin,
      });
    } finally {
      delete process.env.KIOKU_LLM_FB_LOG;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      delete process.env.GITHUB_TOKEN;
    }
    const log = await readFile(logPath, 'utf8');
    assert.match(log, /--allowedTools Write\(/);
    assert.doesNotMatch(log, /--allowedTools[^\n]*Read/);
    assert.doesNotMatch(log, /--allowedTools[^\n]*Bash/);
    assert.match(log, /KIOKU_NO_LOG=1/);
    assert.match(log, /KIOKU_MCP_CHILD=1/);
    // Negative assertions: non-allowlisted secrets must not leak to child env
    assert.doesNotMatch(log, /SHOULD_NOT_LEAK_AWS/);
    assert.doesNotMatch(log, /SHOULD_NOT_LEAK_GH/);
  });

  test('UE9 KIOKU_URL_* security/config env must NOT propagate to child (HIGH-d1)', async () => {
    // 2026-04-20 HIGH-d1 regression test: 旧実装は `ENV_ALLOW_PREFIXES=['KIOKU_']` で
    // KIOKU_URL_ALLOW_LOOPBACK などの SSRF bypass フラグを child に propagate させていた。
    // child-env.mjs 導入で exact-match allowlist に切替済。以下の env が child argv log に
    // 現れないことを確認する。
    const logPath = join(workspace, 'argv-env-urlsecurity.log');
    process.env.KIOKU_LLM_FB_LOG = logPath;
    process.env.KIOKU_URL_ALLOW_LOOPBACK = '1';
    process.env.KIOKU_URL_IGNORE_ROBOTS = '1';
    process.env.KIOKU_EXTRACT_URL_SCRIPT = '/tmp/evil.sh';
    process.env.KIOKU_ALLOW_EXTRACT_URL_OVERRIDE = '1';
    process.env.KIOKU_URL_MAX_PDF_BYTES = '1';
    process.env.KIOKU_URL_USER_AGENT = 'pwned/1.0';
    try {
      await llmFallbackExtract({
        html: '<html><body><p>x</p></body></html>',
        url: 'https://example.com/',
        cacheDir: workspace,
        claudeBin: stubBin,
      });
    } finally {
      delete process.env.KIOKU_LLM_FB_LOG;
      delete process.env.KIOKU_URL_ALLOW_LOOPBACK;
      delete process.env.KIOKU_URL_IGNORE_ROBOTS;
      delete process.env.KIOKU_EXTRACT_URL_SCRIPT;
      delete process.env.KIOKU_ALLOW_EXTRACT_URL_OVERRIDE;
      delete process.env.KIOKU_URL_MAX_PDF_BYTES;
      delete process.env.KIOKU_URL_USER_AGENT;
    }
    const log = await readFile(logPath, 'utf8');
    // SSRF の最終防衛線である KIOKU_URL_ALLOW_LOOPBACK が child に漏れないこと
    assert.doesNotMatch(log, /KIOKU_URL_ALLOW_LOOPBACK/, 'KIOKU_URL_ALLOW_LOOPBACK must not leak to child');
    assert.doesNotMatch(log, /KIOKU_URL_IGNORE_ROBOTS/, 'KIOKU_URL_IGNORE_ROBOTS must not leak to child');
    assert.doesNotMatch(log, /KIOKU_EXTRACT_URL_SCRIPT/, 'KIOKU_EXTRACT_URL_SCRIPT must not leak to child');
    assert.doesNotMatch(log, /KIOKU_ALLOW_EXTRACT_URL_OVERRIDE/, 'override flag must not leak to child');
    assert.doesNotMatch(log, /KIOKU_URL_MAX_PDF_BYTES/, 'cap setting must not leak to child');
    assert.doesNotMatch(log, /KIOKU_URL_USER_AGENT/, 'UA override must not leak to child');
    // 内部通信フラグは引き続き propagate される (regression なし)
    assert.match(log, /KIOKU_NO_LOG=1/, 'KIOKU_NO_LOG is still propagated (internal flag)');
    assert.match(log, /KIOKU_MCP_CHILD=1/, 'KIOKU_MCP_CHILD is still propagated (internal flag)');
  });
});
