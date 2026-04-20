// tests/urls-txt-parser.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseUrlsTxt } from '../mcp/lib/urls-txt-parser.mjs';

describe('urls-txt-parser', () => {
  test('plain URL', () => {
    const r = parseUrlsTxt('https://example.com/a\n');
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].url, 'https://example.com/a');
    assert.deepEqual(r.entries[0].meta, {});
  });

  test('comments and blank lines ignored', () => {
    const r = parseUrlsTxt('# comment\n\nhttps://example.com/a\n\n# end\n');
    assert.equal(r.entries.length, 1);
  });

  test('DSL with tags', () => {
    const r = parseUrlsTxt('https://example.com/a ; tags=foo,bar\n');
    assert.deepEqual(r.entries[0].meta.tags, ['foo', 'bar']);
  });

  test('DSL with title + source_type', () => {
    const r = parseUrlsTxt('https://example.com/a ; title=Hello World ; source_type=paper\n');
    assert.equal(r.entries[0].meta.title, 'Hello World');
    assert.equal(r.entries[0].meta.source_type, 'paper');
  });

  test('UI15 DSL refresh_days parses int', () => {
    const r = parseUrlsTxt('https://example.com/a ; refresh_days=7\n');
    assert.equal(r.entries[0].meta.refresh_days, 7);
  });

  test('UI15b DSL refresh_days=never', () => {
    const r = parseUrlsTxt('https://example.com/a ; refresh_days=never\n');
    assert.equal(r.entries[0].meta.refresh_days, 'never');
  });

  test('UI15c invalid refresh_days warns and falls back', () => {
    const r = parseUrlsTxt('https://example.com/a ; refresh_days=-5\n');
    assert.equal(r.entries[0].meta.refresh_days, undefined);
    assert.match(r.warnings.join('\n'), /refresh_days/);
  });

  test('UI15d non-numeric refresh_days warns', () => {
    const r = parseUrlsTxt('https://example.com/a ; refresh_days=abc\n');
    assert.equal(r.entries[0].meta.refresh_days, undefined);
    assert.match(r.warnings.join('\n'), /refresh_days/);
  });

  test('UI15e refresh_days upper bound rejected (>3650)', () => {
    const r = parseUrlsTxt('https://example.com/a ; refresh_days=9999\n');
    assert.equal(r.entries[0].meta.refresh_days, undefined);
    assert.match(r.warnings.join('\n'), /refresh_days/);
  });

  test('unknown DSL key produces warning but does not fail', () => {
    const r = parseUrlsTxt('https://example.com/a ; weirdkey=foo\n');
    assert.equal(r.entries[0].url, 'https://example.com/a');
    assert.match(r.warnings.join('\n'), /weirdkey/);
  });

  test('malformed DSL segment (no =) warns', () => {
    const r = parseUrlsTxt('https://example.com/a ; tags\n');
    assert.match(r.warnings.join('\n'), /malformed/);
  });

  test('non-URL line warns and is skipped', () => {
    const r = parseUrlsTxt('not-a-url\n');
    assert.equal(r.entries.length, 0);
    assert.match(r.warnings.join('\n'), /not a URL/);
  });

  test('multiple entries with mixed DSL', () => {
    const r = parseUrlsTxt([
      '# header',
      'https://example.com/a',
      'https://example.com/b ; tags=x',
      'https://example.com/c ; refresh_days=never',
      '',
      'https://example.com/d ; title=Long Title ; tags=a,b,c ; refresh_days=7',
    ].join('\n'));
    assert.equal(r.entries.length, 4);
    assert.equal(r.entries[3].meta.title, 'Long Title');
    assert.deepEqual(r.entries[3].meta.tags, ['a', 'b', 'c']);
    assert.equal(r.entries[3].meta.refresh_days, 7);
  });

  test('CRLF line endings handled', () => {
    const r = parseUrlsTxt('https://example.com/a\r\nhttps://example.com/b\r\n');
    assert.equal(r.entries.length, 2);
  });

  test('line number tracked in entries', () => {
    const r = parseUrlsTxt('# hdr\nhttps://example.com/a\n\nhttps://example.com/b\n');
    assert.equal(r.entries[0].lineNo, 2);
    assert.equal(r.entries[1].lineNo, 4);
  });
});
