// tests/fixtures/docx-builder.mjs — test 用 DOCX 生成ヘルパー。
// epub-builder.mjs の buildEpub() を流用して DOCX の最小 skeleton を生成する。
//
// 最小 DOCX 構造:
//   [Content_Types].xml   — MIME マッピング (mammoth の必須前提)
//   _rels/.rels           — package relationship (OPC)
//   word/document.xml     — 本文 OOXML
//   word/_rels/document.xml.rels — (optional) image/footnote relationship
//   docProps/core.xml     — (optional) core metadata

import { buildEpub } from './epub-builder.mjs';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const DEFAULT_DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Sample Heading</w:t></w:r></w:p>
    <w:p><w:r><w:t>Sample paragraph body.</w:t></w:r></w:p>
  </w:body>
</w:document>`;

const DEFAULT_CORE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                   xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>Sample Title</dc:title>
  <dc:creator>Alice</dc:creator>
  <dc:subject>Tests</dc:subject>
</cp:coreProperties>`;

/**
 * DOCX (ZIP) buffer を生成する。
 *
 * @param {object} opts
 * @param {string} [opts.documentXml] — word/document.xml の中身。未指定なら default skeleton
 * @param {string} [opts.coreXml]     — docProps/core.xml の中身。null で省略
 * @param {Array<{name:string, data:string|Buffer, symlink?:string}>} [opts.extraEntries] — 追加 entry (OLE/media/evil 用)
 * @param {object} [opts.builderOpts] — buildEpub に渡す opts (forgeSizes 等)
 * @returns {Buffer}
 */
export function buildDocx(opts = {}) {
  const {
    documentXml = DEFAULT_DOCUMENT_XML,
    coreXml = DEFAULT_CORE_XML,
    extraEntries = [],
    builderOpts = {},
  } = opts;

  const entries = [
    { name: '[Content_Types].xml', data: CONTENT_TYPES, compression: 'deflate' },
    { name: '_rels/.rels', data: ROOT_RELS, compression: 'deflate' },
    { name: 'word/document.xml', data: documentXml, compression: 'deflate' },
  ];
  if (coreXml) {
    entries.push({ name: 'docProps/core.xml', data: coreXml, compression: 'deflate' });
  }
  for (const e of extraEntries) entries.push(e);
  return buildEpub(entries, builderOpts);
}
