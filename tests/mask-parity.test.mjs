// mask-parity.test.mjs — masking SSOT (v0.11 S6-3、plan 26070601 §4.3) の
// 4-way sync verify test。scripts/lib/masking.mjs ⇔ mcp/lib/masking.mjs の
// SHARED LITERAL ブロック一致を機械 verify する:
//   (a) MASK_RULES 21 rule の serialize (source / flags / replacement) JSON 比較
//   (b) sanitizeSourceType の関数 body 文字列比較
//   (c) 代表 input 12 種の behavioral parity (maskText ⇔ applyMasks 出力一致)
//
// app/ 側 2 copy (app/scripts/lib / app/mcp/lib) は sync-to-app.sh 経由で反映
// されるため本 test の対象外 (LEARN#11、直接編集禁止)。sync 後に app path でも
// 同観点の verify を行う (release checklist)。
//
// LEARN#13: 制御文字 / invisible unicode を raw で source に書くことは禁止。
// 本 file では escape literal の代わりに String.fromCharCode(0xNNNN) で実行時に
// 構築する (codepoint が可視のまま raw 混入をゼロにする、escape と同等の可読性)。
//
// F-number 採番根拠 (LEARN#8a): 本 file は per-file namespace の新規 file のため
// MP1 から採番 (mask-text.test.mjs の MT 系 / tests/mcp/lib.test.mjs の LIB 系と
// は独立)。
//
// 実行: node --test tools/claude-brain/tests/mask-parity.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MASK_RULES as scriptsRules,
  maskText,
  sanitizeSourceType as scriptsSanitize,
} from '../scripts/lib/masking.mjs';
import {
  MASK_RULES as mcpRules,
  applyMasks,
  sanitizeSourceType as mcpSanitize,
} from '../mcp/lib/masking.mjs';

// --- 実行時構築の制御文字 / invisible unicode (LEARN#13) ---
const NL = String.fromCharCode(0x000a); // LINE FEED
const NUL = String.fromCharCode(0x0000); // NULL
const BEL = String.fromCharCode(0x0007); // BELL
const US = String.fromCharCode(0x001f); // UNIT SEPARATOR
const DEL = String.fromCharCode(0x007f); // DELETE
const SHY = String.fromCharCode(0x00ad); // SOFT HYPHEN
const ZWSP = String.fromCharCode(0x200b); // ZERO WIDTH SPACE
const RTLO = String.fromCharCode(0x202e); // RIGHT-TO-LEFT OVERRIDE
const BOM = String.fromCharCode(0xfeff); // BYTE ORDER MARK (ZWNBSP)
const COMB_ACUTE = String.fromCharCode(0x0301); // COMBINING ACUTE ACCENT (NFD 用)

// RegExp は JSON.stringify で {} に潰れるため、source / flags を明示的に展開して
// から JSON 化する (naive な JSON.stringify(MASK_RULES) では regex drift が
// 検出できず常に一致してしまう)。
function serializeRules(rules) {
  return JSON.stringify(rules.map(([re, repl]) => [re.source, re.flags, repl]));
}

// 代表 input 12 種 (handoff 26070602 PR S6-3 指定: sk-ant- / ghp_ / AKIA /
// PRIVATE KEY / 制御文字 / ZWSP / 正常系他)。secret は全て明白な dummy 値のみ。
// [label, input, mustNotLeak (masked 出力に残ってはいけない生 secret、null = 正常系)]
const PARITY_INPUTS = [
  ['sk-ant- API key', 'use sk-ant-AAAAAAAAAAAAAAAAAAAAA in body', 'AAAAAAAAAAAAAAAAAAAAA'],
  ['ghp_ GitHub token', 'push with ghp_BBBBBBBBBBBBBBBBBBBBBBBB done', 'BBBBBBBBBBBBBBBBBBBBBBBB'],
  ['AKIA AWS access key', 'aws key AKIAIOSFODNN7EXAMPLE here', 'AKIAIOSFODNN7EXAMPLE'],
  [
    'PRIVATE KEY block',
    '-----BEGIN RSA PRIVATE KEY-----' + NL + 'MIIdummykeydummykeydummy' + NL + '-----END RSA PRIVATE KEY-----',
    'MIIdummykeydummykeydummy',
  ],
  ['Bearer header', 'Authorization: Bearer abcdef.ghijkl_-mn', 'abcdef.ghijkl_-mn'],
  ['password assignment', 'config password=supersecret123 rest', 'supersecret123'],
  ['URL credential', 'fetch https://user:hunter2pw@example.com/path now', 'hunter2pw'],
  [
    'ZWSP-split sk-ant token (VULN-002/003/014 系)',
    'see sk-' + ZWSP + 'ant-AAAAAAAAAAAAAAAAAAAAA inline',
    'AAAAAAAAAAAAAAAAAAAAA',
  ],
  [
    'soft-hyphen-split ghp_ token (VULN-002/003/014 系)',
    'see ghp_' + SHY + 'BBBBBBBBBBBBBBBBBBBBBBBB inline',
    'BBBBBBBBBBBBBBBBBBBBBBBB',
  ],
  ['制御文字混在 (NUL / BEL / US)', 'line' + NUL + 'with' + BEL + 'ctrl' + US + 'chars', null],
  ['正常系 plain ASCII', 'plain text with no secrets, only words and numbers 12345.', null],
  ['正常系 non-ASCII + NFD 正規化', '日本語テキスト 🎉 pape' + COMB_ACUTE + 'r', null],
];

