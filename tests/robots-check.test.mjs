import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { checkRobots, RobotsError } from '../mcp/lib/robots-check.mjs';
import { startFixtureServer } from './helpers/fixture-server.mjs';

// v0.7.2 PR C: URL test 安定化。fixture server / network-ish 統合テストは
// `KIOKU_SKIP_NETWORKISH_TESTS=1` で skip 可能、各 test に 30s hard timeout。
const SKIP_NETWORK = process.env.KIOKU_SKIP_NETWORKISH_TESTS === '1';
const NETWORK_TEST = { skip: SKIP_NETWORK ? 'KIOKU_SKIP_NETWORKISH_TESTS=1' : false, timeout: 30_000 };

describe('robots-check', () => {
  let server;
  before(async () => {
    if (SKIP_NETWORK) return;
    process.env.KIOKU_URL_ALLOW_LOOPBACK = '1';
    server = await startFixtureServer();
  });
  after(() => {
    if (SKIP_NETWORK) return;
    delete process.env.KIOKU_URL_ALLOW_LOOPBACK;
    return server.close();
  });

  test('UX15 Disallow / blocks fetch', NETWORK_TEST, async () => {
    await assert.rejects(
      () => checkRobots(`${server.url}/article-normal.html?_variant=disallow`,
                         { robotsUrlOverride: `${server.url}/robots.txt?variant=disallow` }),
      (e) => e instanceof RobotsError && e.code === 'robots_disallow',
    );
  });

  test('UX16 Disallow /admin allows /article', NETWORK_TEST, async () => {
    await checkRobots(`${server.url}/article-normal.html`,
                       { robotsUrlOverride: `${server.url}/robots.txt?variant=mixed` });
    // No throw = pass
  });

  test('UX17 robots 404 → allow (no throw)', NETWORK_TEST, async () => {
    // Override to missing URL — fixture server returns 404 for unknown robots variant
    await checkRobots(`${server.url}/article-normal.html`,
                       { robotsUrlOverride: `${server.url}/robots.txt?variant=does-not-exist` });
  });

  test('UX18 IGNORE_ROBOTS=1 bypasses', NETWORK_TEST, async () => {
    process.env.KIOKU_URL_IGNORE_ROBOTS = '1';
    try {
      await checkRobots(`${server.url}/article-normal.html`,
                         { robotsUrlOverride: `${server.url}/robots.txt?variant=disallow` });
    } finally {
      delete process.env.KIOKU_URL_IGNORE_ROBOTS;
    }
  });
});
