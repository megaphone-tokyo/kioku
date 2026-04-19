// mask-text.test.mjs — scripts/mask-text.mjs の CLI / module 両モード検証。
//
// 実行: node --test tools/claude-brain/tests/mask-text.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, '..', 'scripts', 'mask-text.mjs');

describe('mask-text.mjs CLI mode', () => {
  test('MT1 CLI applies mask to stdin and writes masked output to stdout', () => {
    const input = 'use sk-ant-AAAAAAAAAAAAAAAAAAAAA in body';
    const result = spawnSync('node', [CLI_PATH], { input, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('sk-ant-***'));
    assert.ok(!result.stdout.includes('sk-ant-AAAAAAAAAAAAAAAAAAAAA'));
  });

  test('MT3 CLI handles empty stdin without crashing', () => {
    const result = spawnSync('node', [CLI_PATH], { input: '', encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  test('MT4 CLI preserves non-ASCII characters', () => {
    const input = '日本語のテキストは壊さない。絵文字も 🎉 そのまま。\n';
    const result = spawnSync('node', [CLI_PATH], { input, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, input);
  });

  test('MT5 CLI passes through text with no secrets unchanged', () => {
    const input = 'plain text with no secrets, only words and numbers 12345.\n';
    const result = spawnSync('node', [CLI_PATH], { input, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, input);
  });

  test('MT6 --sanitize-source-type strips shell metachars and control chars', () => {
    const result = spawnSync(
      'node',
      [CLI_PATH, '--sanitize-source-type', '; rm -rf /'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), 'rm -rf /');
  });
});

describe('mask-text.mjs module mode', () => {
  test('MT2 maskText replaces known patterns', async () => {
    const mod = await import(CLI_PATH);
    const out = mod.maskText('Authorization: Bearer abcdef.ghijkl_-mn');
    assert.ok(out.includes('Bearer ***'));
    assert.ok(!out.includes('abcdef.ghijkl_-mn'));
  });

  test('MT2b maskText preserves text that does not match any rule', async () => {
    const mod = await import(CLI_PATH);
    const input = 'hello world\nno secrets\n';
    assert.equal(mod.maskText(input), input);
  });

  test('MT7 sanitizeSourceType removes shell metacharacters', async () => {
    const mod = await import(CLI_PATH);
    assert.equal(mod.sanitizeSourceType('; rm -rf /'), 'rm -rf /');
    assert.equal(mod.sanitizeSourceType('paper'), 'paper');
    assert.equal(mod.sanitizeSourceType('ISO-standard'), 'ISO-standard');
    assert.equal(mod.sanitizeSourceType('bad`back$tick&pipe|'), 'badbacktickpipe');
  });

  test('MT8 sanitizeSourceType strips control characters', async () => {
    const mod = await import(CLI_PATH);
    assert.equal(mod.sanitizeSourceType('pap\x00er\x1f'), 'paper');
  });

  test('MT9 MASK_RULES is re-exported from CLI module', async () => {
    const mod = await import(CLI_PATH);
    assert.ok(Array.isArray(mod.MASK_RULES));
    assert.ok(mod.MASK_RULES.length > 10);
  });

  // 以下 MT10-MT13: VULN-002/003/014 (Unicode 不可視文字バイパス) の回帰テスト
  test('MT10 maskText strips soft hyphen then masks sk-ant token', async () => {
    const mod = await import(CLI_PATH);
    // "sk-\u00ADant-" は元の MASK_RULES では未マッチだが、前処理で SHY を除去
    const input = 'see sk-\u00ADant-AAAAAAAAAAAAAAAAAAAAA inline';
    const out = mod.maskText(input);
    assert.ok(out.includes('sk-ant-***'), `expected sk-ant-*** mask, got: ${out}`);
    assert.ok(!out.includes('AAAAAAAAAAAAAAAAAAAAA'));
  });

  test('MT11 maskText strips zero-width space across token boundary', async () => {
    const mod = await import(CLI_PATH);
    const input = 'see ghp_\u200BAAAAAAAAAAAAAAAAAAAAAAAA inline';
    const out = mod.maskText(input);
    assert.ok(out.includes('ghp_***'), `expected ghp_*** mask, got: ${out}`);
    assert.ok(!out.includes('AAAAAAAAAAAAAAAAAAAAAAAA'));
  });

  test('MT12 sanitizeSourceType strips RTLO, ZWSP, BOM', async () => {
    const mod = await import(CLI_PATH);
    // U+202E RTLO, U+200B ZWSP, U+FEFF BOM should all be removed
    assert.equal(
      mod.sanitizeSourceType('paper\u202Eignore\u200Binstructions\uFEFF'),
      'paperignoreinstructions',
    );
  });

  test('MT13 sanitizeSourceType normalizes NFC', async () => {
    const mod = await import(CLI_PATH);
    // NFD "é" (e + combining acute) → NFC "é" (single codepoint)
    const nfd = 'pape\u0301r';
    const nfc = 'pap\u00e9r';
    assert.equal(mod.sanitizeSourceType(nfd), nfc);
  });
});
