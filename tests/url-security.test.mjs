import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateUrl, isPrivateIP, UrlSecurityError } from '../mcp/lib/url-security.mjs';

describe('url-security', () => {
  describe('validateUrl (scheme/hostname 同期検査)', () => {
    test('UX1: http://localhost/ rejects', () => {
      assert.throws(() => validateUrl('http://localhost/'), (e) => e.code === 'url_localhost');
    });
    test('UX2: http://127.0.0.1/ rejects', () => {
      assert.throws(() => validateUrl('http://127.0.0.1/'), (e) => e.code === 'url_loopback');
    });
    test('UX3a: http://10.0.0.1/ rejects', () => {
      assert.throws(() => validateUrl('http://10.0.0.1/'), (e) => e.code === 'url_private_ip');
    });
    test('UX3b: http://192.168.1.1/ rejects', () => {
      assert.throws(() => validateUrl('http://192.168.1.1/'), (e) => e.code === 'url_private_ip');
    });
    test('UX3c: http://172.16.0.1/ rejects', () => {
      assert.throws(() => validateUrl('http://172.16.0.1/'), (e) => e.code === 'url_private_ip');
    });
    test('UX4: http://169.254.169.254/ (AWS metadata) rejects', () => {
      assert.throws(() => validateUrl('http://169.254.169.254/'), (e) => e.code === 'url_link_local');
    });
    test('UX5: file:///etc/passwd rejects', () => {
      assert.throws(() => validateUrl('file:///etc/passwd'), (e) => e.code === 'url_scheme');
    });
    test('UX6: javascript:alert(1) rejects', () => {
      assert.throws(() => validateUrl('javascript:alert(1)'), (e) => e.code === 'url_scheme');
    });
    test('UX7: http://user:pass@internal/ (auth embedded) rejects', () => {
      assert.throws(() => validateUrl('http://user:pass@internal/'), (e) => e.code === 'url_credentials');
    });
    test('UX8: https://normal.example.com/ accepts', () => {
      const result = validateUrl('https://normal.example.com/');
      assert.equal(result.hostname, 'normal.example.com');
      assert.equal(result.protocol, 'https:');
    });
    test('UX8b: IPv6 ::1 rejects', () => {
      assert.throws(() => validateUrl('http://[::1]/'), (e) => e.code === 'url_loopback');
    });
    test('UX8c: IPv6 fc00::1 (ULA) rejects', () => {
      assert.throws(() => validateUrl('http://[fc00::1]/'), (e) => e.code === 'url_private_ip');
    });
    // Alternative IP notation bypasses (CRITICAL SSRF review 2026-04-19)
    test('UX9a: decimal IP 2130706433 rejects', () => {
      assert.throws(() => validateUrl('http://2130706433/'), (e) => e.code === 'url_non_standard_ip');
    });
    test('UX9b: hex IP 0x7f000001 rejects', () => {
      assert.throws(() => validateUrl('http://0x7f000001/'), (e) => e.code === 'url_non_standard_ip');
    });
    test('UX9c: octal IP 0177.0.0.1 rejects', () => {
      assert.throws(() => validateUrl('http://0177.0.0.1/'), (e) => e.code === 'url_non_standard_ip');
    });
    test('UX9d: per-octet hex 0x7f.0.0.1 rejects', () => {
      assert.throws(() => validateUrl('http://0x7f.0.0.1/'), (e) => e.code === 'url_non_standard_ip');
    });
    test('UX9e: normal hostname 0foo.com is NOT rejected', () => {
      // Should not false-positive — 0foo.com contains non-digit chars
      const r = validateUrl('https://0foo.com/');
      assert.equal(r.hostname, '0foo.com');
    });
    test('UX10a: IPv4-mapped IPv6 ::ffff:127.0.0.1 rejects', () => {
      assert.throws(() => validateUrl('http://[::ffff:127.0.0.1]/'), (e) => e.code === 'url_loopback');
    });
    test('UX10b: IPv4-mapped IPv6 ::ffff:192.168.1.1 rejects', () => {
      assert.throws(() => validateUrl('http://[::ffff:192.168.1.1]/'), (e) => e.code === 'url_private_ip');
    });
    test('UX10c: IPv4-mapped IPv6 ::ffff:169.254.169.254 rejects', () => {
      assert.throws(() => validateUrl('http://[::ffff:169.254.169.254]/'), (e) => e.code === 'url_link_local');
    });
    test('UX10d: IPv4-mapped IPv6 hex form ::ffff:7f00:1 rejects', () => {
      assert.throws(() => validateUrl('http://[::ffff:7f00:1]/'), (e) => e.code === 'url_loopback');
    });
  });

  describe('isPrivateIP', () => {
    test('10.x.x.x is private', () => assert.equal(isPrivateIP('10.5.5.5'), true));
    test('172.16-31.x.x is private', () => {
      assert.equal(isPrivateIP('172.16.0.1'), true);
      assert.equal(isPrivateIP('172.31.255.255'), true);
      assert.equal(isPrivateIP('172.32.0.1'), false);
      assert.equal(isPrivateIP('172.15.0.1'), false);
    });
    test('192.168.x.x is private', () => assert.equal(isPrivateIP('192.168.1.1'), true));
    test('8.8.8.8 is public', () => assert.equal(isPrivateIP('8.8.8.8'), false));
    test('127.0.0.1 is loopback', () => assert.equal(isPrivateIP('127.0.0.1'), true));
    test('169.254.1.1 is link-local', () => assert.equal(isPrivateIP('169.254.1.1'), true));
  });
});
