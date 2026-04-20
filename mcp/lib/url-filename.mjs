// url-filename.mjs — URL → filename スラッグ化 (決定論的、SAFE_PATH_RE 互換)
//
// 設計書 §6: <host>-<slug>.md、80 char 超過で truncate + sha8 suffix。
// SAFE_PATH_RE = /^[\p{L}\p{N}/._ -]+$/u (vault-path.mjs) と互換な文字集合のみ。

import { createHash } from 'node:crypto';

const MAX_LEN_NO_SUFFIX = 80;

export function urlToFilename(urlStr) {
  const url = new URL(urlStr);
  const host = url.hostname.toLowerCase();
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // malformed percent-encoding — fall back to raw pathname
  }
  if (path.startsWith('/')) path = path.slice(1);
  path = path.replace(/\.html?$/i, '');
  path = path
    .replace(/[^\p{L}\p{N}_./\-]+/gu, '-')
    .replace(/\//g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!path) path = 'root';
  let combined = `${host}-${path}`;
  let hasTruncation = false;
  if (combined.length > MAX_LEN_NO_SUFFIX) {
    combined = combined.slice(0, MAX_LEN_NO_SUFFIX);
    hasTruncation = true;
  }
  const rawHadQuery = url.search.length > 0;
  const pathWasEmpty = rawHadQuery && url.pathname.replace(/^\//, '').replace(/\.html?$/i, '') === '';
  if (hasTruncation || pathWasEmpty) {
    const sha = createHash('sha256').update(urlStr).digest('hex').slice(0, 8);
    combined = `${combined}-${sha}`;
  }
  return `${combined}.md`;
}
