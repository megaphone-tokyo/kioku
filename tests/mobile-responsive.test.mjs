// tests/mobile-responsive.test.mjs — Sprint 4 Phase 3 PR A3 Mobile responsive CSS + Layout
//
// Targets: shell-template.html + viz-template.html の responsive 化を機械的に verify。
//          plan 26051405 §「PR A3」L120-235 の canonical impl spec を test に codify。
//
// Test prefixes (BLUE-MOBILE-A3-* namespace, per LEARN#8a per-file scope = F1 から):
//   - BLUE-MOBILE-A3-1 : shell-template.html に viewport meta tag が存在
//   - BLUE-MOBILE-A3-2 : shell-template.html + viz-template.html に
//                        @media (max-width: 767px) query が存在
//   - BLUE-MOBILE-A3-3 : tap target 44pt+ CSS が全 interactive element
//                        (button, a, input, select) に適用
//   - BLUE-MOBILE-A3-4 : hamburger menu button (.kioku-mobile-menu-button) が
//                        shell-template.html に存在、aria-label + aria-expanded 付き
//   - BLUE-MOBILE-A3-5 : viz-template.html に .visualizer-graph-mobile-fallback
//                        section が存在
//
// 設計方針:
//   - Node 18+ stdlib のみ (外部依存なし、jsdom 不要)
//   - file content の string check (regex match) で OK、Mobile rendering test は
//     PR C3 で test-helpers.mjs に mockMobileViewport 追加後
//   - error message は「expected: X / found: Y / fix: Z」形式
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
  vizTemplate: join(CB_ROOT, 'mcp', 'templates', 'viz-template.html'),
};

async function readShell() {
  return readFile(PATHS.shellTemplate, 'utf-8');
}

async function readViz() {
  return readFile(PATHS.vizTemplate, 'utf-8');
}

