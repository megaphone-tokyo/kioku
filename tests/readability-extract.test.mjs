import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractArticle } from '../mcp/lib/readability-extract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, 'fixtures/html');

describe('readability-extract', () => {
  test('UE1 normal article extracts title + body', async () => {
    const html = await readFile(join(FIX, 'article-normal.html'), 'utf8');
    const r = extractArticle(html, 'https://example.com/article');
    assert.equal(r.title, 'Attention Is All You Need');
    assert.match(r.content, /Transformer/);
    assert.match(r.content, /attention mechanisms/);
    assert.equal(r.byline, 'Ashish Vaswani, Noam Shazeer, et al.');
    assert.equal(r.siteName, 'arxiv.org');
    assert.equal(r.publishedTime, '2017-06-12T00:00:00Z');
    assert.ok(r.textContent.length > 300, 'textContent > 300 chars');
    assert.equal(r.needsFallback, false);
  });

  test('UE2 sparse article → needsFallback=true', async () => {
    const html = await readFile(join(FIX, 'article-sparse.html'), 'utf8');
    const r = extractArticle(html, 'https://example.com/sparse');
    assert.equal(r.needsFallback, true);
  });

  test('UE3 script/style/noscript stripped', async () => {
    const html = await readFile(join(FIX, 'article-spa-shell.html'), 'utf8');
    const r = extractArticle(html, 'https://example.com/spa');
    assert.ok(!/\<script\>/i.test(r.content));
    assert.equal(r.needsFallback, true);
  });

  test('UE4 published_time in frontmatter output', async () => {
    const html = await readFile(join(FIX, 'article-normal.html'), 'utf8');
    const r = extractArticle(html, 'https://example.com/');
    assert.equal(r.publishedTime, '2017-06-12T00:00:00Z');
  });

  test('UE5 og:image extracted', async () => {
    // normal fixture doesn't have og:image; add inline HTML
    const html = '<html><head><title>T</title><meta property="og:image" content="https://cdn.example.com/hero.png"></head><body><article><h1>T</h1><p>' + 'x'.repeat(500) + '</p></article></body></html>';
    const r = extractArticle(html, 'https://example.com/');
    assert.equal(r.ogImage, 'https://cdn.example.com/hero.png');
  });
});
