// tests/mobile-tier2-deeplink.test.mjs — Sprint 4 Phase 3 PR B3 Tier 2 Mobile deep-link
//
// Targets: shell-template.html に追加された openTier2Search function +
//          claude:// URI scheme attempt + 1.5s timeout で claude.ai/new web fallback +
//          CSP navigate-to policy を機械的に verify。
//          plan 26051405 §「PR B3」L238-329 の canonical impl spec を test に codify。
//
// Test prefixes (BLUE-MOBILE-B3-* namespace, per LEARN#8a per-file scope = F1 から):
//   - BLUE-MOBILE-B3-1 : openTier2Search function + Mobile 判定 (matchMedia) +
//                        claude:// URI scheme prefix が shell-template.html に存在
//   - BLUE-MOBILE-B3-2 : claude:// → 1.5s timeout → web fallback の構造
//                        (setTimeout 1500 + visibilitychange listener + clearTimeout)
//   - BLUE-MOBILE-B3-3 : claude.ai/new web fallback URL + encodeURIComponent escape
//                        (user input は escape mandatory、plan §「セキュリティ contract」L319)
//   - BLUE-MOBILE-B3-4 : desktop path 不変 (既存 narrative 維持) + CSP navigate-to policy
//                        (claude: + https://claude.ai whitelist)
//
// 設計方針:
//   - Node 18+ stdlib のみ (外部依存なし、jsdom 不要)
//   - file content の string check (regex match) で OK、actual Mobile rendering test は
//     PR C3 で test-helpers.mjs に mockMobileViewport 追加後
//   - error message は「expected: X / found: Y / fix: Z」形式
//   - regex は whitespace tolerance (\s*) を持たせ minor formatting drift に耐性
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

// Extract the openTier2Search function body for scoped assertions.
// 戻り値: function 本体 string (見つからなければ '')
function extractOpenTier2SearchBody(html) {
  // function openTier2Search(query) { ... } を抜き出す。
  // brace balancing は html 構造上 simple な範囲で済むので regex で sufficient:
  // 最初の `function openTier2Search` から、最も近い `function copyMcpToolPrompt` 直前まで取る
  // (本 PR B3 の impl 上は両者が連続定義されている前提、plan 26051405 §「PR B3」L240-274)。
  const start = html.indexOf('function openTier2Search');
  if (start < 0) return '';
  const next = html.indexOf('function copyMcpToolPrompt', start);
  if (next < 0) return html.slice(start);
  return html.slice(start, next);
}

// Extract the renderSearch function body for desktop-path regression assertions.
function extractRenderSearchBody(html) {
  const start = html.indexOf('function renderSearch');
  if (start < 0) return '';
  // renderSearch の終端は次の top-level function 定義 (function applyFilter は内部 nested なので、
  // 次の top-level として function showTab / function renderRest 等が来るのを期待するが、
  // safe-side: 5000 char window で十分 desktop description text を含む)。
  return html.slice(start, start + 5000);
}

