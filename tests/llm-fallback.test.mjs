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
});
