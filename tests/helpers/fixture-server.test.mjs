import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer } from './fixture-server.mjs';

describe('fixture-server', () => {
  let server;
  before(async () => { server = await startFixtureServer(); });
  after(() => server.close());

  test('serves article-normal.html', async () => {
    const res = await fetch(`${server.url}/article-normal.html`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('text/html'));
    const text = await res.text();
    assert.match(text, /<h1>Attention Is All You Need<\/h1>/);
  });

  test('serves robots.txt from any path', async () => {
    // /robots.txt is special — map to robots-allow.txt by default
    const res = await fetch(`${server.url}/robots.txt`);
    assert.equal(res.status, 200);
  });

  test('supports overriding robots.txt content via query', async () => {
    const res = await fetch(`${server.url}/robots.txt?variant=disallow`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /Disallow: \//);
  });

  test('unknown path returns 404', async () => {
    const res = await fetch(`${server.url}/does-not-exist`);
    assert.equal(res.status, 404);
  });

  test('can inject arbitrary Content-Type', async () => {
    const res = await fetch(`${server.url}/redirect-target?ct=application/pdf&body=PDF-BYTES`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
  });
});