describe('Sprint 4 Phase 3 PR A3 — Mobile responsive CSS + Layout', () => {
  test('BLUE-MOBILE-A3-1: shell-template.html has viewport meta tag', async () => {
    const html = await readShell();
    // viewport meta tag は head 内に必須
    // 期待 pattern: <meta name="viewport" content="...width=device-width...">
    const viewportRe = /<meta\s+name=["']viewport["']\s+content=["'][^"']*width=device-width[^"']*["']\s*\/?>/i;
    assert.ok(
      viewportRe.test(html),
      'expected: <meta name="viewport" content="width=device-width, ...">\n' +
        'found: no viewport meta tag matching pattern\n' +
        'fix: add viewport meta to shell-template.html <head> per plan 26051405 §PR A3'
    );
  });

  test('BLUE-MOBILE-A3-2: shell + viz templates have @media (max-width: 767px) query', async () => {
    const shellHtml = await readShell();
    const vizHtml = await readViz();
    // breakpoint < 768px = max-width: 767px、CSS spec 上 hot path
    const mediaRe = /@media\s*\(\s*max-width:\s*767px\s*\)/;
    assert.ok(
      mediaRe.test(shellHtml),
      'expected: @media (max-width: 767px) in shell-template.html\n' +
        'found: no Mobile breakpoint media query\n' +
        'fix: add @media (max-width: 767px) { ... } per plan 26051405 §PR A3 line 141'
    );
    assert.ok(
      mediaRe.test(vizHtml),
      'expected: @media (max-width: 767px) in viz-template.html\n' +
        'found: no Mobile breakpoint media query\n' +
        'fix: add @media (max-width: 767px) { ... } per plan 26051405 §PR A3 line 186'
    );
  });

  test('BLUE-MOBILE-A3-3: tap target 44pt+ enforcement on button/a/input/select', async () => {
    const html = await readShell();
    // plan canonical pattern: `button, a, input, select { min-width: 44px; min-height: 44px; }`
    // tolerate whitespace / minor ordering variations.
    // 検出: 4 selector を含む rule で min-width:44px + min-height:44px が同居
    // selector の順不同を許容するため、interactive element を一つずつ assert
    const interactiveSelectors = ['button', 'a', 'input', 'select'];
    // 期待: 1 rule で button, a, input, select 全部含む selector list + 44px tap target
    const tapTargetRuleRe =
      /(?:button|a|input|select)\s*,\s*(?:button|a|input|select)\s*,\s*(?:button|a|input|select)\s*,\s*(?:button|a|input|select)\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px[^}]*\}/;
    const altRe =
      /(?:button|a|input|select)\s*,\s*(?:button|a|input|select)\s*,\s*(?:button|a|input|select)\s*,\s*(?:button|a|input|select)\s*\{[^}]*min-height:\s*44px[^}]*min-width:\s*44px[^}]*\}/;
    assert.ok(
      tapTargetRuleRe.test(html) || altRe.test(html),
      'expected: rule like `button, a, input, select { min-width: 44px; min-height: 44px; }`\n' +
        'found: no combined tap target rule covering 4 interactive elements\n' +
        'fix: add tap target enforcement rule per plan 26051405 §PR A3 line 169-172'
    );
    // sanity: 各 interactive selector が CSS に登場するか個別確認
    for (const sel of interactiveSelectors) {
      // sel 単体での CSS 出現 (rule 内 selector list の一員として)
      const selPresenceRe = new RegExp(`(^|[,\\s\\{])${sel}(\\s*,|\\s*\\{)`, 'm');
      assert.ok(
        selPresenceRe.test(html),
        `expected: '${sel}' selector present in shell-template.html CSS\n` +
          `found: no occurrence\n` +
          `fix: include '${sel}' in tap target rule`
      );
    }
  });

  test('BLUE-MOBILE-A3-4: hamburger menu button exists with aria-label + aria-expanded', async () => {
    const html = await readShell();
    // class="kioku-mobile-menu-button" を持つ <button> element
    const buttonRe = /<button[^>]*class=["'][^"']*kioku-mobile-menu-button[^"']*["'][^>]*>/i;
    assert.ok(
      buttonRe.test(html),
      'expected: <button class="kioku-mobile-menu-button" ...>\n' +
        'found: no hamburger menu button\n' +
        'fix: add hamburger button per plan 26051405 §PR A3 line 175-178'
    );
    // aria-label 属性
    const ariaLabelRe = /<button[^>]*class=["'][^"']*kioku-mobile-menu-button[^"']*["'][^>]*aria-label=/i;
    const ariaLabelAltRe = /<button[^>]*aria-label=[^>]*class=["'][^"']*kioku-mobile-menu-button/i;
    assert.ok(
      ariaLabelRe.test(html) || ariaLabelAltRe.test(html),
      'expected: aria-label attribute on hamburger button\n' +
        'found: button without aria-label\n' +
        'fix: add aria-label="Toggle menu" per plan 26051405 §PR A3'
    );
    // aria-expanded 属性 (初期 false)
    const ariaExpandedRe = /<button[^>]*class=["'][^"']*kioku-mobile-menu-button[^"']*["'][^>]*aria-expanded=/i;
    const ariaExpandedAltRe = /<button[^>]*aria-expanded=[^>]*class=["'][^"']*kioku-mobile-menu-button/i;
    assert.ok(
      ariaExpandedRe.test(html) || ariaExpandedAltRe.test(html),
      'expected: aria-expanded attribute on hamburger button\n' +
        'found: button without aria-expanded\n' +
        'fix: add aria-expanded="false" per plan 26051405 §PR A3'
    );
  });

  test('BLUE-MOBILE-A3-5: viz-template.html has .visualizer-graph-mobile-fallback section', async () => {
    const html = await readViz();
    // section element with class visualizer-graph-mobile-fallback OR
    // div with that class (plan is flexible: "section 配置のみ")
    const fallbackRe =
      /<(?:section|div)[^>]*class=["'][^"']*visualizer-graph-mobile-fallback[^"']*["'][^>]*>/i;
    assert.ok(
      fallbackRe.test(html),
      'expected: <section class="visualizer-graph-mobile-fallback"> or <div ...> in viz-template.html\n' +
        'found: no Mobile fallback section\n' +
        'fix: add fallback section per plan 26051405 §PR A3 line 190-200 (PR C3 で renderMobileFallback で content 注入)'
    );
    // CSS rule for the fallback class should exist (display: block on Mobile)
    const fallbackCssRe = /\.visualizer-graph-mobile-fallback\s*\{[^}]*display:\s*block[^}]*\}/;
    assert.ok(
      fallbackCssRe.test(html),
      'expected: .visualizer-graph-mobile-fallback { display: block; ... } CSS rule\n' +
        'found: no fallback CSS rule\n' +
        'fix: add fallback CSS rule inside @media (max-width: 767px) per plan 26051405 §PR A3'
    );
  });
});
