// tests/mobile-search-ux.test.mjs — Sprint 4 Phase 3 PR B3 Search tab Mobile UX
//
// Targets: shell-template.html の Search tab Mobile UX 強化を機械的に verify。
//          plan 26051405 §「PR B3」L276-289 の canonical CSS spec を test に codify。
//
// Test prefixes (BLUE-MOBILE-B3-* namespace, per LEARN#8a per-file scope = F1 から):
//   - BLUE-MOBILE-B3-5 : Search input font-size 16px が Mobile media query 内に存在
//                        (iOS Safari < 16px で input focus 時 auto-zoom 発生、UX 阻害)。
//                        kioku-search-input class が JS 内で element に代入されていること。
//   - BLUE-MOBILE-B3-6 : Search results scroll behavior
//                        (overflow-y: auto + -webkit-overflow-scrolling: touch +
//                         max-height: calc(100vh - <px>)) が Mobile media query 内に存在。
//                        kioku-search-results class が JS 内で element に代入されていること。
//   - BLUE-MOBILE-B3-7 : virtual keyboard 対応
//                        (max-height calc(100vh - 200px) + kioku-tier2-search-btn の
//                         min-height 44px + width 100%) が Mobile media query 内に存在。
//
// 設計方針:
//   - Node 18+ stdlib のみ (外部依存なし、jsdom 不要)
//   - file content の string check (regex match) で OK、Mobile rendering test は
//     PR C3 で test-helpers.mjs に mockMobileViewport 追加後
//   - error message は「expected: X / found: Y / fix: Z」形式
//   - Mobile media query 内側の宣言を verify するため、bracket balance counter で
//     @media (max-width: 767px) { ... } の中身を抽出する helper を用いる
//     (lazy quantifier では nested { } を取り違える)
//
// LEARN#13 注意: regex literal に U+2028 / U+2029 / U+200B / U+FEFF を直接書かない。
// 本 file は ASCII のみで constructed regex を使う。
// LEARN#14: import 経由で test framework が load する → ESM entry gate 不要。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const moduleFilePath = fileURLToPath(import.meta.url);
const moduleDir = dirname(moduleFilePath);
const CB_ROOT = resolve(moduleDir, '..'); // tools/claude-brain/

const PATHS = {
  shellTemplate: join(CB_ROOT, 'mcp', 'templates', 'shell-template.html'),
};

async function readShell() {
  return readFile(PATHS.shellTemplate, 'utf-8');
}

// @media (max-width: 767px) { ... } の中身を bracket balance で抽出する。
// nested { } (e.g. selector rule の中括弧) を正しく扱うため、lazy regex ではなく
// open/close brace の depth counter で抽出位置を決める。
function extractMobileMediaBlock(html) {
  const headerRe = /@media\s*\(\s*max-width:\s*767px\s*\)\s*\{/;
  const m = html.match(headerRe);
  if (!m) return '';
  const start = m.index;
  const openIdx = html.indexOf('{', start);
  if (openIdx < 0) return '';
  let depth = 1;
  let i = openIdx + 1;
  while (i < html.length && depth > 0) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) return html.slice(openIdx + 1, i);
    }
    i++;
  }
  return html.slice(openIdx + 1); // unmatched (defensive)
}

