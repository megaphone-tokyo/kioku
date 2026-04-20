import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { urlToFilename } from '../mcp/lib/url-filename.mjs';

describe('urlToFilename', () => {
  test('UN1: arxiv URL', () => {
    assert.equal(urlToFilename('https://arxiv.org/abs/1706.03762'), 'arxiv.org-abs-1706.03762.md');
  });
  test('UN1b: blog with .html suffix strips', () => {
    assert.equal(urlToFilename('https://blog.example.com/2024/my-post.html'), 'blog.example.com-2024-my-post.md');
  });
  test('UN2: long URL truncates with sha8', () => {
    const long = 'https://example.com/' + 'a'.repeat(200);
    const fn = urlToFilename(long);
    assert.ok(fn.length < 100, `filename too long: ${fn.length}`);
    assert.match(fn, /-[0-9a-f]{8}\.md$/, 'sha8 suffix appended');
    assert.ok(fn.startsWith('example.com-'));
  });
  test('UN3: query-only URL → root + sha8', () => {
    const fn = urlToFilename('https://example.com/?q=foo&p=bar');
    assert.match(fn, /^example\.com-root(-[0-9a-f]{8})?\.md$/);
  });
  test('UN3b: plain domain root', () => {
    assert.equal(urlToFilename('https://example.com/'), 'example.com-root.md');
  });
  test('UN4: host normalized to lowercase', () => {
    assert.equal(urlToFilename('https://Example.COM/Foo'), 'example.com-Foo.md');
  });
  test('special chars replaced by hyphen', () => {
    assert.equal(urlToFilename('https://example.com/path/with spaces/and!special@chars'),
                 'example.com-path-with-spaces-and-special-chars.md');
  });
  test('consecutive hyphens collapsed', () => {
    assert.equal(urlToFilename('https://example.com/a//b//c'), 'example.com-a-b-c.md');
  });
});
