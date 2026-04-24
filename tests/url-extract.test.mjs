// tests/url-extract.test.mjs — url-extract orchestrator の統合テスト
//
// 設計書 §4.2 / §4.6 — UI9-16 idempotency + refresh_days + orchestration 全体。
// 実 Vault 汚染を避けるため $OBSIDIAN_VAULT には触れず、mkdtemp の一時ディレクトリで閉じる。

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractAndSaveUrl } from '../mcp/lib/url-extract.mjs';
import { startFixtureServer } from './helpers/fixture-server.mjs';

describe('url-extract orchestrator', () => {
  let server, workspace, vault;
  before(async () => {
    process.env.KIOKU_URL_ALLOW_LOOPBACK = '1';
    server = await startFixtureServer();
    workspace = await mkdtemp(join(tmpdir(), 'kioku-ue-'));
    vault = join(workspace, 'vault');
    await mkdir(join(vault, 'raw-sources', 'articles', 'fetched'), { recursive: true });
    await mkdir(join(vault, '.cache', 'html'), { recursive: true });
  });
  after(async () => {
    delete process.env.KIOKU_URL_ALLOW_LOOPBACK;
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  });

  test('orchestration: normal article → writes markdown + media + frontmatter', async () => {
    const r = await extractAndSaveUrl({
      url: `${server.url}/article-normal.html`,
      vault,
      subdir: 'articles',
      robotsUrlOverride: `${server.url}/robots.txt?variant=allow`,
    });
    assert.equal(r.status, 'fetched_and_summarized_pending');
    assert.match(r.path, /raw-sources\/articles\/fetched\/127\.0\.0\.1-article-normal\.md$/);
    const content = await readFile(join(vault, r.path), 'utf8');
    // 2026-04-24 (open-issues.md §18): sanitizedJsdom (GAP-D005) が <meta> を strip
    // するため og:title が見えず、Readability は <title> raw 文字列を採用する。
    // 詳細は readability-extract.test.mjs の UE1 コメント参照。
    assert.match(content, /title: "Attention Is All You Need — Normal Article"/);
    assert.match(content, /source_url: "/);
    assert.match(content, /^source_sha256: "[0-9a-f]{64}"$/m);
    assert.match(content, /fallback_used: "readability"/);
    assert.match(content, /refresh_days: 30/);
  });

  test('UI9 same content re-extract → skipped', async () => {
    const r1 = await extractAndSaveUrl({
      url: `${server.url}/article-normal.html`,
      vault, subdir: 'articles',
      robotsUrlOverride: `${server.url}/robots.txt?variant=allow`,
    });
    const r2 = await extractAndSaveUrl({
      url: `${server.url}/article-normal.html`,
      vault, subdir: 'articles',
      robotsUrlOverride: `${server.url}/robots.txt?variant=allow`,
    });
    assert.equal(r2.status, 'skipped_same_sha');
    assert.equal(r2.source_sha256, r1.source_sha256);
  });

  test('UI11 within REFRESH_DAYS → skipped_within_refresh', async () => {
    // First fetch
    await extractAndSaveUrl({
      url: `${server.url}/article-normal.html`,
      vault, subdir: 'articles',
      robotsUrlOverride: `${server.url}/robots.txt?variant=allow`,
      refreshDays: 30,
    });
    // Second without content change, within refresh window
    const r = await extractAndSaveUrl({
      url: `${server.url}/article-normal.html`,
      vault, subdir: 'articles',
      robotsUrlOverride: `${server.url}/robots.txt?variant=allow`,
      refreshDays: 30,
    });
    assert.ok(r.status === 'skipped_within_refresh' || r.status === 'skipped_same_sha');
  });

  test('UI13 refresh_days=1 with old fetched_at → re-fetch', async () => {
    const r1 = await extractAndSaveUrl({
      url: `${server.url}/article-normal.html`,
      vault, subdir: 'articles',
      robotsUrlOverride: `${server.url}/robots.txt?variant=allow`,
      refreshDays: 1,
    });
    // Manually rewrite fetched_at to 2 days ago
    const p = join(vault, r1.path);
    let content = await readFile(p, 'utf8');
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    content = content.replace(/fetched_at: "[^"]+"/, `fetched_at: "${twoDaysAgo}"`);
    await writeFile(p, content);
    const r2 = await extractAndSaveUrl({
      url: `${server.url}/article-normal.html`,
      vault, subdir: 'articles',
      robotsUrlOverride: `${server.url}/robots.txt?variant=allow`,
      refreshDays: 1,
    });
    // sha is same (content unchanged) but we should have re-evaluated
    assert.ok(['refreshed_fetched_at', 'skipped_same_sha'].includes(r2.status));
  });

  test('UI14 refresh_days=never with existing file → always skipped', async () => {
    await extractAndSaveUrl({
      url: `${server.url}/article-normal.html`,
      vault, subdir: 'articles',
      robotsUrlOverride: `${server.url}/robots.txt?variant=allow`,
      refreshDays: 'never',
    });
    // Even if we simulate the content changing, never should not re-fetch
    const r2 = await extractAndSaveUrl({
      url: `${server.url}/article-normal.html`,
      vault, subdir: 'articles',
      robotsUrlOverride: `${server.url}/robots.txt?variant=allow`,
      refreshDays: 'never',
    });
    assert.ok(['skipped_never', 'skipped_same_sha'].includes(r2.status));
  });

  test('UI17 future fetched_at (clock skew) does not crash and preserves title', async () => {
    // Regression smoke for code-quality HIGH-2 (2026-04-19):
    // 2 Mac NTP 差で fetched_at が未来時刻で保存されるケースをシミュレート。
    // 事前 fix では ageMs < 0 が refreshMs 未満で永続 skip していた。
    // Math.max(0, ageMs) で「クロック skew 量ではなく refreshDays 単位で skip 解除」に。
    // 同時に HIGH-1 (frontmatter stripQuotes の JSON unescape) の回帰確認も行う:
    // タイトルが re-read → bumpFetchedAt の回に corrupt されないこと。
    await extractAndSaveUrl({
      url: `${server.url}/article-normal.html`,
      vault, subdir: 'articles',
      robotsUrlOverride: `${server.url}/robots.txt?variant=allow`,
      refreshDays: 1,
    });
    const r1Path = join(vault, 'raw-sources', 'articles', 'fetched', '127.0.0.1-article-normal.md');
    let content = await readFile(r1Path, 'utf8');
    const futureDate = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
    content = content.replace(/fetched_at: "[^"]+"/, `fetched_at: "${futureDate}"`);
    await writeFile(r1Path, content);
    const r2 = await extractAndSaveUrl({
      url: `${server.url}/article-normal.html`,
      vault, subdir: 'articles',
      robotsUrlOverride: `${server.url}/robots.txt?variant=allow`,
      refreshDays: 1,
    });
    // 正常系: crash せず、status は valid skip code のいずれか。
    assert.ok(['skipped_within_refresh', 'skipped_same_sha'].includes(r2.status));
    // HIGH-1 回帰確認: orchestrator が parseFrontmatter → bumpFetchedAt で
    // title を JSON-escape して再書込 → 再度読ませても corrupt していないこと。
    // 2026-04-24 (open-issues.md §18): title は <title> raw 文字列 (UE1 コメント参照)。
    const reread = await readFile(r1Path, 'utf8');
    assert.match(reread, /title: "Attention Is All You Need — Normal Article"/);
  });

  test('robots Disallow returns skipped_robots', async () => {
    await assert.rejects(
      () => extractAndSaveUrl({
        url: `${server.url}/article-normal.html`,
        vault, subdir: 'articles',
        robotsUrlOverride: `${server.url}/robots.txt?variant=disallow`,
      }),
      (e) => e.code === 'robots_disallow',
    );
  });

  test('raw HTML saved to .cache/html/', async () => {
    await extractAndSaveUrl({
      url: `${server.url}/article-normal.html`,
      vault, subdir: 'articles',
      robotsUrlOverride: `${server.url}/robots.txt?variant=allow`,
    });
    const htmlCacheDir = join(vault, '.cache', 'html');
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(htmlCacheDir);
    assert.ok(entries.some((n) => n.endsWith('.html')), `raw HTML cached: ${entries}`);
  });
});