describe('Sprint 4 Phase 3 PR B3 — Search tab Mobile UX', () => {
  test('BLUE-MOBILE-B3-5: Search input font-size 16px in Mobile media query (iOS auto-zoom prevention)', async () => {
    const html = await readShell();
    const mediaBlock = extractMobileMediaBlock(html);
    assert.ok(
      mediaBlock.length > 0,
      'expected: @media (max-width: 767px) { ... } block in shell-template.html\n' +
        'found: no Mobile media query block\n' +
        'fix: add @media (max-width: 767px) { ... } per plan 26051405 §PR A3 line 141'
    );

    // .kioku-search-input または #kioku-search-input selector が Mobile block 内に存在
    const selectorRe = /(?:\.|#)kioku-search-input\b/;
    assert.ok(
      selectorRe.test(mediaBlock),
      'expected: .kioku-search-input or #kioku-search-input selector inside @media (max-width: 767px) block\n' +
        'found: no Search input selector in Mobile block\n' +
        'fix: add .kioku-search-input rule per plan 26051405 §PR B3 line 276-289'
    );

    // 同じ Mobile block 内に font-size: 16px が宣言されている
    // (selector と同一 rule 内であることまでは strict には verify しないが、
    //  Mobile block 内 substring search で実用上十分。drift 検出の guard として機能)
    const fontSizeRe = /font-size\s*:\s*16px/;
    assert.ok(
      fontSizeRe.test(mediaBlock),
      'expected: `font-size: 16px` declaration inside @media (max-width: 767px) block\n' +
        'found: no `font-size: 16px` in Mobile block\n' +
        'fix: add `font-size: 16px` to .kioku-search-input rule per plan 26051405 §PR B3 (iOS Safari auto-zoom 防止、16px 以上必須)'
    );

    // kioku-search-input class が JS 内で element に代入されている (input.className = 'kioku-search-input')
    const classAssignRe = /\binput\.className\s*=\s*['"]kioku-search-input['"]/;
    assert.ok(
      classAssignRe.test(html),
      'expected: `input.className = \'kioku-search-input\'` in shell-template.html JS\n' +
        'found: no class assignment for Search input element\n' +
        'fix: assign className = \'kioku-search-input\' to the search <input> in renderSearch() per plan 26051405 §PR B3'
    );
  });

  test('BLUE-MOBILE-B3-6: Search results scroll behavior (overflow-y + -webkit-overflow-scrolling + max-height)', async () => {
    const html = await readShell();
    const mediaBlock = extractMobileMediaBlock(html);
    assert.ok(
      mediaBlock.length > 0,
      'expected: @media (max-width: 767px) { ... } block in shell-template.html\n' +
        'found: no Mobile media query block\n' +
        'fix: add @media (max-width: 767px) { ... } per plan 26051405 §PR A3 line 141'
    );

    // .kioku-search-results または #kioku-search-results selector が Mobile block 内に存在
    const selectorRe = /(?:\.|#)kioku-search-results\b/;
    assert.ok(
      selectorRe.test(mediaBlock),
      'expected: .kioku-search-results or #kioku-search-results selector inside @media (max-width: 767px) block\n' +
        'found: no Search results selector in Mobile block\n' +
        'fix: add .kioku-search-results rule per plan 26051405 §PR B3 line 276-289'
    );

    // overflow-y: auto が Mobile block 内に宣言されている
    const overflowRe = /overflow-y\s*:\s*auto/;
    assert.ok(
      overflowRe.test(mediaBlock),
      'expected: `overflow-y: auto` declaration inside @media (max-width: 767px) block\n' +
        'found: no `overflow-y: auto` in Mobile block\n' +
        'fix: add `overflow-y: auto` to .kioku-search-results rule per plan 26051405 §PR B3 (virtual keyboard 開時 scroll)'
    );

    // -webkit-overflow-scrolling: touch が Mobile block 内に宣言されている (iOS momentum scroll)
    const webkitScrollRe = /-webkit-overflow-scrolling\s*:\s*touch/;
    assert.ok(
      webkitScrollRe.test(mediaBlock),
      'expected: `-webkit-overflow-scrolling: touch` declaration inside @media (max-width: 767px) block\n' +
        'found: no `-webkit-overflow-scrolling: touch` in Mobile block\n' +
        'fix: add `-webkit-overflow-scrolling: touch` to .kioku-search-results rule per plan 26051405 §PR B3 (iOS momentum scroll 維持)'
    );

    // max-height: calc(100vh - <px>) が Mobile block 内に存在 (viewport-relative height)
    const maxHeightRe = /max-height\s*:\s*calc\(\s*100vh\s*-\s*\d+px\s*\)/;
    assert.ok(
      maxHeightRe.test(mediaBlock),
      'expected: `max-height: calc(100vh - <px>)` declaration inside @media (max-width: 767px) block\n' +
        'found: no viewport-relative max-height in Mobile block\n' +
        'fix: add `max-height: calc(100vh - 200px)` to .kioku-search-results rule per plan 26051405 §PR B3 (virtual keyboard 縮小追随)'
    );

    // kioku-search-results class が JS 内で element に代入されている
    // (resultsRoot.className = 'kioku-search-results')
    const classAssignRe = /\bresultsRoot\.className\s*=\s*['"]kioku-search-results['"]/;
    assert.ok(
      classAssignRe.test(html),
      'expected: `resultsRoot.className = \'kioku-search-results\'` in shell-template.html JS\n' +
        'found: no class assignment for Search results element\n' +
        'fix: assign className = \'kioku-search-results\' to the results <div> in renderSearch() per plan 26051405 §PR B3'
    );
  });

  test('BLUE-MOBILE-B3-7: virtual keyboard support (max-height calc + Tier 2 button full-width 44pt tap target)', async () => {
    const html = await readShell();
    const mediaBlock = extractMobileMediaBlock(html);
    assert.ok(
      mediaBlock.length > 0,
      'expected: @media (max-width: 767px) { ... } block in shell-template.html\n' +
        'found: no Mobile media query block\n' +
        'fix: add @media (max-width: 767px) { ... } per plan 26051405 §PR A3 line 141'
    );

    // max-height: calc(100vh - 200px) (canonical) または相当する calc(100vh - <px>) 形式
    // canonical を優先 verify、tolerance として generic form も許容
    const canonicalRe = /max-height\s*:\s*calc\(\s*100vh\s*-\s*200px\s*\)/;
    const genericRe = /max-height\s*:\s*calc\(\s*100vh\s*-\s*\d+px\s*\)/;
    assert.ok(
      canonicalRe.test(mediaBlock) || genericRe.test(mediaBlock),
      'expected: `max-height: calc(100vh - 200px)` (or calc(100vh - <px>)) inside @media (max-width: 767px) block\n' +
        'found: no viewport-relative max-height in Mobile block\n' +
        'fix: add `max-height: calc(100vh - 200px)` per plan 26051405 §PR B3 line 276-289 (virtual keyboard 開時 viewport 縮小追随)'
    );

    // kioku-tier2-search-btn selector rule が Mobile block 内に存在
    const tier2SelectorRe = /\.kioku-tier2-search-btn\b/;
    assert.ok(
      tier2SelectorRe.test(mediaBlock),
      'expected: .kioku-tier2-search-btn selector inside @media (max-width: 767px) block\n' +
        'found: no Tier 2 deep-link button selector in Mobile block\n' +
        'fix: add .kioku-tier2-search-btn rule inside @media (max-width: 767px) per plan 26051405 §PR B3 line 276-289'
    );

    // Mobile block 内の kioku-tier2-search-btn rule の中身 (selector { ... }) を抽出
    // 単純化: Mobile block 内で .kioku-tier2-search-btn の出現位置 + 続く { ... } の中身を取得
    const tier2RuleRe = /\.kioku-tier2-search-btn\s*\{([^}]*)\}/;
    const tier2Match = mediaBlock.match(tier2RuleRe);
    assert.ok(
      tier2Match && tier2Match[1],
      'expected: .kioku-tier2-search-btn { ... } rule body inside @media (max-width: 767px) block\n' +
        'found: selector present but no rule body extracted\n' +
        'fix: ensure .kioku-tier2-search-btn rule has { ... } body in Mobile block per plan 26051405 §PR B3'
    );
    const tier2Body = tier2Match[1];

    // width: 100% が Tier 2 button Mobile rule 内に宣言 (full-width button、指タップ範囲拡大)
    const widthRe = /width\s*:\s*100%/;
    assert.ok(
      widthRe.test(tier2Body),
      'expected: `width: 100%` inside .kioku-tier2-search-btn rule body (Mobile block)\n' +
        'found: no `width: 100%` declaration in Tier 2 button Mobile rule\n' +
        'fix: add `width: 100%` to .kioku-tier2-search-btn Mobile rule per plan 26051405 §PR B3 (full-width button、virtual keyboard 開時の指タップ範囲拡大)'
    );

    // min-height: 44px が Tier 2 button Mobile rule 内に宣言 (tap target)
    const minHeightRe = /min-height\s*:\s*44px/;
    assert.ok(
      minHeightRe.test(tier2Body),
      'expected: `min-height: 44px` inside .kioku-tier2-search-btn rule body (Mobile block)\n' +
        'found: no `min-height: 44px` declaration in Tier 2 button Mobile rule\n' +
        'fix: add `min-height: 44px` to .kioku-tier2-search-btn Mobile rule per plan 26051405 §PR B3 (tap target、virtual keyboard 表示時 tap 可)'
    );
  });
});
