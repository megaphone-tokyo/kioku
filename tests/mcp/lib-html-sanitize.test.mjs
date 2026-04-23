import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_DIR = join(__dirname, '..', '..', 'mcp');
const { sanitizeHtml } = await import(join(MCP_DIR, 'lib', 'html-sanitize.mjs'));

describe('sanitizeHtml', () => {
  test('strips <script> tags', () => {
    const out = sanitizeHtml('<p>hi</p><script>alert(1)</script>');
    assert.ok(!/script/i.test(out), `script tag leaked: ${out}`);
    assert.match(out, /hi/);
  });

  test('strips <iframe> <object> <embed> tags', () => {
    const out = sanitizeHtml('<iframe src="x"></iframe><object></object><embed />');
    assert.ok(!/iframe|object|embed/i.test(out));
  });

  test('removes on* inline event handlers', () => {
    const out = sanitizeHtml('<a href="/" onclick="alert(1)" onmouseover="x()">link</a>');
    assert.ok(!/onclick|onmouseover/i.test(out));
    assert.match(out, /href/);
  });

  test('removes javascript: URLs in href/src', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">x</a><img src="javascript:void(0)">');
    assert.ok(!/javascript:/i.test(out));
  });

  test('passes through plain content-bearing tags', () => {
    const out = sanitizeHtml('<article><h1>Title</h1><p>body</p></article>');
    assert.match(out, /<h1>Title<\/h1>/);
    assert.match(out, /<p>body<\/p>/);
  });

  test('strips file:// URLs in href/src (VULN-E001 defense in depth)', () => {
    const out = sanitizeHtml('<a href="file:///etc/passwd">x</a><img src="FILE:///tmp/y"><iframe src="file:///z"></iframe>');
    assert.ok(!/file:\/\//i.test(out), `file:// URL leaked: ${out}`);
  });

  test('JSDOM does not fetch external resources (no network)', () => {
    const html = '<img src="http://example.invalid/track.png"><iframe src="http://evil/"></iframe>';
    const t0 = Date.now();
    const out = sanitizeHtml(html);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1000, `sanitizer took ${elapsed}ms — suggests network fetch`);
    assert.ok(!/iframe/i.test(out));
  });

  // GAP-D005 (v0.5.0 pre-release hotfix, 2026-04-23): meta/base/link を DANGEROUS_TAGS に追加。
  // EPUB 章 XHTML には <meta http-equiv="refresh" content="0;url=...">,
  // <base href="javascript:...">, <link rel="stylesheet"> が合法的に含まれ得る。
  // 現状 Markdown 経路では turndown が drop するが、sanitizedJsdom を Document として消費する
  // 将来経路 (readability 再 parse 等) に備えた defense-in-depth。
  test('strips <meta> tags (GAP-D005: EPUB meta refresh / base href / link stylesheet 防御)', () => {
    const out = sanitizeHtml(
      '<p>hi</p><meta http-equiv="refresh" content="0;url=https://evil">',
    );
    assert.ok(!/<meta/i.test(out), `meta tag leaked: ${out}`);
    assert.match(out, /hi/);
  });

  test('strips <base> tags (GAP-D005: base href redirect 防御)', () => {
    const out = sanitizeHtml('<base href="javascript:alert(1)"><p>body</p>');
    assert.ok(!/<base/i.test(out), `base tag leaked: ${out}`);
    assert.match(out, /body/);
  });

  test('strips <link> tags (GAP-D005: link rel stylesheet / preload 防御)', () => {
    const out = sanitizeHtml(
      '<link rel="stylesheet" href="https://evil/a.css"><p>body</p>',
    );
    assert.ok(!/<link/i.test(out), `link tag leaked: ${out}`);
    assert.match(out, /body/);
  });
});
