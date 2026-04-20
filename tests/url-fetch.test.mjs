import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fetchUrl, FetchError } from '../mcp/lib/url-fetch.mjs';
import { startFixtureServer } from './helpers/fixture-server.mjs';

describe('url-fetch (integration with fixture server)', () => {
  let server;
  // テスト用に loopback を一時許可
  before(async () => {
    process.env.KIOKU_URL_ALLOW_LOOPBACK = '1';
    server = await startFixtureServer();
  });
  after(() => {
    delete process.env.KIOKU_URL_ALLOW_LOOPBACK;
    return server.close();
  });

  test('UX8 fetch normal article returns body + content-type', async () => {
    const r = await fetchUrl(`${server.url}/article-normal.html`);
    assert.match(r.body, /<h1>Attention Is All You Need<\/h1>/);
    assert.match(r.contentType, /text\/html/);
    assert.equal(r.status, 200);
    assert.equal(r.truncated, false);
  });

  test('UX9 redirect follow up to 5 hops', async () => {
    const target = encodeURIComponent(`${server.url}/article-normal.html`);
    const r = await fetchUrl(`${server.url}/redirect-to/${target}`);
    assert.equal(r.status, 200);
    assert.ok(r.finalUrl.endsWith('article-normal.html'));
  });

  test('UX9b redirect limit exceeded → FetchError', async () => {
    let chained = `${server.url}/article-normal.html`;
    for (let i = 0; i < 6; i++) {
      chained = `${server.url}/redirect-to/${encodeURIComponent(chained)}`;
    }
    await assert.rejects(() => fetchUrl(chained), (e) => e.code === 'redirect_limit');
  });

  test('UX10 HTTPS → HTTP downgrade rejected', async () => {
    const httpsLike = `${server.url}/redirect-to/${encodeURIComponent('http://insecure.example.com/')}`;
    await assert.rejects(
      () => fetchUrl(httpsLike, { assumeStartScheme: 'https:' }),
      (e) => e.code === 'scheme_downgrade',
    );
  });

  test('UX11 401 Unauthorized → FetchError(auth)', async () => {
    await assert.rejects(
      () => fetchUrl(`${server.url}/status?code=401`),
      (e) => e.code === 'auth_required',
    );
  });

  test('UX11b 403 Forbidden → FetchError(auth)', async () => {
    await assert.rejects(
      () => fetchUrl(`${server.url}/status?code=403`),
      (e) => e.code === 'auth_required',
    );
  });

  test('UX12 404 → FetchError(not_found)', async () => {
    await assert.rejects(
      () => fetchUrl(`${server.url}/status?code=404`),
      (e) => e.code === 'not_found',
    );
  });

  test('UX13 5MB+ body → truncated: true', async () => {
    const r = await fetchUrl(`${server.url}/huge`, { maxBytes: 5_000_000 });
    assert.equal(r.truncated, true);
    assert.ok(r.body.length <= 5_000_000);
  });

  test('UX14 timeout triggers FetchError', async () => {
    await assert.rejects(
      () => fetchUrl(`${server.url}/slow`, { timeoutMs: 100 }),
      (e) => e.code === 'timeout',
    );
  });

  test('UX15 DNS rebinding (public hostname → private IP) rejected', async () => {
    // Simulate a hostname that resolves to 10.0.0.1 (private RFC1918).
    // Use a fake hostname so validateUrl string check passes.
    const fakeLookup = async (host) => ({ address: '10.0.0.1', family: 4 });
    await assert.rejects(
      () => fetchUrl('http://evil-rebind.example.com/', {
        _dnsLookupOverride: fakeLookup,
      }),
      (e) => e.code === 'dns_private',
    );
  });

  test('UX16 DNS resolution failure → dns_failed', async () => {
    const failLookup = async (host) => { throw new Error('NXDOMAIN'); };
    await assert.rejects(
      () => fetchUrl('http://nonexistent.example.com/', {
        _dnsLookupOverride: failLookup,
      }),
      (e) => e.code === 'dns_failed',
    );
  });
});
