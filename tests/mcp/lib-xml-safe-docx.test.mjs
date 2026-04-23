// tests/mcp/lib-xml-safe-docx.test.mjs — xml-safe.mjs::parseDocxCore の単体テスト。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_DIR = join(__dirname, '..', '..', 'mcp');
const { parseDocxCore, assertNoDoctype } = await import(join(MCP_DIR, 'lib', 'xml-safe.mjs'));

const CORE_OK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                   xmlns:dc="http://purl.org/dc/elements/1.1/"
                   xmlns:dcterms="http://purl.org/dc/terms/">
  <dc:title>Sample Title</dc:title>
  <dc:creator>Alice</dc:creator>
  <dc:subject>Technical Report</dc:subject>
  <dc:description>This is a short description.</dc:description>
</cp:coreProperties>`;

describe('parseDocxCore', () => {
  test('extracts title/creator/subject/description from core.xml', () => {
    const r = parseDocxCore(CORE_OK);
    assert.equal(r.title, 'Sample Title');
    assert.equal(r.creator, 'Alice');
    assert.equal(r.subject, 'Technical Report');
    assert.equal(r.description, 'This is a short description.');
  });

  test('returns empty strings when metadata fields are missing', () => {
    const xml = `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"/>`;
    const r = parseDocxCore(xml);
    assert.equal(r.title, '');
    assert.equal(r.creator, '');
    assert.equal(r.subject, '');
    assert.equal(r.description, '');
  });

  test('caps overly long title/creator/subject at 200 chars', () => {
    const long = 'x'.repeat(500);
    const xml = `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title>${long}</dc:title>
      <dc:creator>${long}</dc:creator>
      <dc:subject>${long}</dc:subject>
    </cp:coreProperties>`;
    const r = parseDocxCore(xml);
    assert.equal(r.title.length, 200);
    assert.equal(r.creator.length, 200);
    assert.equal(r.subject.length, 200);
  });

  test('caps overly long description at 1000 chars', () => {
    const long = 'x'.repeat(5000);
    const xml = `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:description>${long}</dc:description>
    </cp:coreProperties>`;
    const r = parseDocxCore(xml);
    assert.equal(r.description.length, 1000);
  });

  test('rejects DOCTYPE declaration (XXE pre-scan)', () => {
    const xml = `<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties">
  <dc:title>&xxe;</dc:title>
</cp:coreProperties>`;
    assert.throws(
      () => parseDocxCore(xml),
      (err) => err.code === 'xxe_rejected',
    );
  });

  test('rejects ENTITY declaration', () => {
    const xml = `<!ENTITY evil "X">
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"/>`;
    assert.throws(
      () => parseDocxCore(xml),
      (err) => err.code === 'xxe_rejected',
    );
  });

  test('does not throw on missing cp:coreProperties root (returns empties)', () => {
    // DOCX によっては core.xml が fully minimal な場合があるため throw せず空 string を返す方針
    const xml = `<?xml version="1.0"?><root/>`;
    const r = parseDocxCore(xml);
    assert.deepEqual(r, { title: '', creator: '', subject: '', description: '' });
  });
});
