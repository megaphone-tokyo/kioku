// readability-extract.mjs — Mozilla Readability で本文抽出
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

const FALLBACK_MIN_TEXT_CHARS = 300;

/**
 * @param {string} html
 * @param {string} baseUrl
 * @returns {{ title, content, textContent, byline, siteName, publishedTime, ogImage, needsFallback }}
 */
export function extractArticle(html, baseUrl) {
  const dom = new JSDOM(html, { url: baseUrl });
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
