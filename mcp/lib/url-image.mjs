// url-image.mjs — 画像 fetch + MIME 検査 + sha256 dedupe
//
// 設計書 §4.3 / §9.4:
//   - MIME whitelist: jpeg/png/webp/gif (SVG は v1 skip)
//   - 20MB cap (KIOKU_URL_MAX_IMAGE_BYTES)
//   - 200 bytes 未満は tracking pixel 扱い skip
//   - sha256 ベース命名 (media/<host>/<sha>.<ext>)、Content-Disposition 無視
//   - fetch 8s timeout、失敗しても skip + warning で続行
//
// SSRF 防御は url-fetch.mjs に委譲 (scheme check, SSRF layer 2, size cap,
// timeout — fetchUrl が担保)。本モジュールは MIME whitelist / dedupe /
// pixel skip / SVG skip の v1 ポリシーに集中する。

import { mkdir, open, rename, stat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fetchUrl, FetchError } from './url-fetch.mjs';
import { envPositiveInt } from './env-helpers.mjs';

const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const DEFAULT_MAX_BYTES = envPositiveInt('KIOKU_URL_MAX_IMAGE_BYTES', 20_000_000);
const DEFAULT_TIMEOUT_MS = envPositiveInt('KIOKU_URL_IMAGE_TIMEOUT_MS', 8_000);
const MIN_IMAGE_BYTES = 200;

/**
 * Download a batch of images referenced in extracted HTML/Markdown.
 * Returns localPath as a relative path in the form `media/<host>/<filename>`,
 * which is the correct image reference for the Markdown file living at
 * `<fetchedDir>/<slug>.md` (orchestrator passes mediaDir = <fetchedDir>/media).
 *
 * @param {Array<{src: string, alt: string}>} imgs
 * @param {{baseUrl: string, mediaDir: string, maxBytes?: number, timeoutMs?: number}} opts
 * @returns {Promise<{images: Array<{src: string, alt: string, localPath: string, sha256?: string, size?: number}>, warnings: string[]}>}
 */
export async function downloadImages(imgs, opts) {
  const warnings = [];
  const images = [];
  const seen = new Map(); // src -> localPath (for dedupe within batch)

  for (const img of imgs) {
    const src = img.src;
    if (!src) continue;
    if (src.startsWith('data:')) {
      warnings.push(`skip data: URI (${img.alt || 'no alt'})`);
      continue;
    }
    if (seen.has(src)) {
      images.push({ src, alt: img.alt, localPath: seen.get(src) });
      continue;
    }
    let absoluteUrl;
    try {
      absoluteUrl = new URL(src, opts.baseUrl);
    } catch {
      warnings.push(`skip invalid URL: ${src}`);
      continue;
    }
    if (absoluteUrl.protocol !== 'http:' && absoluteUrl.protocol !== 'https:') {
      warnings.push(`skip non-http URL: ${src}`);
      continue;
    }
    // Defense-in-depth: reject hostnames that are not safe path components.
    // The WHATWG URL parser accepts `http://../x.png` (hostname `..`) and
    // `http://./x.png` (hostname `.`) — with `path.join(mediaDir, '..')`
    // these would traverse out of the media sandbox. In practice fetchUrl
    // rejects these via DNS, but we do not want to depend on that accidental
    // mitigation. Reject explicitly at this layer.
    const hostLower = absoluteUrl.hostname.toLowerCase();
    if (
      !hostLower ||
      hostLower === '.' ||
      hostLower === '..' ||
      hostLower.includes('/') ||
      hostLower.includes('\\') ||
      hostLower.includes('\0')
    ) {
      warnings.push(`skip unsafe hostname (${hostLower || 'empty'}): ${src}`);
      continue;
    }
    let r;
    try {
      r = await fetchUrl(absoluteUrl.href, {
        maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        binary: true,
      });
    } catch (err) {
      if (err instanceof FetchError) {
        warnings.push(`image ${src} fetch failed: ${err.code}`);
      } else {
        warnings.push(`image ${src} error: ${err.message}`);
      }
      continue;
    }
    if (r.truncated) {
      warnings.push(`image ${src} exceeded size cap, skipped`);
      continue;
    }
    const ct = (r.contentType || '').split(';')[0].trim().toLowerCase();
    if (ct === 'image/svg+xml' || ct === 'image/svg') {
      warnings.push(`SVG skipped (v1 security policy): ${src}`);
      continue;
    }
    const ext = MIME_TO_EXT[ct];
    if (!ext) {
      warnings.push(`unsupported MIME ${ct}: ${src}`);
      continue;
    }
    if (r.body.length < MIN_IMAGE_BYTES) {
      warnings.push(`small image (tracking pixel?) skipped: ${src} (${r.body.length} bytes)`);
      continue;
    }
    const sha = createHash('sha256').update(r.body).digest('hex');
    const host = hostLower;
    const hostDir = join(opts.mediaDir, host);
    await mkdir(hostDir, { recursive: true, mode: 0o700 });
    const filename = `${sha}.${ext}`;
    const absPath = join(hostDir, filename);
    // Collision check — if a prior file with the same sha exists but differs in
    // size (shouldn't happen for sha256, but defensive), suffix "-2".
    let finalPath = absPath;
    try {
      const st = await stat(absPath);
      if (st.size !== r.body.length) {
        finalPath = join(hostDir, `${sha}-2.${ext}`);
      }
    } catch {
      // ENOENT is fine — new file.
    }
    // blue M-3 (2026-04-20): tmp + rename で atomic write。plain writeFile だと
    // SIGKILL / ディスク full 中断時に 0-byte or 半端な画像が media/ に残留し、
    // Vault の git push で壊れた画像が commit される。同 FS rename なので原子的。
    await atomicWriteBinary(finalPath, r.body);
    const localRelative = `media/${host}/${finalPath.split('/').pop()}`;
    seen.set(src, localRelative);
    images.push({
      src,
      alt: img.alt,
      localPath: localRelative,
      sha256: sha,
      size: r.body.length,
    });
  }
  return { images, warnings };
}

// Atomic write for binary blobs (blue M-3, 2026-04-20).
// Same-FS rename to avoid cross-device linking. tmp filename includes pid +
// ms + random suffix so concurrent writers on the same final path don't clash
// (O_EXCL ensures open-time uniqueness).
async function atomicWriteBinary(absPath, body) {
  const nonce = randomBytes(4).toString('hex');
  const tmp = `${absPath}.tmp.${process.pid}.${Date.now()}.${nonce}`;
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(body);
  } finally {
    await fh.close();
  }
  await rename(tmp, absPath);
}

/**
 * Replace image src in Markdown with local relative paths.
 * Leaves unknown mappings untouched. Preserves optional `"title"` suffix.
 *
 * @param {string} markdown
 * @param {Map<string, string>} mapping — absolute URL → local relative path
 * @param {string} baseUrl — for resolving relative src in markdown
 * @returns {string}
 */
export function rewriteImageSrc(markdown, mapping, baseUrl) {
  return markdown.replace(/!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (match, alt, src, title) => {
    let absUrl;
    try {
      absUrl = new URL(src, baseUrl).href;
    } catch {
      return match;
    }
    const localPath = mapping.get(absUrl);
    if (!localPath) return match;
    return `![${alt}](${localPath}${title || ''})`;
  });
}
