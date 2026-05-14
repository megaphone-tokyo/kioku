// tests/mobile-viz-simplified.test.mjs — Sprint 4 Phase 3 PR C3
//   Visualizer β Mobile simplified view (text page list、innerHTML 不使用)
//
// plan 26051405 §「Visualizer β Mobile simplified view」 (L343-372) canonical
// impl spec を test に codify。viz-template.html 内 renderMobileFallback の
// shape + safe-DOM contract を assert する。
//
// Test prefixes (BLUE-MOBILE-C3-* namespace、LEARN#8a per-file scope = F1 から):
//   - BLUE-MOBILE-C3-1 : renderMobileFallback 関数が viz-template.html に存在
//   - BLUE-MOBILE-C3-2 : renderMobileFallback は textContent + createElement のみ使用
//                        (innerHTML / outerHTML 代入 / legacy doc-write は 0 hit)
//   - BLUE-MOBILE-C3-3 : Mobile breakpoint (max-width: 767px) で
//                        renderMobileFallback がデータと共に呼ばれる分岐が存在、
//                        かつ mockMobileViewport helper が同 query で match する
//
// 設計方針:
//   - Node 18+ stdlib のみ (jsdom 不要、file content の string check + mockMobileViewport)
//   - LEARN#13: regex literal の U+2028/2029/200B/FEFF 禁止、本 file は ASCII のみ
//   - LEARN#14: import 経由で test framework が load → ESM entry gate 不要
//   - LEARN#5 cross-suite: renderMobileFallback / mockMobileViewport を別 test
//     file (performance-budget) でも参照するため、helper 名一致を維持

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mockMobileViewport } from './fixtures/test-helpers.mjs';

const moduleFilePath = fileURLToPath(import.meta.url);
const moduleDir = dirname(moduleFilePath);
const CB_ROOT = resolve(moduleDir, '..');

const VIZ_TEMPLATE_PATH = join(CB_ROOT, 'mcp', 'templates', 'viz-template.html');

async function readViz() {
  return readFile(VIZ_TEMPLATE_PATH, 'utf-8');
}

