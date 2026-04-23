// readability-extract.mjs — Mozilla Readability で本文抽出 (Phase 2 refactor)。
//
// 2026-04-22 (Phase 2 VULN-E001 対応):
//   旧 signature `extractArticle(html, baseUrl)` は呼出側に URL fetch 前提を
//   強要し、EPUB XHTML 経路で file:// baseUrl が JSDOM を経由して local file
//   を読み取るリスクがあった。discriminated union に refactor:
//     extractArticle({ html, baseUrl? })   — EPUB / URL fetch 済 HTML 経路
//     extractArticle({ url })              — Phase 3+ で fetch 層が必要な時 (現状 throw)
//   baseUrl は常に http(s):// か about:blank に normalize。file://, data://,
//   javascript:, vbscript: は about:blank に強制書換。

import { Readability } from '@mozilla/readability';
import { sanitizedJsdom } from './html-sanitize.mjs';

const FALLBACK_MIN_TEXT_CHARS = 300;

function normalizeBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl) return 'about:blank';
  const lc = baseUrl.toLowerCase();
  if (lc.startsWith('http://') || lc.startsWith('https://')) return baseUrl;
  return 'about:blank';
}

/**
 * @param {{ html: string, baseUrl?: string } | { url: string }} opts
 * @returns {{ title, content, textContent, byline, siteName, publishedTime, ogImage, needsFallback }}
 */
export function extractArticle(opts) {
  if (typeof opts === 'string' || opts == null) {
    throw new TypeError('extractArticle must be called with an object: { html, baseUrl? } | { url }');
  }
  if ('url' in opts) {
    // Even { url, html } is rejected to avoid ambiguity (url is silently ignored).
    throw new Error('extractArticle({ url }) form is not supported in Phase 2; fetch externally and pass { html, baseUrl }');
  }
  if (!('html' in opts) || typeof opts.html !== 'string') {
    throw new TypeError('html is required and must be a string');
  }
  const html = opts.html;
  const baseUrl = normalizeBaseUrl(opts.baseUrl);

  const dom = sanitizedJsdom(html, baseUrl);
  const doc = dom.window.document;

  // Pull metadata from head (Readability doesn't give us og:image / published_time)
  const metaContent = (sel) => {
    const el = doc.querySelector(sel);
    return el ? el.getAttribute('content') : null;
  };
  const ogImage = metaContent('meta[property="og:image"]');
  const publishedTime = metaContent('meta[property="article:published_time"]')
    || metaContent('meta[name="article:published_time"]');
  const siteName = metaContent('meta[property="og:site_name"]');

  // Clone before Readability mutates
  const reader = new Readability(doc.cloneNode(true));
  const parsed = reader.parse();

  if (!parsed) {
    return {
      title: null, content: '', textContent: '', byline: null,
      siteName, publishedTime, ogImage,
      needsFallback: true,
    };
  }

  const textContent = (parsed.textContent || '').trim();
  const needsFallback = textContent.length < FALLBACK_MIN_TEXT_CHARS;
  return {
    title: parsed.title,
    content: parsed.content, // HTML
    textContent,
    byline: parsed.byline,
    siteName: parsed.siteName || siteName,
    publishedTime,
    ogImage,
    needsFallback,
  };
}