describe('Sprint 4 Phase 3 PR B3 — Tier 2 Mobile deep-link', () => {
  test('BLUE-MOBILE-B3-1: openTier2Search function + matchMedia + claude:// URI scheme exist', async () => {
    const html = await readShell();

    // 検証 1: function openTier2Search definition が存在
    const fnRe = /function\s+openTier2Search\s*\(/;
    assert.ok(
      fnRe.test(html),
      'expected: function openTier2Search(query) { ... } definition in shell-template.html\n' +
        'found: no openTier2Search function definition\n' +
        'fix: add openTier2Search per plan 26051405 §PR B3 L240-274'
    );

    // 検証 2: window.matchMedia('(max-width: 767px)') 呼び出しが function 本体に存在
    const body = extractOpenTier2SearchBody(html);
    assert.ok(
      body.length > 0,
      'expected: openTier2Search function body extractable\n' +
        'found: function body empty (extraction failed)\n' +
        'fix: ensure openTier2Search and copyMcpToolPrompt are co-located per plan 26051405'
    );
    const matchMediaRe = /window\.matchMedia\s*\(\s*['"]\(max-width:\s*767px\)['"]\s*\)/;
    assert.ok(
      matchMediaRe.test(body),
      'expected: window.matchMedia(\'(max-width: 767px)\') call inside openTier2Search\n' +
        'found: no matchMedia Mobile detection call\n' +
        'fix: add Mobile detection via matchMedia per plan 26051405 §PR B3 L240-274'
    );

    // 検証 3: claude://chat?prompt= URI scheme prefix が JS string literal として存在
    const claudeSchemeRe = /['"]claude:\/\/chat\?prompt=/;
    assert.ok(
      claudeSchemeRe.test(body),
      'expected: \'claude://chat?prompt=...\' URI scheme string literal in openTier2Search\n' +
        'found: no claude:// URI scheme prefix\n' +
        'fix: add claude://chat?prompt= deep-link per plan 26051405 §PR B3 L240-274'
    );
  });

  test('BLUE-MOBILE-B3-2: claude:// -> 1.5s timeout -> web fallback structure', async () => {
    const html = await readShell();
    const body = extractOpenTier2SearchBody(html);
    assert.ok(body.length > 0, 'openTier2Search body must be extractable');

    // 検証 1: setTimeout(..., 1500) が openTier2Search 内に存在 (1.5s timeout literal)
    const setTimeoutRe = /setTimeout\s*\([\s\S]*?,\s*1500\s*\)/;
    assert.ok(
      setTimeoutRe.test(body),
      'expected: setTimeout(..., 1500) inside openTier2Search (1.5s web fallback timer)\n' +
        'found: no 1500ms setTimeout\n' +
        'fix: add setTimeout(() => window.location.href = claudeWebUrl, 1500) per plan 26051405 §PR B3 L240-274'
    );

    // 検証 2: visibilitychange listener が存在 (app 起動成功時 timeout cancel)
    const visChangeRe = /['"]visibilitychange['"]/;
    assert.ok(
      visChangeRe.test(body),
      'expected: \'visibilitychange\' event listener in openTier2Search\n' +
        'found: no visibilitychange listener\n' +
        'fix: add document.addEventListener(\'visibilitychange\', ...) to cancel timeout when claude:// app launches (plan 26051405 §PR B3 L260-268)'
    );

    // 検証 3: clearTimeout 呼び出しが存在
    const clearTimeoutRe = /clearTimeout\s*\(/;
    assert.ok(
      clearTimeoutRe.test(body),
      'expected: clearTimeout(timeoutId) call inside openTier2Search\n' +
        'found: no clearTimeout call\n' +
        'fix: add clearTimeout(timeoutId) inside visibilitychange handler per plan 26051405 §PR B3 L260-268'
    );
  });

  test('BLUE-MOBILE-B3-3: claude.ai/new web fallback URL + encodeURIComponent escape', async () => {
    const html = await readShell();
    const body = extractOpenTier2SearchBody(html);
    assert.ok(body.length > 0, 'openTier2Search body must be extractable');

    // 検証 1: https://claude.ai/new?q= URL prefix が JS string literal として存在
    const webFallbackRe = /['"]https:\/\/claude\.ai\/new\?q=/;
    assert.ok(
      webFallbackRe.test(body),
      'expected: \'https://claude.ai/new?q=...\' web fallback URL string literal in openTier2Search\n' +
        'found: no claude.ai/new fallback URL\n' +
        'fix: add web fallback URL per plan 26051405 §PR B3 L240-274'
    );

    // 検証 2: encodeURIComponent 呼び出しが openTier2Search 内に存在
    // (user input escape mandatory、plan §「セキュリティ contract」L319)
    const encodeRe = /encodeURIComponent\s*\(/;
    assert.ok(
      encodeRe.test(body),
      'expected: encodeURIComponent(query) call inside openTier2Search\n' +
        'found: no encodeURIComponent call\n' +
        'fix: escape user input via encodeURIComponent per plan 26051405 §PR B3 セキュリティ contract L319 (XSS / URL injection 防止)'
    );
  });

  test('BLUE-MOBILE-B3-4: desktop path narrative preserved + CSP navigate-to policy', async () => {
    const html = await readShell();
    const renderSearchBody = extractRenderSearchBody(html);
    assert.ok(
      renderSearchBody.length > 0,
      'expected: renderSearch function body extractable\n' +
        'found: function body empty (extraction failed)\n' +
        'fix: ensure renderSearch is defined in shell-template.html'
    );

    // 検証 1: 既存 description text "Claude conversation で" が renderSearch 内に維持
    // (desktop 不変 regression guard)
    assert.ok(
      renderSearchBody.indexOf('Claude conversation で') >= 0,
      'expected: existing description text "Claude conversation で" preserved in renderSearch\n' +
        'found: description text missing (PR B3 should not regress desktop narrative)\n' +
        'fix: keep existing deepDive textContent intact per plan 26051405 §PR B3 (desktop path 不変)'
    );

    // 検証 2: 既存 code element textContent `kioku_search` が renderSearch 内に維持
    const kiokuSearchRe = /['"]kioku_search['"]/;
    assert.ok(
      kiokuSearchRe.test(renderSearchBody),
      'expected: \'kioku_search\' string literal preserved in renderSearch (MCP tool name reference)\n' +
        'found: kioku_search reference missing\n' +
        'fix: keep existing ddCode.textContent = \'kioku_search\' intact per plan 26051405 §PR B3'
    );

    // 検証 3: <meta http-equiv="Content-Security-Policy" ...> with navigate-to directive 存在
    // 注意: content 属性 (double-quoted) 内に CSP keyword 'self' などの single quote が含まれるため、
    //       content 値 capture は [^"] (single quote 許容) で、quote は double-quote 限定で照合する。
    const cspRe =
      /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*navigate-to[^"]*"\s*\/?>/i;
    assert.ok(
      cspRe.test(html),
      'expected: <meta http-equiv="Content-Security-Policy" content="...navigate-to..."> in shell-template.html <head>\n' +
        'found: no CSP meta tag with navigate-to directive\n' +
        'fix: add CSP navigate-to policy per plan 26051405 §PR B3 セキュリティ contract L314-318'
    );

    // 検証 4: navigate-to directive content に `claude:` scheme-source 含む
    const cspContentMatch = html.match(
      /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/i
    );
    assert.ok(
      cspContentMatch && cspContentMatch[1],
      'expected: CSP meta tag content attribute extractable\n' +
        'found: CSP meta tag without content attribute\n' +
        'fix: ensure <meta http-equiv="Content-Security-Policy" content="..."> has content per plan 26051405'
    );
    const cspContent = cspContentMatch[1];
    assert.ok(
      /\bclaude:/.test(cspContent),
      'expected: "claude:" scheme-source in CSP navigate-to directive content\n' +
        'found: CSP content = "' +
        cspContent +
        '"\n' +
        'fix: include claude: scheme-source per plan 26051405 §PR B3 セキュリティ contract L314-318'
    );

    // 検証 5: navigate-to directive content に `https://claude.ai` host-source 含む
    assert.ok(
      cspContent.indexOf('https://claude.ai') >= 0,
      'expected: "https://claude.ai" host-source in CSP navigate-to directive content\n' +
        'found: CSP content = "' +
        cspContent +
        '"\n' +
        'fix: include https://claude.ai host-source per plan 26051405 §PR B3 セキュリティ contract L314-318'
    );
  });
});