describe('mask-parity (a): MASK_RULES literal equality', () => {
  test('MP1 both files export exactly 21 rules', () => {
    assert.equal(scriptsRules.length, 21, 'scripts/lib MASK_RULES must have 21 rules');
    assert.equal(mcpRules.length, 21, 'mcp/lib MASK_RULES must have 21 rules');
  });

  test('MP2 serialized rules (source / flags / replacement) are JSON-identical', () => {
    assert.equal(
      serializeRules(scriptsRules),
      serializeRules(mcpRules),
      'MASK_RULES literal drift between scripts/lib and mcp/lib',
    );
  });
});

describe('mask-parity (b): sanitizeSourceType literal equality', () => {
  test('MP3 function body toString() is identical', () => {
    assert.equal(
      scriptsSanitize.toString(),
      mcpSanitize.toString(),
      'sanitizeSourceType body drift between scripts/lib and mcp/lib',
    );
  });
});

describe('mask-parity (c): behavioral parity on 12 representative inputs', () => {
  test('MP4 input table has exactly 12 entries', () => {
    assert.equal(PARITY_INPUTS.length, 12);
  });

  test('MP5 maskText and applyMasks produce identical output for all 12 inputs', () => {
    for (const [label, input] of PARITY_INPUTS) {
      assert.equal(maskText(input), applyMasks(input), 'parity broken for: ' + label);
    }
  });

  test('MP6 secret-bearing inputs are actually masked by both implementations', () => {
    // 「両実装が同じ壊れ方をして parity だけ通る」regression を防ぐため、
    // 生 secret が出力に残らないことも両側で assert する。
    for (const [label, input, mustNotLeak] of PARITY_INPUTS) {
      if (mustNotLeak === null) continue;
      assert.ok(
        !maskText(input).includes(mustNotLeak),
        'maskText leaked secret for: ' + label,
      );
      assert.ok(
        !applyMasks(input).includes(mustNotLeak),
        'applyMasks leaked secret for: ' + label,
      );
    }
  });

  test('MP7 sanitizeSourceType behavioral parity (closure の INVISIBLE_CHARS_RE 補完)', () => {
    // MP3 の toString() 比較は closure 変数 INVISIBLE_CHARS_RE の中身を検査
    // できないため、invisible unicode を含む入力の挙動一致で補完する。
    const cases = [
      'pap' + NUL + 'er' + BEL + US + DEL,
      '; rm -rf /',
      'bad`back$tick&pipe|',
      'paper' + RTLO + 'ignore' + ZWSP + 'instructions' + BOM,
      'soft' + SHY + 'hyphen',
      'pape' + COMB_ACUTE + 'r',
      'ISO-standard',
    ];
    for (const input of cases) {
      assert.equal(
        scriptsSanitize(input),
        mcpSanitize(input),
        'sanitizeSourceType parity broken for input: ' + JSON.stringify(input),
      );
    }
    // 非文字列入力は両側とも空文字に落ちる
    assert.equal(scriptsSanitize(null), mcpSanitize(null));
    assert.equal(scriptsSanitize(undefined), mcpSanitize(undefined));
    assert.equal(scriptsSanitize(42), mcpSanitize(42));
  });
});
