import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { checkRobots, RobotsError } from '../mcp/lib/robots-check.mjs';
import { startFixtureServer } from './helpers/fixture-server.mjs';

describe('robots-check', () => {
  let server;
  before(async () => {
    process.env.KIOKU_URL_ALLOW_LOOPBACK = '1';
    server = await startFixtureServer();
  });
  after(() => {
    delete process.env.KIOKU_URL_ALLOW_LOOPBACK;
    return server.close();
  });

  test('UX15 Disallow / blocks fetch', async () => {
    await assert.rejects(
      () => checkRobots(`${server.url}/article-normal.html?_variant=disallow`,
                         { robotsUrlOverride: `${server.url}/robots.txt?variant=disallow` }),
      (e) => e instanceof RobotsError && e.code === 'robots_disallow',
    );
  });

  test('UX16 Disallow /admin allows /article', async () => {
    await checkRobots(`${server.url}/article-normal.html`,
                       { robotsUrlOverride: `${server.url}/robots.txt?variant=mixed` });
    // No throw = pass
  });

  test('UX17 robots 404 → allow (no throw)', async () => {
    // Override to missing URL — fixture server returns 404 for unknown robots variant
    await checkRobots(`${server.url}/article-normal.html`,
                       { robotsUrlOverride: `${server.url}/robots.txt?variant=does-not-exist` });
  });

  test('UX18 IGNORE_ROBOTS=1 bypasses', async () => {
    process.env.KIOKU_URL_IGNORE_ROBOTS = '1';
    try {
      await checkRobots(`${server.url}/article-normal.html`,
                         { robotsUrlOverride: `${server.url}/robots.txt?variant=disallow` });
    } finally {
      delete process.env.KIOKU_URL_IGNORE_ROBOTS;
    }
  });
});
