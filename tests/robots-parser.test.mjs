import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobotsTxt, isAllowed } from '../mcp/lib/robots-parser.mjs';

describe('robots-parser', () => {
  test('empty robots.txt allows all', () => {
    const rules = parseRobotsTxt('');
    assert.equal(isAllowed(rules, 'kioku-wiki', '/any/path'), true);
  });
  test('User-agent: * Disallow: / blocks all', () => {
    const rules = parseRobotsTxt('User-agent: *\nDisallow: /\n');
    assert.equal(isAllowed(rules, 'kioku-wiki', '/'), false);
    assert.equal(isAllowed(rules, 'kioku-wiki', '/any'), false);
  });
  test('User-agent: * Disallow: /admin allows /article', () => {
    const rules = parseRobotsTxt('User-agent: *\nDisallow: /admin\n');
    assert.equal(isAllowed(rules, 'kioku-wiki', '/admin'), false);
    assert.equal(isAllowed(rules, 'kioku-wiki', '/admin/sub'), false);
    assert.equal(isAllowed(rules, 'kioku-wiki', '/article'), true);
  });
  test('specific User-agent overrides *', () => {
    const rules = parseRobotsTxt([
      'User-agent: *',
      'Disallow: /',
      '',
      'User-agent: kioku-wiki',
      'Disallow: /private',
    ].join('\n'));
    assert.equal(isAllowed(rules, 'kioku-wiki', '/foo'), true);
    assert.equal(isAllowed(rules, 'kioku-wiki', '/private'), false);
    assert.equal(isAllowed(rules, 'other-bot', '/foo'), false);
  });
  test('Allow overrides Disallow for same length', () => {
    const rules = parseRobotsTxt([
      'User-agent: *',
      'Disallow: /admin',
      'Allow: /admin/public',
    ].join('\n'));
    assert.equal(isAllowed(rules, 'kioku-wiki', '/admin/public/page'), true);
    assert.equal(isAllowed(rules, 'kioku-wiki', '/admin/private'), false);
  });
  test('case-insensitive directives', () => {
    const rules = parseRobotsTxt('user-AGENT: *\nDISallow: /block\n');
    assert.equal(isAllowed(rules, 'kioku-wiki', '/block'), false);
  });
  test('comments are ignored', () => {
    const rules = parseRobotsTxt('# comment\nUser-agent: *\n# another\nDisallow: /x # inline\n');
    assert.equal(isAllowed(rules, 'kioku-wiki', '/x'), false);
  });
  test('unknown directives are ignored', () => {
    const rules = parseRobotsTxt('User-agent: *\nCrawl-delay: 10\nDisallow: /x\n');
    assert.equal(isAllowed(rules, 'kioku-wiki', '/x'), false);
  });

  // blue M-4 (2026-04-20): RFC9309 / Google 仕様の wildcard + end-anchor 対応
  describe('wildcard + end-anchor (RFC9309)', () => {
    test('UR9 Disallow: /*.pdf$ blocks .pdf URLs only', () => {
      const rules = parseRobotsTxt('User-agent: *\nDisallow: /*.pdf$\n');
      assert.equal(isAllowed(rules, 'kioku-wiki', '/foo/paper.pdf'), false);
      assert.equal(isAllowed(rules, 'kioku-wiki', '/foo/paper.html'), true);
      // end-anchor means /foo.pdf?query should NOT match (the `?` is outside `.pdf`)
      assert.equal(isAllowed(rules, 'kioku-wiki', '/foo.pdf?x=1'), true);
    });

    test('UR10 Disallow: /admin/* blocks sub-paths', () => {
      const rules = parseRobotsTxt('User-agent: *\nDisallow: /admin/*\n');
      assert.equal(isAllowed(rules, 'kioku-wiki', '/admin/'), false);
      assert.equal(isAllowed(rules, 'kioku-wiki', '/admin/x'), false);
      assert.equal(isAllowed(rules, 'kioku-wiki', '/public'), true);
    });

    test('UR11 Disallow: / with no wildcard still prefix-matches (back-compat)', () => {
      const rules = parseRobotsTxt('User-agent: *\nDisallow: /admin\n');
      assert.equal(isAllowed(rules, 'kioku-wiki', '/admin'), false);
      assert.equal(isAllowed(rules, 'kioku-wiki', '/admin/x'), false);
      assert.equal(isAllowed(rules, 'kioku-wiki', '/public'), true);
    });

    test('UR12 Disallow: /search?q=* wildcard in middle', () => {
      const rules = parseRobotsTxt('User-agent: *\nDisallow: /search?q=*\n');
      assert.equal(isAllowed(rules, 'kioku-wiki', '/search?q=foo'), false);
      assert.equal(isAllowed(rules, 'kioku-wiki', '/browse'), true);
    });

    test('UR13 regex metachars in pattern are escaped (no injection)', () => {
      const rules = parseRobotsTxt('User-agent: *\nDisallow: /a.b\n');
      // literal `.` — should block only `/a.b*` prefix, not `/aXb`
      assert.equal(isAllowed(rules, 'kioku-wiki', '/a.b'), false);
      assert.equal(isAllowed(rules, 'kioku-wiki', '/aXb'), true);
    });
  });
});
