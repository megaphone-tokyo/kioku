// url-extract.mjs — URL 取得から raw-sources/<subdir>/fetched/<slug>.md 保存までの orchestrator
//
// 設計書 §4.2 §4.6 §6 — idempotency + refresh_days + frontmatter を 1 関数に集約。
//
// ハードニング方針 (plan p3 Task 5.2 指示書):
//   H1. assertInsideRawSourcesSubdir で subdir injection (例: "../wiki") と
//       realpath+boundary check を強制する。
//   H2. parseFrontmatter / serializeFrontmatter を使い、正規表現ベースの
//       frontmatter パーサと手製 YAML string builder を廃止する。
//   H3. atomicWrite は最終書き込み先と同じディレクトリ (= 境界検査済) で
//       tmpfile → rename。
//   H4. subdir のデフォルトは 'articles'。任意値の受け入れは呼び出し側 (Phase 7)。
//   H5. not_html error に pdfCandidate + fetchResult を付与して Phase 7 に橋渡し。

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import { fetchUrl } from './url-fetch.mjs';
import { checkRobots } from './robots-check.mjs';
import { extractArticle } from './readability-extract.mjs';
import { htmlToMarkdown } from './html-to-markdown.mjs';
import { downloadImages, rewriteImageSrc } from './url-image.mjs';
import { llmFallbackExtract } from './llm-fallback.mjs';
import { urlToFilename } from './url-filename.mjs';
import { applyMasks } from './masking.mjs';
import { assertInsideRawSourcesSubdir } from './vault-path.mjs';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.mjs';

