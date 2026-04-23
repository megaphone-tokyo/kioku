import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_DIR = join(__dirname, '..', '..', 'mcp');
const { parseContainer, parseOpf, assertNoDoctype } = await import(join(MCP_DIR, 'lib', 'xml-safe.mjs'));

describe('xml-safe XXE defense', () => {
  test('MCP-D6f rejects DOCTYPE + ENTITY + SYSTEM', () => {
    const xxe = `<?xml version="1.0"?>
<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]>
<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
    assert.throws(
      () => assertNoDoctype(xxe),
      (err) => err.code === 'xxe_rejected' || /DOCTYPE|ENTITY|SYSTEM/i.test(err.message),
    );
  });

  test('MCP-D6f rejects PUBLIC identifier too', () => {
    const xxe = `<?xml version="1.0"?>
<!DOCTYPE container PUBLIC "-//x" "http://evil/">
<container/>`;
    assert.throws(() => assertNoDoctype(xxe), /DOCTYPE/i);
  });

  test('parseContainer extracts rootfile path', () => {
    const xml = `<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
    const r = parseContainer(xml);
    assert.equal(r.rootfilePath, 'OEBPS/content.opf');
  });

  test('parseOpf extracts title/creator/description + spine order', () => {
    const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Hello World</dc:title>
    <dc:creator>Alice</dc:creator>
    <dc:description>A book</dc:description>
  </metadata>
  <manifest>
    <item id="c1" href="ch01.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch02.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;
    const r = parseOpf(opf);
    assert.equal(r.metadata.title, 'Hello World');
    assert.equal(r.metadata.creator, 'Alice');
    assert.equal(r.metadata.description, 'A book');
    assert.deepEqual(r.spineHrefs, ['ch01.xhtml', 'ch02.xhtml']);
  });

  test('parseOpf rejects XXE DOCTYPE', () => {
    const xxe = `<?xml version="1.0"?>
<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///etc/hostname">]>
<package><metadata><dc:title>&leak;</dc:title></metadata></package>`;
    assert.throws(() => parseOpf(xxe), (err) => err.code === 'xxe_rejected');
  });

  test('accepts book title containing the word SYSTEM (false-positive fix)', () => {
    const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>SYSTEM Design Interview: An Insider's Guide</dc:title>
    <dc:creator>Alex Xu</dc:creator>
  </metadata>
  <manifest><item id="c1" href="ch01.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c1"/></spine>
</package>`;
    const r = parseOpf(opf);
    assert.equal(r.metadata.title, "SYSTEM Design Interview: An Insider's Guide");
  });

  test('accepts description containing the word PUBLIC (false-positive fix)', () => {
    const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>ok</dc:title>
    <dc:description>This book is publicly available and discusses PUBLIC domain works.</dc:description>
  </metadata>
  <manifest/>
  <spine/>
</package>`;
    const r = parseOpf(opf);
    assert.match(r.metadata.description, /publicly available/);
  });

  test('parseOpf handles multi-language dc:title (EPUB 3 array)', () => {
    const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title xml:lang="en">English Title</dc:title>
    <dc:title xml:lang="ja">日本語タイトル</dc:title>
    <dc:creator>Author</dc:creator>
  </metadata>
  <manifest/>
  <spine/>
</package>`;
    const r = parseOpf(opf);
    assert.ok(!r.metadata.title.includes('object Object'), `title corrupted: ${r.metadata.title}`);
    assert.equal(r.metadata.title, 'English Title');
  });

  test('metadata length caps (title 200 / description 1000)', () => {
    const longTitle = 'T'.repeat(300);
    const longDesc = 'D'.repeat(1500);
    const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${longTitle}</dc:title>
    <dc:description>${longDesc}</dc:description>
  </metadata>
  <manifest/><spine/>
</package>`;
    const r = parseOpf(opf);
    assert.equal(r.metadata.title.length, 200, `title should be capped at 200, got ${r.metadata.title.length}`);
    assert.equal(r.metadata.description.length, 1000, `description should be capped at 1000, got ${r.metadata.description.length}`);
  });

  test('parseContainer also rejects XXE DOCTYPE', () => {
    const xxe = `<?xml version="1.0"?>
<!DOCTYPE c [<!ENTITY leak SYSTEM "file:///etc/hostname">]>
<container><rootfiles><rootfile full-path="a.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
    assert.throws(() => parseContainer(xxe), (err) => err.code === 'xxe_rejected');
  });

  test('assertNoDoctype throws on non-string input', () => {
    assert.throws(() => assertNoDoctype(null), (err) => err.code === 'invalid_xml');
    assert.throws(() => assertNoDoctype(123), (err) => err.code === 'invalid_xml');
  });
});
