import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, stat, readFile, symlink as fsSymlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeEpubFixture } from '../fixtures/epub-builder.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_DIR = join(__dirname, '..', '..', 'mcp');
const { extractEpubEntries } = await import(join(MCP_DIR, 'lib', 'epub-extract.mjs'));

let work;
before(async () => { work = await mkdtemp(join(tmpdir(), 'kioku-epub-ext-')); });
after(() => rm(work, { recursive: true, force: true }));

function newExtractDir() {
  return mkdtemp(join(work, 'extract-')).then((d) => d);
}

describe('epub-extract safety layers', () => {
  test('MCP-D6a rejects ../ path traversal (zip-slip)', async () => {
    const epub = await writeEpubFixture(work, 'd6a.epub', [
      { name: 'mimetype', data: 'application/epub+zip', compression: 'stored' },
      { name: '../evil.xhtml', data: '<p>x</p>', compression: 'deflate' },
    ]);
    const out = await newExtractDir();
    await assert.rejects(
      extractEpubEntries(epub, out),
      (err) => err.code === 'zip_slip' || /outside base|traversal|outside boundary/i.test(err.message),
    );
  });

  test('MCP-D6c rejects >KIOKU_DOC_MAX_ENTRIES entries', async () => {
    const entries = [{ name: 'mimetype', data: 'application/epub+zip', compression: 'stored' }];
    for (let i = 0; i < 10; i++) {
      entries.push({ name: `ch${i}.xhtml`, data: '<p>x</p>', compression: 'deflate' });
    }
    const epub = await writeEpubFixture(work, 'd6c.epub', entries);
    const out = await newExtractDir();
    await assert.rejects(
      extractEpubEntries(epub, out, { maxEntries: 5 }),
      (err) => err.code === 'entry_count_exceeded' || /too many entries|entries exceed/i.test(err.message),
    );
  });

  test('MCP-D6e rejects symlink entries (VULN-E003)', async () => {
    const epub = await writeEpubFixture(work, 'd6e.epub', [
      { name: 'mimetype', data: 'application/epub+zip', compression: 'stored' },
      { name: 'bad.link', data: '', symlink: '/etc/passwd' },
    ]);
    const out = await newExtractDir();
    await assert.rejects(
      extractEpubEntries(epub, out),
      (err) => err.code === 'symlink_rejected' || /symlink/i.test(err.message),
    );
    const entries = await readdir(out, { withFileTypes: true });
    for (const e of entries) {
      assert.ok(!e.isSymbolicLink(), `symlink leaked: ${e.name}`);
    }
  });

  test('MCP-D6i-cd-forge yauzl validateEntrySizes detects CD/LFH size discrepancy (VULN-E005)', async () => {
    // CD announces 100 bytes, LFH (and actual body) is 5000 bytes.
    // entryBytesLimit is generous (1MB) so Layer 7 does NOT fire — this test exclusively
    // exercises yauzl's built-in validateEntrySizes check (Layer 1).
    const hugeBody = 'x'.repeat(5000);
    const epub = await writeEpubFixture(work, 'd6i-cd-forge.epub', [
      { name: 'mimetype', data: 'application/epub+zip', compression: 'stored' },
      { name: 'huge.xhtml', data: hugeBody, compression: 'deflate' },
    ], { forgeSizes: { 'huge.xhtml': { cdAnnounced: 100 } } });
    const out = await newExtractDir();
    await assert.rejects(
      extractEpubEntries(epub, out, { entryBytesLimit: 1024 * 1024 }),
      (err) => /size.*mismatch|mismatch|invalid/i.test(err.message) || err.code === 'size_mismatch',
      'yauzl validateEntrySizes should reject LFH/CD size mismatch',
    );
  });

  test('MCP-D6i-stream-cap rejects entry whose streaming bytes exceed entryBytesLimit (Layer 7)', async () => {
    // Both LFH and CD announce 100 bytes, but actual body is 5000 bytes.
    // yauzl validateEntrySizes does NOT fire (LFH == CD), but the streaming Layer 7 cap does.
    const hugeBody = 'x'.repeat(5000);
    const epub = await writeEpubFixture(work, 'd6i-stream-cap.epub', [
      { name: 'mimetype', data: 'application/epub+zip', compression: 'stored' },
      { name: 'huge.xhtml', data: hugeBody, compression: 'deflate' },
    ], { forgeSizes: { 'huge.xhtml': { announced: 100 } } });
    const out = await newExtractDir();
    await assert.rejects(
      extractEpubEntries(epub, out, { entryBytesLimit: 200 }),
      (err) => err.code === 'entry_bytes_exceeded' || err.code === 'size_mismatch' || /exceeded|size/i.test(err.message),
    );
  });

  test('MCP-D6j rejects 1 entry > entryBytesLimit', async () => {
    const body = 'x'.repeat(100_000);
    const epub = await writeEpubFixture(work, 'd6j.epub', [
      { name: 'mimetype', data: 'application/epub+zip', compression: 'stored' },
      { name: 'big.xhtml', data: body, compression: 'deflate' },
    ]);
    const out = await newExtractDir();
    await assert.rejects(
      extractEpubEntries(epub, out, { entryBytesLimit: 1000 }),
      (err) => err.code === 'entry_bytes_exceeded',
    );
  });

  test('MCP-D6k skips nested ZIP/EPUB entries with WARN (VULN-E005)', async () => {
    const inner = '\x50\x4b\x03\x04dummy';
    const epub = await writeEpubFixture(work, 'd6k.epub', [
      { name: 'mimetype', data: 'application/epub+zip', compression: 'stored' },
      { name: 'nested.zip', data: inner, compression: 'stored' },
      { name: 'ch01.xhtml', data: '<p>ok</p>', compression: 'deflate' },
    ]);
    const out = await newExtractDir();
    const result = await extractEpubEntries(epub, out);
    const names = result.entries.map((e) => e.name);
    assert.ok(!names.includes('nested.zip'), 'nested zip should be skipped');
    assert.ok(names.includes('ch01.xhtml'));
    assert.ok(result.warnings.some((w) => /nested/i.test(w)), 'should warn about nested');
  });

  test('MCP-D6l rejects U+202E / NUL / CR/LF in filename (VULN-E014)', async () => {
    for (const badName of ['ev\u202Elip.xhtml', 'ch\r\n.xhtml', 'with\0null.xhtml']) {
      const epub = await writeEpubFixture(work, `d6l-${encodeURIComponent(badName)}.epub`, [
        { name: 'mimetype', data: 'application/epub+zip', compression: 'stored' },
        { name: badName, data: '<p>x</p>', compression: 'deflate' },
      ]);
      const out = await newExtractDir();
      await assert.rejects(
        extractEpubEntries(epub, out),
        (err) => err.code === 'invalid_filename' || /control|U\+202E|normalize|null/i.test(err.message),
        `filename should be rejected: ${JSON.stringify(badName)}`,
      );
    }
  });

  test('happy path: valid EPUB with mimetype + container + chapter extracts ok', async () => {
    const epub = await writeEpubFixture(work, 'good.epub', [
      { name: 'mimetype', data: 'application/epub+zip', compression: 'stored' },
      { name: 'META-INF/container.xml', data: '<container>ok</container>', compression: 'deflate' },
      { name: 'OEBPS/ch01.xhtml', data: '<html><body><p>hi</p></body></html>', compression: 'deflate' },
    ]);
    const out = await newExtractDir();
    const result = await extractEpubEntries(epub, out);
    assert.equal(result.entries.length, 3);
    const chEntry = result.entries.find((e) => e.name === 'OEBPS/ch01.xhtml');
    assert.ok(chEntry, 'chapter entry present');
    const chContent = await readFile(join(out, 'OEBPS/ch01.xhtml'), 'utf8');
    assert.match(chContent, /<p>hi<\/p>/);
  });
});