describe('Sprint 4 Phase 3 PR C3 — Visualizer β Mobile simplified view', () => {
  test('BLUE-MOBILE-C3-1: renderMobileFallback function exists in viz-template.html', async () => {
    const html = await readViz();
    // 関数定義: `function renderMobileFallback(...)` のいずれか
    const fnDeclRe = /function\s+renderMobileFallback\s*\(/;
    assert.ok(
      fnDeclRe.test(html),
      'expected: `function renderMobileFallback(...)` defined in viz-template.html <script>\n' +
        'found: no renderMobileFallback function declaration\n' +
        'fix: add renderMobileFallback per plan 26051405 §Visualizer β Mobile simplified view'
    );
    // 関数本体で .visualizer-graph-mobile-fallback container を取得する handle
    const containerRe = /querySelector\s*\(\s*['"]\s*\.visualizer-graph-mobile-fallback\s*['"]\s*\)/;
    assert.ok(
      containerRe.test(html),
      'expected: querySelector(".visualizer-graph-mobile-fallback") inside renderMobileFallback\n' +
        'found: no container lookup matching plan canonical pattern\n' +
        'fix: query .visualizer-graph-mobile-fallback per plan 26051405 line 348'
    );
  });

  test('BLUE-MOBILE-C3-2: renderMobileFallback uses textContent + createElement only (no innerHTML / outerHTML / legacy doc-write)', async () => {
    const html = await readViz();
    // renderMobileFallback 関数本体を抽出 (関数開始から最初の終端 `}` までを greedy 取得)。
    // viz-template.html 全体に対する self-grep は branch-wide self-grep (Path C+β
    // boundary) で別途実施するため、本 test は関数本体 scope に絞った契約確認。
    const fnBodyMatch = html.match(/function\s+renderMobileFallback\s*\([^)]*\)\s*\{([\s\S]*?)\n\s{0,4}\}\n/);
    assert.ok(
      fnBodyMatch,
      'expected: extractable renderMobileFallback function body\n' +
        'found: no balanced body match (function may have nested unbalanced braces)\n' +
        'fix: ensure renderMobileFallback ends with a top-level closing brace on its own line'
    );
    const body = fnBodyMatch[1];

    // textContent 経由の書き込み 必須 (intro paragraph + a.textContent)
    const textContentRe = /\.textContent\s*=/;
    assert.ok(
      textContentRe.test(body),
      'expected: textContent assignment(s) inside renderMobileFallback\n' +
        'found: no textContent usage\n' +
        'fix: assign user-visible strings via .textContent per safe DOM contract'
    );
    // createElement 経由の要素生成 必須 (ul / li / a / p のいずれか)
    const createElementRe = /document\.createElement\s*\(/;
    assert.ok(
      createElementRe.test(body),
      'expected: document.createElement(...) inside renderMobileFallback\n' +
        'found: no createElement usage\n' +
        'fix: build DOM via createElement per plan 26051405 line 355-364'
    );
    // 禁止 API: innerHTML / outerHTML 代入 / legacy doc-write は本関数で 0 hit
    const innerHTMLAssignRe = /\.innerHTML\s*=/;
    assert.ok(
      !innerHTMLAssignRe.test(body),
      'expected: 0 innerHTML assignment inside renderMobileFallback\n' +
        'found: innerHTML assignment present (XSS injection surface)\n' +
        'fix: replace with textContent + createElement per Path C+β boundary'
    );
    const outerHTMLAssignRe = /\.outerHTML\s*=/;
    assert.ok(
      !outerHTMLAssignRe.test(body),
      'expected: 0 outerHTML assignment inside renderMobileFallback\n' +
        'found: outerHTML assignment present (XSS injection surface)\n' +
        'fix: replace with createElement + appendChild per Path C+β boundary'
    );
    // legacy doc-write API は分割書きでも禁止 (document . write の任意 whitespace)
    const docWriteRe = /document\s*\.\s*write\s*\(/;
    assert.ok(
      !docWriteRe.test(body),
      'expected: 0 legacy doc-write API call inside renderMobileFallback\n' +
        'found: legacy doc-write API call present (deprecated + XSS surface)\n' +
        'fix: remove legacy API per Path C+β boundary forbidden keyword list'
    );
  });

  test('BLUE-MOBILE-C3-3: Mobile breakpoint branch invokes renderMobileFallback, mockMobileViewport matches same query', async () => {
    const html = await readViz();
    // 起動分岐: window.matchMedia('(max-width: 767px)') を条件にして renderMobileFallback(data) を call。
    // selector / call の隣接は許容 (改行 + 中間処理あり) のため 2 段で assert。
    const mqDetectRe = /window\.matchMedia\s*\(\s*['"]\(\s*max-width:\s*767px\s*\)['"]/;
    assert.ok(
      mqDetectRe.test(html),
      'expected: window.matchMedia("(max-width: 767px)") detection branch\n' +
        'found: no Mobile breakpoint detection matching plan canonical pattern\n' +
        'fix: add matchMedia branch per plan 26051405 line 368'
    );
    const invokeRe = /renderMobileFallback\s*\(\s*data\s*\)/;
    assert.ok(
      invokeRe.test(html),
      'expected: renderMobileFallback(data) invocation inside Mobile breakpoint branch\n' +
        'found: function defined but never called with embedded vault data\n' +
        'fix: call renderMobileFallback(data) inside if (mobileMQ.matches) per plan 26051405 line 370'
    );

    // mockMobileViewport が同じ breakpoint query で `.matches === true` を返すことを verify
    // (test infrastructure の意図一致 = 「test 上 Mobile を再現したら production と同条件で発火」)
    const restore = mockMobileViewport(375);
    try {
      const mq = globalThis.window.matchMedia('(max-width: 767px)');
      assert.equal(
        mq.matches,
        true,
        'expected: mockMobileViewport(375) → matchMedia("(max-width: 767px)").matches === true\n' +
          'found: matches=' + mq.matches + '\n' +
          'fix: ensure mockMobileViewport parses (max-width: Npx) and compares width <= N'
      );
      // 反例側: tablet 以上 (width=1024) では非 match (Mobile 専用化が tablet を汚染しないこと)
      restore();
      const restoreTablet = mockMobileViewport(1024);
      try {
        const mqTablet = globalThis.window.matchMedia('(max-width: 767px)');
        assert.equal(
          mqTablet.matches,
          false,
          'expected: mockMobileViewport(1024) → matchMedia("(max-width: 767px)").matches === false\n' +
            'found: matches=' + mqTablet.matches + '\n' +
            'fix: ensure mockMobileViewport does NOT match when width exceeds breakpoint'
        );
      } finally {
        restoreTablet();
      }
    } finally {
      // 二重 restore は idempotent (test-helpers.mjs の restore 関数仕様)
      restore();
    }
  });
});
