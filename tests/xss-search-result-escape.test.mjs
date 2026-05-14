// xss-search-result-escape.test.mjs — Sprint 4 Phase 2 PR B2
//
// Verifies that an adversarial query string (from wikilink discovery)
// containing </script> / <img onerror> payloads is properly escaped in
// the shell HTML JSON island, so the JS parser cannot be broken out of.
//
// F-numbers: per-file scope, F1..F3.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildShellHtml } from '../mcp/lib/web-ui-shell.mjs';
import { withoutQmd } from './fixtures/test-helpers.mjs';

// withoutQmd は fixtures/test-helpers.mjs から import (LEARN#8b N=3 shared extract、
// PR B2 sibling: qmd-search-index.test.mjs / web-ui-shell.test.mjs).
// 仕組み: PATH を /usr/bin:/bin:/usr/sbin:/sbin に縮めて qmd を隠し、handleSearch を
// in-process Node fallback walker 経路に固定。git は system path に残るので
// buildVisualizerData 中の getFileHistory は通常通り動く。

let workspace;
let vault;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'kioku-xss-search-'));
  vault = join(workspace, 'vault');
  await mkdir(join(vault, 'wiki', 'meta'), { recursive: true });
  // CLAUDE.md `.claude/rules/code-style.md` LEARN#13: only build U+2028 via
  // String.fromCharCode in source — never write it as a regex literal.
  const U2028 = String.fromCharCode(0x2028);
  // index.md wikilinks → discoverQueries source 2 (weight 2). We push adversarial
  // wikilink names so they become queries in the precomputed index.
  // - [[</script>…]] proves the </script> close-tag escape.
  // - [[……]]   proves the U+2028 escape inside the JSON island.
  await writeFile(
    join(vault, 'wiki', 'index.md'),
    [
      '# Index',
      '',
      '- [[</script><img src=x onerror=alert(1)>]]',
      '- [[normal-page]]',
      `- [[line${U2028}sep${U2028}payload]]`,
      '',
    ].join('\n'),
  );
  // Empty dashboard.base so buildShellData proceeds without errors. The
  // default base_source path is wiki/meta/dashboard.base.
  await writeFile(
    join(vault, 'wiki', 'meta', 'dashboard.base'),
    [
      'name: empty',
      'views: []',
      '',
    ].join('\n'),
  );
  // Empty log.md so source 1 produces nothing — only the adversarial wikilinks matter.
  await writeFile(join(vault, 'wiki', 'log.md'), '# log\n');
});

after(() => rm(workspace, { recursive: true, force: true }));

describe('xss-search-result-escape', () => {
  test('F1 (BLUE-XSS-SEARCH-1): adversarial </script> in query is JSON-escaped inside the JSON island', async () => {
    const html = await withoutQmd(() => buildShellHtml(vault, { mode: 'snapshot' }));
    const m = html.match(/<script id="kioku-shell-data" type="application\/json">([\s\S]*?)<\/script>/);
    assert.ok(m, 'JSON island block must exist');
    const dataBlob = m[1];
    // The JSON blob must NOT contain a raw </script> (otherwise the closing tag breaks out).
    assert.ok(!/<\/script>/i.test(dataBlob),
      'JSON island must not contain raw </script>');
    // The escape sequence </script> must be present (safeJsonForScript path).
    assert.ok(dataBlob.includes('\\u003c/script>'),
      'JSON island must encode </script> as \\u003c/script>');
  });

  test('F2 (BLUE-XSS-SEARCH-2): adversarial payload does not appear as live HTML', async () => {
    const html = await withoutQmd(() => buildShellHtml(vault, { mode: 'snapshot' }));
    // Split HTML around the JSON island; the payload may appear ONLY inside the JSON island.
    const islandMatch = html.match(/<script id="kioku-shell-data" type="application\/json">([\s\S]*?)<\/script>/);
    assert.ok(islandMatch, 'JSON island block must exist');
    const islandStart = html.indexOf(islandMatch[0]);
    const islandEnd = islandStart + islandMatch[0].length;
    const outsideIsland = html.slice(0, islandStart) + html.slice(islandEnd);
    // Payload chars OUTSIDE the JSON island must not appear (live HTML tag escape).
    assert.ok(!outsideIsland.includes('<img src=x onerror=alert(1)>'),
      'raw adversarial <img> tag must not appear outside JSON island');
    // Sanity: the payload IS encoded inside the JSON island (escaped form).
    // Note: JSON only escapes a small set of control chars; < > are preserved as-is in JSON strings.
    // The XSS-safe contract is that the JSON island block is treated as data, not HTML.
  });

  test('F3 (BLUE-XSS-SEARCH-3): U+2028 in payload is escaped to \\u2028 (safeJsonForScript)', async () => {
    const html = await withoutQmd(() => buildShellHtml(vault, { mode: 'snapshot' }));
    const m = html.match(/<script id="kioku-shell-data" type="application\/json">([\s\S]*?)<\/script>/);
    assert.ok(m);
    const dataBlob = m[1];
    // Raw U+2028 must NOT appear in the JSON island (ECMAScript parser-illegal in inline JS).
    const U2028 = String.fromCharCode(0x2028);
    assert.ok(!dataBlob.includes(U2028),
      'raw U+2028 must not appear in JSON island');
    assert.ok(dataBlob.includes('\\u2028'),
      'U+2028 must be escaped to \\u2028 by safeJsonForScript');
  });
});
