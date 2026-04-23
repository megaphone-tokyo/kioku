// child-env.test.mjs — mcp/lib/child-env.mjs の単体テスト
//
// 実行: node --test tools/claude-brain/tests/mcp/child-env.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_DIR = join(__dirname, '..', '..', 'mcp');

const { buildChildEnv, ENV_ALLOW_EXACT, ENV_ALLOW_PREFIXES } =
  await import(join(MCP_DIR, 'lib', 'child-env.mjs'));

describe('child-env', () => {
  test('CE-1 buildChildEnv passes OS standard keys', () => {
    // PATH と HOME は allowlist に含まれるので必ず伝播する
    const built = buildChildEnv();
    assert.ok('PATH' in built, 'PATH should be in child env');
  });

  test('CE-2 buildChildEnv passes ANTHROPIC_ prefix', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key-123';
    try {
      const built = buildChildEnv();
      assert.equal(built.ANTHROPIC_API_KEY, 'test-key-123', 'ANTHROPIC_ prefix should pass through');
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  test('CE-3 buildChildEnv merges extraEnv (bypass allowlist)', () => {
    const built = buildChildEnv({ MY_CUSTOM_VAR: 'hello' });
    assert.equal(built.MY_CUSTOM_VAR, 'hello', 'extraEnv should bypass allowlist');
  });

  test('CE-4 buildChildEnv does NOT leak KIOKU_URL_ALLOW_LOOPBACK', () => {
    const saved = process.env.KIOKU_URL_ALLOW_LOOPBACK;
    process.env.KIOKU_URL_ALLOW_LOOPBACK = '1';
    try {
      const built = buildChildEnv();
      assert.ok(!('KIOKU_URL_ALLOW_LOOPBACK' in built), 'KIOKU_URL_ALLOW_LOOPBACK must NOT leak to child env');
    } finally {
      if (saved === undefined) delete process.env.KIOKU_URL_ALLOW_LOOPBACK;
      else process.env.KIOKU_URL_ALLOW_LOOPBACK = saved;
    }
  });

  test('CE-5 buildChildEnv does NOT leak KIOKU_EXTRACT_URL_SCRIPT', () => {
    const saved = process.env.KIOKU_EXTRACT_URL_SCRIPT;
    process.env.KIOKU_EXTRACT_URL_SCRIPT = '/tmp/evil';
    try {
      const built = buildChildEnv();
      assert.ok(!('KIOKU_EXTRACT_URL_SCRIPT' in built), 'KIOKU_EXTRACT_URL_SCRIPT must NOT leak to child env');
    } finally {
      if (saved === undefined) delete process.env.KIOKU_EXTRACT_URL_SCRIPT;
      else process.env.KIOKU_EXTRACT_URL_SCRIPT = saved;
    }
  });

  test('CE-6 ENV_ALLOW_EXACT contains required KIOKU internal flags', () => {
    const required = ['KIOKU_NO_LOG', 'KIOKU_MCP_CHILD', 'KIOKU_DEBUG', 'KIOKU_LLM_FB_OUT', 'KIOKU_LLM_FB_LOG'];
    for (const k of required) {
      assert.ok(ENV_ALLOW_EXACT.has(k), `${k} should be in ENV_ALLOW_EXACT`);
    }
  });

  test('CE-7 ENV_ALLOW_PREFIXES contains ANTHROPIC_ CLAUDE_ XDG_ but NOT KIOKU_', () => {
    assert.ok(ENV_ALLOW_PREFIXES.includes('ANTHROPIC_'), 'ANTHROPIC_ should be in prefixes');
    assert.ok(ENV_ALLOW_PREFIXES.includes('CLAUDE_'), 'CLAUDE_ should be in prefixes');
    assert.ok(ENV_ALLOW_PREFIXES.includes('XDG_'), 'XDG_ should be in prefixes');
    assert.ok(!ENV_ALLOW_PREFIXES.includes('KIOKU_'), 'KIOKU_ prefix must NOT be in allowlist');
  });

  test('MCP-D6n KIOKU_DOC_MAX_* / KIOKU_EXTRACT_EPUB_* leak none (Phase 2)', () => {
    const saved = { ...process.env };
    process.env.KIOKU_DOC_MAX_EXTRACT_BYTES = '9999';
    process.env.KIOKU_DOC_MAX_ENTRIES = '9999';
    process.env.KIOKU_DOC_MAX_ENTRY_BYTES = '9999';
    process.env.KIOKU_DOC_MAX_INPUT_BYTES = '9999';
    process.env.KIOKU_EXTRACT_EPUB_SCRIPT = '/tmp/evil';
    process.env.KIOKU_ALLOW_EXTRACT_EPUB_OVERRIDE = '1';
    try {
      const built = buildChildEnv();
      for (const k of [
        'KIOKU_DOC_MAX_EXTRACT_BYTES', 'KIOKU_DOC_MAX_ENTRIES',
        'KIOKU_DOC_MAX_ENTRY_BYTES', 'KIOKU_DOC_MAX_INPUT_BYTES',
        'KIOKU_EXTRACT_EPUB_SCRIPT', 'KIOKU_ALLOW_EXTRACT_EPUB_OVERRIDE',
      ]) {
        assert.ok(!(k in built), `${k} should NOT leak to child env (MCP-D6n)`);
      }
    } finally {
      // restore
      for (const k of Object.keys(process.env)) {
        if (!(k in saved)) delete process.env[k];
      }
      for (const [k, v] of Object.entries(saved)) {
        process.env[k] = v;
      }
    }
  });

  test('KIOKU_EXTRACT_DOCX_SCRIPT / KIOKU_ALLOW_EXTRACT_DOCX_OVERRIDE leak none (Phase 3)', () => {
    const saved = { ...process.env };
    process.env.KIOKU_EXTRACT_DOCX_SCRIPT = '/tmp/evil.mjs';
    process.env.KIOKU_ALLOW_EXTRACT_DOCX_OVERRIDE = '1';
    try {
      const built = buildChildEnv();
      for (const k of [
        'KIOKU_EXTRACT_DOCX_SCRIPT',
        'KIOKU_ALLOW_EXTRACT_DOCX_OVERRIDE',
      ]) {
        assert.ok(!(k in built), `${k} should NOT leak to child env (Phase 3)`);
      }
    } finally {
      // restore
      for (const k of Object.keys(process.env)) {
        if (!(k in saved)) delete process.env[k];
      }
      for (const [k, v] of Object.entries(saved)) {
        process.env[k] = v;
      }
    }
  });
});
