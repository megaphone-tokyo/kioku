// mcp/lib/xml-safe.mjs — container.xml / .opf の XXE 安全パース (VULN-E002)。
//
// 防御方針:
//   1. pre-scan で <!DOCTYPE / <!ENTITY を検出したら reject
//      (SYSTEM / PUBLIC 単体は book title / description の normal word と衝突するため
//      含めない。<!DOCTYPE で DTD 宣言自体を遮断できるため structural check で十分)
//   2. fast-xml-parser を processEntities: false で呼ぶ (2 層目、entity 展開を禁止)
//   3. 必要フィールドのみ抽出 (rootfilePath / metadata / spineHrefs)

import { XMLParser } from 'fast-xml-parser';

// 防御方針 1: structural DTD tokens のみ検出 (SYSTEM/PUBLIC 単体は含めない)
const DOCTYPE_RE = /<!DOCTYPE\b|<!ENTITY\b/i;

export function assertNoDoctype(xml) {
  if (typeof xml !== 'string') {
    throw Object.assign(new Error('xml must be string'), { code: 'invalid_xml' });
  }
  if (DOCTYPE_RE.test(xml)) {
    throw Object.assign(new Error('XML DOCTYPE/ENTITY rejected'), { code: 'xxe_rejected' });
  }
}

function parser() {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    processEntities: false,
    htmlEntities: false,
    allowBooleanAttributes: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    removeNSPrefix: false,
  });
}

function pickStr(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.length > 0 ? pickStr(v[0]) : '';
  if (typeof v === 'object' && '#text' in v) return String(v['#text'] || '');
  return String(v);
}

export function parseContainer(xml) {
  assertNoDoctype(xml);
  const tree = parser().parse(xml);
  const container = tree.container || tree['container'];
  if (!container) throw Object.assign(new Error('container root missing'), { code: 'invalid_container' });
  const rootfiles = container.rootfiles;
  const rootfile = rootfiles && (Array.isArray(rootfiles.rootfile) ? rootfiles.rootfile[0] : rootfiles.rootfile);
  const path = rootfile && (rootfile['@_full-path'] || rootfile['@_fullPath']);
  if (!path || typeof path !== 'string') {
    throw Object.assign(new Error('rootfile full-path missing'), { code: 'invalid_container' });
  }
  return { rootfilePath: path };
}

export function parseOpf(xml) {
  assertNoDoctype(xml);
  const tree = parser().parse(xml);
  const pkg = tree.package;
  if (!pkg) throw Object.assign(new Error('package root missing'), { code: 'invalid_opf' });

  const metaNode = pkg.metadata || {};
  const metadata = {
    title: pickStr(metaNode['dc:title']).slice(0, 200),
    creator: pickStr(metaNode['dc:creator']).slice(0, 200),
    description: pickStr(metaNode['dc:description']).slice(0, 1000),
  };

  const manifestNode = pkg.manifest || {};
  const items = manifestNode.item
    ? (Array.isArray(manifestNode.item) ? manifestNode.item : [manifestNode.item])
    : [];
  const idToHref = new Map();
  for (const it of items) {
    const id = it['@_id'];
    const href = it['@_href'];
    if (id && href) idToHref.set(String(id), String(href));
  }

  const spineNode = pkg.spine || {};
  const refs = spineNode.itemref
    ? (Array.isArray(spineNode.itemref) ? spineNode.itemref : [spineNode.itemref])
    : [];
  const spineHrefs = [];
  for (const r of refs) {
    const idref = r['@_idref'];
    const href = idref && idToHref.get(String(idref));
    if (href) spineHrefs.push(href);
  }

  return { metadata, spineHrefs };
}

/**
 * docProps/core.xml から DOCX core metadata を XXE 安全に抽出する。
 *
 * 存在しない要素は空文字列を返す (DOCX は core.xml が省略可能なため throw しない)。
 * title/creator/subject は 200 字、description は 1000 字で cap。
 *
 * @param {string} xml
 * @returns {{title: string, creator: string, subject: string, description: string}}
 */
export function parseDocxCore(xml) {
  assertNoDoctype(xml);
  const tree = parser().parse(xml);
  // `cp:coreProperties` は namespace prefix 付き。removeNSPrefix: false のため tag 名そのままで取得
  const core = tree['cp:coreProperties'] || tree.coreProperties || {};
  return {
    title: pickStr(core['dc:title']).slice(0, 200),
    creator: pickStr(core['dc:creator']).slice(0, 200),
    subject: pickStr(core['dc:subject']).slice(0, 200),
    description: pickStr(core['dc:description']).slice(0, 1000),
  };
}
