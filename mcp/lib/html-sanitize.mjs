// mcp/lib/html-sanitize.mjs — JSDOM ベースの HTML sanitizer。
// readability-extract.mjs と mcp/tools/ingest/epub.mjs で共有 (VULN-E010)。
//
// 防御対象 (層 6 + 8):
//   - <script> / <iframe> / <object> / <embed> を element ごと削除
//   - 全 element の on* attr (onclick / onerror / onmouseover 等) を削除
//   - <a href="javascript:..."> / <img src="javascript:..."> / src="file:///..."  を無効化
//
// JSDOM オプション (VULN-E001):
//   - resources: undefined (default)。external fetch は起きない
//   - runScripts: undefined (default)。script 実行なし
//   - pretendToBeVisual: false。default false だが明示
//   - url: 'about:blank'。baseUrl の file:// 透過を遮断

import { JSDOM } from 'jsdom';

// meta/base/link は EPUB 章 XHTML に合法的に含まれ得る。Markdown 経路では turndown が
// drop するが、sanitizedJsdom を Document として消費する経路 (将来の readability 再 parse 等)
// での defense-in-depth として DANGEROUS_TAGS に含める (GAP-D005)。
const DANGEROUS_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'frame', 'frameset', 'meta', 'base', 'link']);
const DANGEROUS_URL_ATTRS = new Set(['href', 'src', 'action', 'formaction']);

function stripDangerousNodes(doc) {
  for (const tag of DANGEROUS_TAGS) {
    for (const el of Array.from(doc.querySelectorAll(tag))) {
      el.remove();
    }
  }
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (DANGEROUS_URL_ATTRS.has(attr.name.toLowerCase())) {
        const v = (attr.value || '').trim().toLowerCase();
        if (v.startsWith('javascript:') || v.startsWith('data:text/html') || v.startsWith('vbscript:') || v.startsWith('file:')) {
          el.removeAttribute(attr.name);
        }
      }
    }
  }
}

/**
 * @param {string} html
 * @returns {string} sanitized HTML (innerHTML of body)
 */
export function sanitizeHtml(html) {
  const dom = new JSDOM(html, {
    url: 'about:blank',
    pretendToBeVisual: false,
  });
  stripDangerousNodes(dom.window.document);
  return dom.window.document.body ? dom.window.document.body.innerHTML : '';
}

/**
 * JSDOM インスタンスごと sanitize して返す (Readability が Document を消費する経路用)。
 *
 * ライフサイクル: caller が `dom.window.close()` を呼ぶかどうかは任意。
 * resources:undefined + runScripts:undefined のため外部 fetch / script exec は
 * 起きず、caller が参照を落とせば GC が window を回収する。章ループで大量に
 * 呼ぶ場合は明示的に window.close() を呼ぶと steady-state memory を抑えられる。
 *
 * @param {string} html
 * @param {string} [baseUrl='about:blank'] — 必ず http(s) スキームか about:blank に固定すること。
 * @returns {JSDOM}
 */
export function sanitizedJsdom(html, baseUrl = 'about:blank') {
  const dom = new JSDOM(html, {
    url: baseUrl,
    pretendToBeVisual: false,
  });
  stripDangerousNodes(dom.window.document);
  return dom;
}
