import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown } from '../mcp/lib/html-to-markdown.mjs';

describe('html-to-markdown', () => {
  test('UT1 table → GFM table', () => {
    const html = '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>';
    const md = htmlToMarkdown(html);
    assert.match(md, /\|\s*A\s*\|\s*B\s*\|/);
    assert.match(md, /\|\s*---/);
    assert.match(md, /\|\s*1\s*\|\s*2\s*\|/);
  });

  test('UT2 code block with lang → fenced', () => {
    const html = '<pre><code class="language-js">function hello() {}</code></pre>';
    const md = htmlToMarkdown(html);
    assert.match(md, /```js/);
    assert.match(md, /function hello/);
  });

  test('UT3 anchor preserved as markdown link', () => {
    const html = '<p>See <a href="https://example.com/docs">docs</a>.</p>';
    const md = htmlToMarkdown(html);
    assert.match(md, /\[docs\]\(https:\/\/example\.com\/docs\)/);
  });

  test('script/style tags removed before conversion', () => {
    const html = '<script>alert(1)</script><p>body</p>';
    const md = htmlToMarkdown(html);
    assert.ok(!md.includes('alert'));
    assert.match(md, /body/);
  });
});