function envRefreshDaysDefault() {
  const raw = process.env.KIOKU_URL_REFRESH_DAYS;
  if (raw === undefined || raw === '') return 30;
  if (raw === 'never') return 'never';
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

/**
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.vault
 * @param {string} [opts.subdir='articles']
 * @param {number|string} [opts.refreshDays]
 * @param {string} [opts.title]
 * @param {string} [opts.sourceType='article']
 * @param {string[]} [opts.tags]
 * @param {string} [opts.robotsUrlOverride]
 * @param {string} [opts.claudeBin]
 * @returns {Promise<{status: string, path: string, source_sha256: string, url: string, fallback_used?: string, images?: string[], warnings?: string[]}>}
 */
export async function extractAndSaveUrl(opts) {
  const {
    url,
    vault,
    subdir = 'articles',
    title: titleOverride,
    sourceType = 'article',
    tags = [],
    robotsUrlOverride,
    claudeBin,
  } = opts;
  // refreshDays の扱い:
  //   - 明示指定が無い場合は default を保存時の frontmatter 値に使うが、早期 skip には
  //     使わない (= 毎回 fetch して sha 比較)。呼び出し側がリフレッシュ間隔を意図的に
  //     指定した場合のみ fetch を省略する (UI9/11/13/14 の組み合わせを満たすため)。
  const refreshDaysExplicit = Object.prototype.hasOwnProperty.call(opts, 'refreshDays');
  const refreshDays = refreshDaysExplicit ? opts.refreshDays : envRefreshDaysDefault();

  // 1. robots.txt
  await checkRobots(url, { robotsUrlOverride });

  // 2. 境界検査済の最終書き込みパスを決定する。
  //    assertInsideRawSourcesSubdir は realpath ベースなので base (fetched/) を
  //    先に mkdir -p してから呼ぶ必要がある (H1 の手順)。
  const filename = urlToFilename(url);
  const fetchedAbs = join(vault, 'raw-sources', subdir, 'fetched');
  await mkdir(fetchedAbs, { recursive: true, mode: 0o700 });
  const finalAbs = await assertInsideRawSourcesSubdir(vault, subdir, `fetched/${filename}`);
  // 返却用の vault-relative path は入力から組み立てる (realpath 変換をかけない —
  // symlink 下でのブレを避けるため)。fs 操作はすべて finalAbs 経由で行う。
  const relativePath = `raw-sources/${subdir}/fetched/${filename}`;

  // 3. refresh_days 早期判定 — refreshDays が明示指定されたときだけ有効。
  //    デフォルト (呼び出し側が未指定) の場合は fetch して sha 比較に委ねる。
  const existingFrontmatter = await tryReadFrontmatter(finalAbs);
  if (
    refreshDaysExplicit
    && existingFrontmatter
    && shouldSkipBasedOnRefresh(existingFrontmatter, refreshDays)
  ) {
    const status = isNeverPolicy(refreshDays, existingFrontmatter) ? 'skipped_never' : 'skipped_within_refresh';
    return {
      status,
      path: relativePath,
      source_sha256: existingFrontmatter.source_sha256,
      url,
    };
  }

  // 4. fetch
  const fetchResult = await fetchUrl(url, {
    accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9',
  });

  // 5. Content-Type 分岐 — HTML 以外は呼び出し元 (ingest-url.mjs Phase 7) で
  //    PDF dispatch 等を判断させる。H5: fetchResult を添付して投げ直す。
  const ct = (fetchResult.contentType || '').toLowerCase();
  if (!ct.includes('text/html') && !ct.includes('application/xhtml+xml')) {
    const err = new Error(`not HTML: ${ct}`);
    err.code = 'not_html';
    err.pdfCandidate = ct.includes('application/pdf');
    err.fetchResult = fetchResult;
    throw err;
  }

  // 6. Readability → 不足なら LLM fallback
  const extracted = extractArticle(fetchResult.body, fetchResult.finalUrl);
  let markdown;
  let fallbackUsed;
  if (extracted.needsFallback) {
    const fb = await llmFallbackExtract({
      html: fetchResult.body,
      url: fetchResult.finalUrl,
      cacheDir: join(vault, '.cache', 'tmp'),
      claudeBin,
    });
    if (!fb.success) {
      const err = new Error(`extraction failed: ${fb.error}`);
      err.code = 'extraction_failed';
      throw err;
    }
    markdown = fb.markdown;
    fallbackUsed = 'llm_fallback';
  } else {
    markdown = htmlToMarkdown(extracted.content);
    fallbackUsed = 'readability';
  }

  // 7. 画像 DL + rewrite (media/ は fetchedAbs 配下)
  const imgs = extractImgTags(fetchResult.body);
  const mediaDir = join(fetchedAbs, 'media');
  const { images, warnings } = await downloadImages(imgs, {
    baseUrl: fetchResult.finalUrl,
    mediaDir,
  });
  const mapping = new Map();
  for (const img of images) {
    try {
      mapping.set(new URL(img.src, fetchResult.finalUrl).href, img.localPath);
    } catch {
      // 無効 URL はマッピングせず本文中に残す (rewriteImageSrc は mapping miss を
      // そのまま保持する)
    }
  }
  markdown = rewriteImageSrc(markdown, mapping, fetchResult.finalUrl);

  // 8. MASK_RULES — sha256 計算前に適用する (idempotency キーがマスク後の本文)
  markdown = applyMasks(markdown);

  // 9. sha256 (body のみ。frontmatter は含めない)
  const sha = createHash('sha256').update(markdown, 'utf8').digest('hex');

  // 10. idempotency: sha 一致なら内容は上書きせず、fetched_at のみ bump
  if (existingFrontmatter && existingFrontmatter.source_sha256 === sha) {
    if (refreshDays === 'never') {
      return { status: 'skipped_never', path: relativePath, source_sha256: sha, url };
    }
    await bumpFetchedAt(finalAbs);
    return { status: 'skipped_same_sha', path: relativePath, source_sha256: sha, url };
  }

  // 11. frontmatter を組んで atomic write。
  //     serializeFrontmatter は文字列を安全な場合にベア出力するが、本プロジェクトの
  //     frontmatter 既存規約 (write-note/write-wiki テンプレ) に揃えて文字列は
  //     常にダブルクォートで括る。JSON.stringify 同等のエスケープのみを使う
  //     (YAML double-quoted string は JSON string のスーパーセット)。
  const finalTitle = titleOverride || extracted.title || filename.replace(/\.md$/, '');
  const frontmatterObj = buildFrontmatterObject({
    title: finalTitle,
    source_type: sourceType,
    source_url: url,
    source_final_url: fetchResult.finalUrl,
    source_host: new URL(fetchResult.finalUrl).hostname,
    source_sha256: sha,
    fetched_at: new Date().toISOString(),
    fetched_by: 'kioku-ingest-url',
    fallback_used: fallbackUsed,
    byline: extracted.byline,
    site_name: extracted.siteName,
    published_time: extracted.publishedTime,
    og_image: extracted.ogImage,
    image_count: images.length,
    truncated: fetchResult.truncated,
    refresh_days: refreshDays,
    tags,
    warnings,
  });
  const content = serializeWithQuotedStrings(frontmatterObj, `\n${markdown}\n`);
  await atomicWrite(finalAbs, content);

  // 12. raw HTML を .cache/html/ に保存 (Phase 8 で再抽出・debug 用途)
  // NOTE (code-quality MEDIUM-1): assertInsideRawSourcesSubdir は raw-sources/ 境界のみを
  // 保証するので .cache/html/ には使えない。代わりに htmlFilename の安全性は
  // urlToFilename (url-filename.mjs) の sanitizer に依存している:
  //   - path 区切り (/, ..) は全て `-` に置換、SAFE_PATH_RE (\p{L}\p{N}/._ -) 互換
  //   - 先頭 `-` 除去、80 文字超過で truncate + sha8 suffix
  // urlToFilename を変更する際は、この write path も boundary-check (例: assertInsideVault) を
  // 導入するか、ここで同等の regex-validate を加える必要がある。
  const htmlCacheDir = join(vault, '.cache', 'html');
  await mkdir(htmlCacheDir, { recursive: true, mode: 0o700 });
  const htmlFilename = filename.replace(/\.md$/, '.html');
  await atomicWrite(join(htmlCacheDir, htmlFilename), fetchResult.body);

  return {
    status: 'fetched_and_summarized_pending',
    path: relativePath,
    source_sha256: sha,
    url,
    fallback_used: fallbackUsed,
    images: images.map((i) => i.localPath),
    warnings,
  };
}

// ---- helpers ----------------------------------------------------------

function extractImgTags(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const imgs = [];
  for (const el of doc.querySelectorAll('img')) {
    const src = el.getAttribute('src');
    if (!src) continue;
    imgs.push({ src, alt: el.getAttribute('alt') || '' });
  }
  return imgs;
}

// H2: parseFrontmatter を使う。読み込めない / frontmatter が無い場合は null。
async function tryReadFrontmatter(absPath) {
  try {
    const content = await readFile(absPath, 'utf8');
    const { data } = parseFrontmatter(content);
    if (!data || Object.keys(data).length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

function isNeverPolicy(refreshDays, fm) {
  return refreshDays === 'never' || fm?.refresh_days === 'never';
}

function shouldSkipBasedOnRefresh(fm, refreshDays) {
  if (!fm.source_sha256) return false;
  if (isNeverPolicy(refreshDays, fm)) return true;
  if (!fm.fetched_at) return false;
  const fetchedTime = Date.parse(fm.fetched_at);
  if (Number.isNaN(fetchedTime)) return false;
  // Clock-skew guard (code-quality HIGH-2): 2 台 Mac で NTP 差があると
  // fetched_at が未来時刻で保存され、ageMs が負になり「refreshMs 未満」で
  // 永続 skip してしまう。max(0, ...) で「即 refetch」扱いにする。
  const ageMs = Math.max(0, Date.now() - fetchedTime);
  const days = typeof refreshDays === 'number' ? refreshDays : Number(refreshDays);
  if (!Number.isFinite(days) || days < 0) return false;
  const refreshMs = days * 24 * 3600 * 1000;
  return ageMs < refreshMs;
}

async function bumpFetchedAt(absPath) {
  try {
    const content = await readFile(absPath, 'utf8');
    const { data, body } = parseFrontmatter(content);
    if (!data || Object.keys(data).length === 0) return;
    data.fetched_at = new Date().toISOString();
    const next = serializeWithQuotedStrings(data, body);
    await atomicWrite(absPath, next);
  } catch {
    // best effort — idempotency は sha で保証されているので fetched_at 更新失敗は致命ではない
  }
}

// 値が空 / null / undefined / 空配列は出力オブジェクトから除外する。
// insertion order がそのまま出力順になるので、呼び出し側で欲しい順に set する。
//
// MED-4 (code-quality 2026-04-19): user-controlled / HTML-derived 文字列値は
// applyMasks を通してから書き出す。tags / title / byline / site_name / source_type を
// frontmatter に load する経路は今まで mask gate を通っていなかった (本文 markdown 側のみ)。
// Vault が GitHub Private repo に push されるため、frontmatter の secret leak は
// commit history に永久残留する。マスクは idempotent なので 2 回適用しても無害。
function buildFrontmatterObject(fields) {
  const out = {};
  const setStr = (key, val) => {
    if (val === null || val === undefined || val === '') return;
    out[key] = applyMasks(String(val));
  };
  const setRaw = (key, val) => {
    if (val === null || val === undefined || val === '') return;
    if (Array.isArray(val) && val.length === 0) return;
    out[key] = val;
  };
  // user / HTML-derived: mask
  setStr('title', fields.title);
  setStr('source_type', fields.source_type);
  // source_url は validateUrl で embedded credentials を事前 reject 済だが
  // red M-1 fix (2026-04-20): source_final_url / source_host も attacker-controlled な
  // redirect chain 由来のため applyMasks を通す (mask は idempotent)。
  setRaw('source_url', fields.source_url);
  if (fields.source_final_url && fields.source_final_url !== fields.source_url) {
    setStr('source_final_url', fields.source_final_url);
  }
  setStr('source_host', fields.source_host);
  setRaw('source_sha256', fields.source_sha256);
  setRaw('fetched_at', fields.fetched_at);
  setRaw('fetched_by', fields.fetched_by);
  setRaw('fallback_used', fields.fallback_used);
  // HTML から拾う meta — Readability 経由で site の指定文字列がそのまま入りうる
  setStr('byline', fields.byline);
  setStr('site_name', fields.site_name);
  // red M-1 fix (2026-04-20): published_time / og_image は <meta> tag content 属性の
  // raw 文字列。攻撃ページが `content="2024-01-01; ghp_..."` のように secret-shaped
  // 文字列を含められる → mask 必須 (mask は idempotent)。
  setStr('published_time', fields.published_time);
  setStr('og_image', fields.og_image);
  if (typeof fields.image_count === 'number') out.image_count = fields.image_count;
  if (typeof fields.truncated === 'boolean') out.truncated = fields.truncated;
  if (fields.refresh_days !== undefined && fields.refresh_days !== null) {
    out.refresh_days = fields.refresh_days;
  }
  // tags は user-controlled 文字列。MED-4 fix: 各要素を applyMasks で sanitize する。
  if (Array.isArray(fields.tags) && fields.tags.length > 0) {
    out.tags = fields.tags.map((t) => (typeof t === 'string' ? applyMasks(t) : t));
  }
  // warnings は内部生成 (downloadImages の結果) だが念のため通す。
  if (Array.isArray(fields.warnings) && fields.warnings.length > 0) {
    out.warnings = fields.warnings.map((w) => (typeof w === 'string' ? applyMasks(w) : w));
  }
  return out;
}

// 文字列値を常にダブルクォートで括った形で frontmatter を出力する。
// - 配列は要素ごとに JSON.stringify (string) / String (非 string) で直列化
// - number / boolean はそのまま
// - null / undefined は key: (空値) として出力 (呼び出し側で除外済前提だが保険)
// JSON.stringify が生成する double-quoted 形式は YAML double-quoted スカラーの
// 部分集合として有効 (ASCII 制御・非 ASCII は \uXXXX エスケープ)。
// 本プロジェクトの YAML 再パース側 (frontmatter.mjs) も JSON.parse 互換の
// strip quote + raw 取り込みで済むので round-trip が維持される。
function serializeWithQuotedStrings(data, body = '') {
  const lines = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) {
      lines.push(`${k}:`);
    } else if (Array.isArray(v)) {
      const items = v.map((x) => (typeof x === 'string' ? JSON.stringify(x) : String(x)));
      lines.push(`${k}: [${items.join(', ')}]`);
    } else if (typeof v === 'boolean' || typeof v === 'number') {
      lines.push(`${k}: ${v}`);
    } else {
      lines.push(`${k}: ${JSON.stringify(String(v))}`);
    }
  }
  const yaml = lines.join('\n') + '\n';
  const bodyClean = body.startsWith('\n') ? body.substring(1) : body;
  return `---\n${yaml}---\n${bodyClean}`;
}

// H3: tmpfile は最終ディレクトリと同じ場所に作る (境界を跨がない)。
async function atomicWrite(absPath, content) {
  const dir = dirname(absPath);
  const tmp = join(dir, `.${basename(absPath)}.tmp.${process.pid}.${Date.now()}`);
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
  await rename(tmp, absPath);
}
