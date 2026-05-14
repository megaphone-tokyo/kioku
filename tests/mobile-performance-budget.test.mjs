// tests/mobile-performance-budget.test.mjs — Sprint 4 Phase 3 PR C3
//   Performance budget + VIZ-T14 bit-equal contract (production code 0 line 変更)
//
// plan 26051405 §「Performance budget 削減」 (L374-380) + §「VIZ-T14 bit-equal
// contract と Phase 3 互換性」 (L425-430) canonical impl spec を test に codify。
//
// Test prefixes (BLUE-MOBILE-C3-* namespace、LEARN#8a per-file scope = F1 から、
// 続番 C3-4..5 は plan の test ID 体系に対応):
//   - BLUE-MOBILE-C3-4 : shell-template.html + viz-template.html が performance
//                        budget (300KB target) を満たす
//   - BLUE-MOBILE-C3-5 : VIZ-T14 bit-equal contract 物理保証 = Mobile 系追加が
//                        production code (visualizer.mjs / web-ui-shell.mjs)
//                        に 1 行も染み出していない (mockMobileViewport /
//                        renderMobileFallback / window.matchMedia いずれも
//                        production code に存在しない)
//
// 設計方針:
//   - Node 18+ stdlib のみ (fs/promises + path)
//   - LEARN#5 cross-suite: tests/fixtures/test-helpers.mjs の mockMobileViewport
//     を import せず name-only string check で済ます (= helper 移動・rename にも
//     production code "境界外" 性質が壊れないこと自体を pinning)
//   - LEARN#13: regex literal は ASCII のみ、U+2028/2029/200B/FEFF 不使用
//
// note: PR A3 段階で shell HTML 30KB / viz HTML 73KB に着地済、300KB target に
// 対して大幅 headroom。本 budget test は「将来の minification 撤回 / 大型機能で
// budget を超過しないこと」の regression guard として機能する。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const moduleFilePath = fileURLToPath(import.meta.url);
const moduleDir = dirname(moduleFilePath);
const CB_ROOT = resolve(moduleDir, '..');

const PATHS = {
  shellTemplate: join(CB_ROOT, 'mcp', 'templates', 'shell-template.html'),
  vizTemplate: join(CB_ROOT, 'mcp', 'templates', 'viz-template.html'),
  visualizerMjs: join(CB_ROOT, 'mcp', 'tools', 'visualizer.mjs'),
  webUiShellMjs: join(CB_ROOT, 'mcp', 'lib', 'web-ui-shell.mjs'),
};

// plan 26051405 §Performance budget canonical target (461KB → 300KB)
const BUDGET_BYTES = 300 * 1024; // 307200

describe('Sprint 4 Phase 3 PR C3 — Performance budget + VIZ-T14 bit-equal contract', () => {
  test('BLUE-MOBILE-C3-4: shell + viz templates are within 300KB performance budget', async () => {
    const shellStat = await stat(PATHS.shellTemplate);
    const vizStat = await stat(PATHS.vizTemplate);

    assert.ok(
      shellStat.size < BUDGET_BYTES,
      'expected: shell-template.html size < ' + BUDGET_BYTES + ' bytes (300KB target)\n' +
        'found: ' + shellStat.size + ' bytes (' + (shellStat.size / 1024).toFixed(1) + 'KB)\n' +
        'fix: trim shell-template.html per plan 26051405 §Performance budget 削減'
    );
    assert.ok(
      vizStat.size < BUDGET_BYTES,
      'expected: viz-template.html size < ' + BUDGET_BYTES + ' bytes (300KB target)\n' +
        'found: ' + vizStat.size + ' bytes (' + (vizStat.size / 1024).toFixed(1) + 'KB)\n' +
        'fix: trim viz-template.html per plan 26051405 §Performance budget 削減'
    );

    // 合算 budget も明示 (両 HTML が同 wiki view で隣接 load される運用想定)
    const combined = shellStat.size + vizStat.size;
    assert.ok(
      combined < BUDGET_BYTES * 2,
      'expected: shell + viz combined size < ' + (BUDGET_BYTES * 2) + ' bytes (2x budget)\n' +
        'found: ' + combined + ' bytes (' + (combined / 1024).toFixed(1) + 'KB)\n' +
        'fix: investigate if both templates grew jointly'
    );
  });

  test('BLUE-MOBILE-C3-5: VIZ-T14 bit-equal contract preserved = Mobile additions did not leak into production code (visualizer.mjs / web-ui-shell.mjs)', async () => {
    const vizMjs = await readFile(PATHS.visualizerMjs, 'utf-8');
    const shellMjs = await readFile(PATHS.webUiShellMjs, 'utf-8');

    // PR C3 で導入した Mobile 専用 identifier 群が production code に染み出して
    // いないことを shape-level で pinning。これにより
    //   - VIZ-T14 (tests/mcp/visualizer.test.mjs L422) の "mode unset と
    //     mode='snapshot' で bit-equal HTML" 契約が物理的に保証される
    //   - 将来 Mobile 機能を template から production code に押し戻す refactor が
    //     入った時、本 test が失敗 → VIZ-T14 baseline 更新 / 影響評価を促す
    //
    // production code に対する forbidden keyword list (PR C3 scope の Mobile 系):
    const FORBIDDEN_IN_PRODUCTION = [
      'renderMobileFallback',         // viz-template 専用関数
      'mockMobileViewport',           // test helper 専用
      'visualizer-graph-mobile-fallback', // CSS class、template scope のみ
      'kioku-mobile-menu-button',     // shell-template の hamburger button class (PR A3)
    ];

    for (const keyword of FORBIDDEN_IN_PRODUCTION) {
      assert.ok(
        !vizMjs.includes(keyword),
        'expected: 0 occurrence of "' + keyword + '" in mcp/tools/visualizer.mjs\n' +
          'found: keyword leaked into production code\n' +
          'fix: keep Mobile logic in templates only per VIZ-T14 bit-equal contract\n' +
          '     (plan 26051405 §VIZ-T14 bit-equal contract と Phase 3 互換性 line 430)'
      );
      assert.ok(
        !shellMjs.includes(keyword),
        'expected: 0 occurrence of "' + keyword + '" in mcp/lib/web-ui-shell.mjs\n' +
          'found: keyword leaked into production code\n' +
          'fix: keep Mobile logic in templates only per VIZ-T14 bit-equal contract'
      );
    }

    // window.matchMedia は production code (Node 上で eval される code path) では
    // 意味が無い (window 不在の Node runtime)。template に閉じていることを別途確認。
    assert.ok(
      !vizMjs.includes('window.matchMedia'),
      'expected: 0 occurrence of "window.matchMedia" in mcp/tools/visualizer.mjs\n' +
        'found: browser-only API present in Node-side module\n' +
        'fix: matchMedia is browser-only, keep it in viz-template.html <script>'
    );
    assert.ok(
      !shellMjs.includes('window.matchMedia'),
      'expected: 0 occurrence of "window.matchMedia" in mcp/lib/web-ui-shell.mjs\n' +
        'found: browser-only API present in Node-side module\n' +
        'fix: matchMedia is browser-only, keep it in shell-template.html <script>'
    );
  });
});
