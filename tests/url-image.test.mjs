// tests/url-image.test.mjs
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadImages, rewriteImageSrc } from '../mcp/lib/url-image.mjs';
import { startFixtureServer } from './helpers/fixture-server.mjs';

describe('url-image', () => {
  let server, workspace, mediaDir;
  before(async () => {
    process.env.KIOKU_URL_ALLOW_LOOPBACK = '1';
    server = await startFixtureServer();
    workspace = await mkdtemp(join(tmpdir(), 'kioku-img-'));
    mediaDir = join(workspace, 'media');
  });
  after(async () => {
    delete process.env.KIOKU_URL_ALLOW_LOOPBACK;
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  });

  test('UI1 relative URL resolved against base, downloaded', async () => {
    const imgs = [{ src: '/sample-image.png', alt: 'sample' }];
    const r = await downloadImages(imgs, { baseUrl: server.url, mediaDir });
    assert.equal(r.images.length, 1);
    assert.match(r.images[0].localPath, /media\/127\.0\.0\.1\/[0-9a-f]{64}\.png$/);
    const entries = await readdir(join(mediaDir, '127.0.0.1'));
    assert.equal(entries.length, 1);
  });

  test('UI2 same sha → dedupe (second download → no new file)', async () => {
    const imgs = [
      { src: '/sample-image.png', alt: 'a' },
      { src: '/sample-image.png', alt: 'b' },
    ];
    const r = await downloadImages(imgs, { baseUrl: server.url, mediaDir });
    assert.equal(r.images.length, 2);
    assert.equal(r.images[0].localPath, r.images[1].localPath, 'dedupe to same file');
  });

  test('UI3 octet-stream MIME → skip + warning', async () => {
    const imgs = [{ src: '/redirect-target?ct=application%2Foctet-stream&body=junk', alt: 'x' }];
    const r = await downloadImages(imgs, { baseUrl: server.url, mediaDir });
    assert.equal(r.images.length, 0);
    assert.match(r.warnings.join('\n'), /MIME/);
  });

  test('UI4 size > maxBytes → skip + warning', async () => {
    const imgs = [{ src: '/huge', alt: 'x' }];
    const r = await downloadImages(imgs, { baseUrl: server.url, mediaDir, maxBytes: 1024 });
    assert.equal(r.images.length, 0);
    assert.match(r.warnings.join('\n'), /size/i);
  });

  test('UI5 tracking pixel (< 200 bytes) → skip', async () => {
    const imgs = [{ src: '/pixel-1x1.png', alt: '' }];
    const r = await downloadImages(imgs, { baseUrl: server.url, mediaDir });
    assert.equal(r.images.length, 0);
    assert.match(r.warnings.join('\n'), /pixel|small/i);
  });

  test('UI6 SVG skipped with warning', async () => {
    const imgs = [{ src: '/redirect-target?ct=image%2Fsvg%2Bxml&body=%3Csvg%3E%3C%2Fsvg%3E', alt: 'svg' }];
    const r = await downloadImages(imgs, { baseUrl: server.url, mediaDir });
    assert.equal(r.images.length, 0);
    assert.match(r.warnings.join('\n'), /svg/i);
  });

  test('UI7 fetch timeout → skip + warning', async () => {
    const imgs = [{ src: '/slow', alt: 'x' }];
    const r = await downloadImages(imgs, { baseUrl: server.url, mediaDir, timeoutMs: 200 });
    assert.equal(r.images.length, 0);
    assert.match(r.warnings.join('\n'), /timeout/i);
  });

  test('UI8 data: URI skipped (not downloaded)', async () => {
    const imgs = [{ src: 'data:image/png;base64,iVBORw0KGgo=', alt: 'inline' }];
    const r = await downloadImages(imgs, { baseUrl: server.url, mediaDir });
    assert.equal(r.images.length, 0);
    assert.match(r.warnings.join('\n'), /data:/);
  });

  test('UI9 hostname `..` rejected (path-traversal defense-in-depth)', async () => {
    // new URL('http://../x.png').hostname === '..' — without an explicit
    // guard, path.join(mediaDir, '..') would write one directory above
    // mediaDir. fetchUrl rejects this via DNS, but we do not depend on that.
    const imgs = [{ src: 'http://../evil.png', alt: 'evil' }];
    const r = await downloadImages(imgs, { baseUrl: server.url, mediaDir });
    assert.equal(r.images.length, 0);
    assert.match(r.warnings.join('\n'), /unsafe hostname/i);
  });

  test('UI10 hostname `.` rejected (would collapse into mediaDir root)', async () => {
    const imgs = [{ src: 'http://./evil.png', alt: 'evil' }];
    const r = await downloadImages(imgs, { baseUrl: server.url, mediaDir });
    assert.equal(r.images.length, 0);
    assert.match(r.warnings.join('\n'), /unsafe hostname/i);
  });

  describe('rewriteImageSrc', () => {
    test('replaces src with relative local path', () => {
      const md = '![hello](https://cdn.example.com/foo.png)\n\nmore\n\n![two](/other.png)';
      const mapping = new Map([
        ['https://cdn.example.com/foo.png', 'media/cdn.example.com/aaa.png'],
        ['https://base.example.com/other.png', 'media/base.example.com/bbb.png'],
      ]);
      const out = rewriteImageSrc(md, mapping, 'https://base.example.com/');
      assert.match(out, /!\[hello\]\(media\/cdn\.example\.com\/aaa\.png\)/);
      assert.match(out, /!\[two\]\(media\/base\.example\.com\/bbb\.png\)/);
    });
  });
});
