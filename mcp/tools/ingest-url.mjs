// kioku_ingest_url — 機能 2.2 MCP tool。
//
// 設計書: plan/claude/26041801_feature-2-2-html-url-ingest-design.md §4.1 §4.7
// フロー:
//   1. URL バリデーション (SSRF / scheme / credentials) — withLock の外で先行 reject
//   2. withLock(vault) — cron auto-ingest.sh / kioku_ingest_pdf と `.kioku-mcp.lock` を共有
//   3. fetch (binary mode) で Content-Type 判定 + PDF size cap
//   4. robots.txt を確認 (defense-in-depth: HTML 経路では extractAndSaveUrl 内でも再評価)
//   5. Content-Type 分岐:
//        text/html / application/xhtml+xml → extractAndSaveUrl に委譲
//        application/pdf / (octet-stream + URL末尾.pdf) → handleIngestPdf に skipLock=true で dispatch
//   6. extractAndSaveUrl が後段で PDF を検知 (リダイレクト先が PDF だった等) した場合も
//      err.code === 'not_html' && err.pdfCandidate === true で PDF 経路に rerouting。
//      この時 extractAndSaveUrl の fetch は **非バイナリ** なので body は UTF-8 文字列で
//      PDF を保持できない。late-PDF 経路では必ず再 fetch (binary:true) する (CRIT-1)。
//   7. 結果 JSON を返す
//
// セキュリティ要点:
//   - 外側で URL validation (validateUrl) を済ませてから lock 取得
//   - PDF body 上限 (KIOKU_URL_MAX_PDF_BYTES, 既定 50MB) は positive-int clamp で 0/不正値を弾く
//   - PDF 書き込み先は assertInsideRawSourcesSubdir で raw-sources/<subdir>/ 境界に強制
//   - urlToFilename + 0o600 atomic write (tmp + rename)
//   - subdir sanitize は SAFE_PATH_RE (vault-path.mjs) 互換の文字集合に絞る (silent
//     mangling は禁止 — 不正値は MED-1 で reject)
//   - エラー文字列に attacker-controlled URL / 内部 IP / credentials を載せない
//     (HIGH-2: prompt-injection / SSRF info leak 対策)。code-only で MCP 境界を渡す。

import { mkdir, open, rename } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { withLock } from '../lib/lock.mjs';
import { checkRobots, RobotsError } from '../lib/robots-check.mjs';
import { envPositiveInt } from '../lib/env-helpers.mjs';
import { extractAndSaveUrl } from '../lib/url-extract.mjs';
import { fetchUrl, FetchError } from '../lib/url-fetch.mjs';
import { urlToFilename } from '../lib/url-filename.mjs';
import { UrlSecurityError, validateUrl } from '../lib/url-security.mjs';
import { assertInsideRawSourcesSubdir } from '../lib/vault-path.mjs';
import { handleIngestPdf } from './ingest-pdf.mjs';

const LOCK_TTL_MS = 1_800_000; // 30 分 (auto-ingest.sh と整合)
const LOCK_ACQUIRE_TIMEOUT_MS = 60_000;
const DEFAULT_PDF_BYTES_FALLBACK = 50_000_000;
const DEFAULT_REFRESH_DAYS_FALLBACK = 30;

// HIGH-1 fix (2026-04-19): KIOKU_URL_ALLOW_LOOPBACK=1 が production に leak した
// 場合の早期警告。MCP child 経由 (KIOKU_MCP_CHILD=1) または NODE_ENV=test では抑制。
// MED-d1 fix (2026-04-20): KIOKU_URL_IGNORE_ROBOTS にも同等の WARN を追加
//   (旧実装では silent だったため production leak に気付けなかった)。
// MED-d3 fix (2026-04-20): stderr は MCP stdio や cron ログに埋没しがちなので、
//   検知時に `$VAULT/.kioku-alerts/<flag>.flag` に timestamp ファイルを置き、
//   auto-lint.sh の自己診断 / スモーク手順がこれを拾えるようにする。
function warnAndFlag(envVar, message) {
  if (process.env.KIOKU_MCP_CHILD === '1' || process.env.NODE_ENV === 'test') return;
  process.stderr.write(`[kioku-mcp] WARNING: ${message}\n`);
  // best-effort flag file. OBSIDIAN_VAULT 未設定や write 失敗は silent pass
  // (起動経路で失敗しても MCP 本体は動く前提を崩さない)。
  try {
    const vault = process.env.OBSIDIAN_VAULT;
    if (!vault) return;
    const dir = join(vault, '.kioku-alerts');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const flagPath = join(dir, `${envVar.toLowerCase()}.flag`);
    writeFileSync(flagPath, `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

if (process.env.KIOKU_URL_ALLOW_LOOPBACK === '1') {
  warnAndFlag(
    'KIOKU_URL_ALLOW_LOOPBACK',
    'KIOKU_URL_ALLOW_LOOPBACK=1 detected outside test/MCP-child context — SSRF IP-range checks are bypassed.',
  );
}
if (process.env.KIOKU_URL_IGNORE_ROBOTS === '1') {
  warnAndFlag(
    'KIOKU_URL_IGNORE_ROBOTS',
    'KIOKU_URL_IGNORE_ROBOTS=1 detected outside test/MCP-child context — robots.txt is ignored.',
  );
}

// env footgun guard は ../lib/env-helpers.mjs の envPositiveInt を使用。
// Number("0") === 0 / NaN / 負値はフォールバック (0 を "上限なし" に解釈する fail-open を防ぐ)。

function getMaxPdfBytes() {
  return envPositiveInt('KIOKU_URL_MAX_PDF_BYTES', DEFAULT_PDF_BYTES_FALLBACK);
}

function getDefaultRefreshDays() {
  // refresh_days は 'never' を文字列で許容するため独自に処理する。
  const raw = process.env.KIOKU_URL_REFRESH_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_REFRESH_DAYS_FALLBACK;
  if (raw === 'never') return 'never';
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_REFRESH_DAYS_FALLBACK;
  return Math.floor(n);
}

export const INGEST_URL_TOOL_DEF = {
  name: 'kioku_ingest_url',
  title: 'Fetch a URL and ingest into KIOKU Wiki (synchronous)',
  description:
    'Fetch an HTTP/HTTPS URL, extract the article body (Mozilla Readability; LLM fallback for hard layouts), '
    + 'save the Markdown under raw-sources/<subdir>/fetched/, download inline images to '
    + 'raw-sources/<subdir>/fetched/media/, and let the next auto-ingest cycle produce a wiki summary. '
    + 'If the URL serves a PDF (Content-Type: application/pdf or URL ending in .pdf), the tool '
    + 'dispatches to kioku_ingest_pdf automatically. '
    + 'Use when the user asks to "read this URL", "save this article", or pastes a link to remember.',
  inputShape: {
    url: z.string().min(1).max(2048),
    subdir: z.string().min(1).max(64).optional(),
    title: z.string().max(200).optional(),
    source_type: z.string().max(64).optional(),
    tags: z.array(z.string().min(1).max(32)).max(16).optional(),
    refresh_days: z.union([z.number().int().min(1).max(3650), z.literal('never')]).optional(),
    max_turns: z.number().int().min(1).max(120).optional(),
  },
};

/**
 * @param {string} vault
 * @param {{url: string, subdir?: string, title?: string, source_type?: string, tags?: string[], refresh_days?: number|'never', max_turns?: number}} args
 * @param {{claudeBin?: string, robotsUrlOverride?: string, skipLock?: boolean}} [injections]
 *   skipLock: WARNING — only set true when the caller already holds withLock(vault, ...).
 *   Used internally by the late-PDF dispatch path; do not pass from external callers.
 */
export async function handleIngestUrl(vault, args, injections = {}) {
  validate(args);
  const url = String(args.url);

  // 1. SSRF / scheme / credentials の早期 reject。
  //    KIOKU_URL_ALLOW_LOOPBACK=1 でも scheme/creds/null の最低限は強制する (HIGH-1):
  //    flag が production に leak しても file:// や user:pass@... を素通しさせない。
  validateUrlWithLoopbackOption(url);

  // subdir sanitize: SAFE_PATH_RE (vault-path.mjs) 互換。Letter / Number / _ / - のみ許容。
  // MED-1 fix: silent mangling ("my notes" → "mynotes") を廃止し、不正値は reject。
  // ユーザーに「subdir が黙って書き換わった」事故を起こさない。
  const subdirRaw = args.subdir ?? 'articles';
  if (!/^[\p{L}\p{N}_-]+$/u.test(subdirRaw)) {
    throwInvalidParams(
      'subdir must be Unicode letters/digits/_/- only (no spaces or punctuation)',
    );
  }
  const subdir = subdirRaw;

  const inner = async () => {
    // 2. fetch (binary 必須 — body を PDF として保存する可能性がある)。
    //    maxBytes は PDF cap と最低 5MB の大きい方。HTML はこれより遥かに小さいので影響なし。
    const maxPdfBytes = getMaxPdfBytes();
    let fetchResult;
    try {
      fetchResult = await fetchUrl(url, {
        accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5',
        maxBytes: Math.max(maxPdfBytes, 5_000_000),
        binary: true,
      });
    } catch (err) {
      mapFetchErrorAndThrow(err);
    }

    // 3. robots.txt — fetch 後に評価する (storage gating)。
    //    HTML 経路では extractAndSaveUrl が再度 checkRobots を呼ぶが、PDF 経路では
    //    extractAndSaveUrl を経由しないので、この関数自身で必ず評価する必要がある。
    //    コストは robots.txt のキャッシュ無し re-fetch 1 回分 (高々数 KB) で defense-in-depth。
    try {
      await checkRobots(url, { robotsUrlOverride: injections.robotsUrlOverride });
    } catch (err) {
      // HIGH-2: robots エラーメッセージに URL path を含めない (attacker-controlled)
      if (err instanceof RobotsError) throwInvalidRequest(`robots rejected: ${err.code || 'disallow'}`);
      throw err;
    }

    // 4. Content-Type 分岐
    //    URL pathname 末尾の拡張子は <pathname>.pdf (大小無視) を判定する。
    //    クエリ部に `.pdf` が含まれていても fixture 名を渡しているだけのことが多いので
    //    pathname 限定で評価する (設計書 §4.7 step 2 "URL path 末尾が .pdf")。
    const ct = (fetchResult.contentType || '').toLowerCase();
    let pathnameEndsPdf = false;
    try {
      pathnameEndsPdf = /\.pdf$/i.test(new URL(fetchResult.finalUrl || url).pathname);
    } catch {
      // unreachable — fetchUrl が成功していれば finalUrl は valid のはず。
      // 万一 throw された場合は false のまま (octet-stream PDF 判定が false に倒れるだけ)。
    }
    const isPdf =
      ct.includes('application/pdf')
      || ct.includes('application/x-pdf')
      || ((ct.includes('application/octet-stream') || ct === '') && pathnameEndsPdf);

    if (isPdf) {
      if (fetchResult.truncated) {
        // 50MB cap で切り詰められた → 実体は cap 超過。記録より破棄を優先。
        throwInvalidRequest('PDF exceeds size cap');
      }
      // PDF の既定 subdir は 'papers' (機能 2 の PDF 配置規約と整合)。
      // ユーザーが明示的に subdir を指定した場合はそれを尊重する。
      const pdfSubdir = (args.subdir == null) ? 'papers' : subdir;
      return await dispatchToPdf({
        vault,
        subdir: pdfSubdir,
        url,
        body: fetchResult.body,
        claudeBin: injections.claudeBin,
      });
    }

    if (!ct.includes('text/html') && !ct.includes('application/xhtml+xml')) {
      // HIGH-2 LOW-5 (note): Content-Type は server 制御だが ASCII 制御文字を
      // 取り除いて 100 文字に切り詰めてから露出する。
      throwInvalidRequest(`unsupported content-type: ${sanitizeForError(ct) || '(none)'}`);
    }

    // 5. HTML → orchestrator に委譲。refresh_days は呼び出し引数 > env > default。
    const refreshDays = args.refresh_days ?? getDefaultRefreshDays();
    try {
      const r = await extractAndSaveUrl({
        url,
        vault,
        subdir,
        refreshDays,
        title: args.title,
        sourceType: args.source_type,
        tags: args.tags ?? [],
        robotsUrlOverride: injections.robotsUrlOverride,
        claudeBin: injections.claudeBin,
      });
      return { ...r, url };
    } catch (err) {
      // CRIT-1: late-PDF discovery — extractAndSaveUrl は **非バイナリ** で fetch するため
      // err.fetchResult.body は UTF-8 文字列。PDF バイト列は U+FFFD に化けて壊れる。
      // 必ず binary:true で再 fetch してから dispatch する。
      if (err && err.code === 'not_html' && err.pdfCandidate) {
        let refetch;
        try {
          refetch = await fetchUrl(url, {
            accept: 'application/pdf,*/*;q=0.5',
            maxBytes: Math.max(getMaxPdfBytes(), 5_000_000),
            binary: true,
          });
        } catch (refetchErr) {
          mapFetchErrorAndThrow(refetchErr);
        }
        if (refetch.truncated) {
          throwInvalidRequest('PDF exceeds size cap');
        }
        const pdfSubdir = (args.subdir == null) ? 'papers' : subdir;
        return await dispatchToPdf({
          vault,
          subdir: pdfSubdir,
          url,
          body: refetch.body,
          claudeBin: injections.claudeBin,
        });
      }
      // HIGH-2: extractAndSaveUrl 由来のエラーも raw message を漏らさず code only で返す
      if (err && err.code === 'extraction_failed') throwInternal(`extraction failed: ${err.code}`);
      if (err && err.code === 'robots_disallow') throwInvalidRequest(`robots: ${err.code}`);
      throw err;
    }
  };

  if (injections.skipLock) {
    return await inner();
  }
  return withLock(vault, inner, { ttlMs: LOCK_TTL_MS, timeoutMs: LOCK_ACQUIRE_TIMEOUT_MS });
}

// ----- helpers ---------------------------------------------------------------

// HIGH-1: KIOKU_URL_ALLOW_LOOPBACK=1 でも scheme/creds/null の最低限は強制する。
// flag は IP-range check (loopback / private / link-local) のみを skip する目的なので、
// それ以外の入口防御は loopback bypass 時にも残す。
function validateUrlWithLoopbackOption(url) {
  if (process.env.KIOKU_URL_ALLOW_LOOPBACK === '1') {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throwInvalidParams('URL malformed');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throwInvalidParams('scheme not allowed');
    }
    if (parsed.username || parsed.password) {
      throwInvalidParams('URL credentials not allowed');
    }
    if (url.includes('\0')) throwInvalidParams('URL contains null byte');
    return;
  }
  try {
    validateUrl(url);
  } catch (err) {
    if (err instanceof UrlSecurityError) throwInvalidParams(`URL rejected: ${err.code || 'invalid'}`);
    throw err;
  }
}

// HIGH-2: FetchError.message は attacker-controlled URL / 内部 IP / credentials を含みうる
// (例: "credentials in URL: http://user:pass@..." / "resolved IP is private: foo → 10.0.0.5" /
//     "HTTPS → HTTP downgrade: <attacker URL>"). MCP 境界では code only で返す。
function mapFetchErrorAndThrow(err) {
  if (err instanceof UrlSecurityError) {
    throwInvalidParams(`URL rejected: ${err.code || 'invalid'}`);
  }
  if (err instanceof FetchError) {
    if (
      err.code === 'auth_required'
      || err.code === 'redirect_limit'
      || err.code === 'scheme_downgrade'
      || err.code === 'redirect_invalid'
      || err.code === 'url_credentials'
      || err.code === 'url_scheme'
      || err.code === 'url_loopback'
      || err.code === 'url_private_ip'
      || err.code === 'url_link_local'
      || err.code === 'url_localhost'
      || err.code === 'url_non_standard_ip'
      || err.code === 'dns_private'
    ) {
      throwInvalidRequest(`fetch rejected: ${err.code}`);
    }
    if (err.code === 'not_found') throwNotFound(`fetch failed: ${err.code}`);
    throwFetchFailed(`fetch failed: ${err.code || 'network_error'}`);
  }
  throw err;
}

// LOW-5 (handoff #13): Content-Type は server 制御の文字列。stderr / 構造化応答に
// 載せる前に ASCII 制御文字を取り除き、100 文字で truncate する (UI / log で安全)。
function sanitizeForError(s) {
  if (typeof s !== 'string') return '';
  const cleaned = s.replace(/[\x00-\x1f\x7f]/g, '');
  return cleaned.length > 100 ? `${cleaned.slice(0, 100)}…` : cleaned;
}

async function dispatchToPdf({ vault, subdir, url, body, claudeBin }) {
  if (!body) throwInternal('PDF body missing for dispatch');
  // urlToFilename は <host>-<slug>.md を返すので拡張子だけ差し替える。
  const name = urlToFilename(url).replace(/\.md$/, '.pdf');
  const pdfDir = join(vault, 'raw-sources', subdir);
  await mkdir(pdfDir, { recursive: true, mode: 0o700 });

  // defense-in-depth: urlToFilename は sanitizer を持つが、ここでも raw-sources/<subdir>/
  // 配下に解決されることを realpath ベースで再確認する。
  const absPath = await assertInsideRawSourcesSubdir(vault, subdir, name);

  // atomic write — tmp は同一ディレクトリで作成 (rename の同一 FS 保証)。
  const tmp = `${absPath}.tmp.${process.pid}.${Date.now()}`;
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(body);
  } finally {
    await fh.close();
  }
  await rename(tmp, absPath);

  // 内側 handleIngestPdf に dispatch — 外側で withLock を保持済みなので skipLock=true。
  const pdfResult = await handleIngestPdf(
    vault,
    { path: `raw-sources/${subdir}/${name}` },
    { claudeBin, skipLock: true },
  );
  return {
    status: 'dispatched_to_pdf',
    url,
    path: `raw-sources/${subdir}/${name}`,
    pdf_result: pdfResult,
  };
}

// MED-3: validate() は test 等で Zod を bypass して直接呼ばれるパス用。Zod schema の
// 制約 (max length / array size / int range) を runtime にも複製して silent overrun を防ぐ。
function validate(args) {
  if (!args || typeof args !== 'object') throwInvalidParams('args must be an object');
  if (typeof args.url !== 'string' || !args.url.trim()) throwInvalidParams('url required');
  if (args.url.includes('\0')) throwInvalidParams('url contains null byte');
  if (args.url.length > 2048) throwInvalidParams('url too long (max 2048)');
  if (args.subdir != null) {
    if (typeof args.subdir !== 'string') throwInvalidParams('subdir must be a string');
    if (args.subdir.includes('\0')) throwInvalidParams('subdir contains null byte');
    if (args.subdir.length < 1 || args.subdir.length > 64) {
      throwInvalidParams('subdir length must be 1..64');
    }
  }
  if (args.title != null) {
    if (typeof args.title !== 'string') throwInvalidParams('title must be a string');
    if (args.title.length > 200) throwInvalidParams('title too long (max 200)');
  }
  if (args.source_type != null) {
    if (typeof args.source_type !== 'string') {
      throwInvalidParams('source_type must be a string');
    }
    if (args.source_type.length > 64) throwInvalidParams('source_type too long (max 64)');
  }
  if (args.tags != null) {
    if (!Array.isArray(args.tags)) throwInvalidParams('tags must be an array');
    if (args.tags.length > 16) throwInvalidParams('tags must be at most 16 entries');
    for (const t of args.tags) {
      if (typeof t !== 'string') throwInvalidParams('tags must be strings');
      if (t.length < 1 || t.length > 32) throwInvalidParams('tag length must be 1..32');
    }
  }
  if (args.refresh_days != null) {
    const ok =
      (typeof args.refresh_days === 'number'
        && Number.isInteger(args.refresh_days)
        && args.refresh_days >= 1
        && args.refresh_days <= 3650)
      || args.refresh_days === 'never';
    if (!ok) throwInvalidParams('refresh_days must be integer 1..3650 or "never"');
  }
  if (args.max_turns != null) {
    const ok =
      typeof args.max_turns === 'number'
      && Number.isInteger(args.max_turns)
      && args.max_turns >= 1
      && args.max_turns <= 120;
    if (!ok) throwInvalidParams('max_turns must be integer 1..120');
  }
}

function throwInvalidParams(msg) {
  const e = new Error(msg);
  e.code = 'invalid_params';
  throw e;
}
function throwInvalidRequest(msg) {
  const e = new Error(msg);
  e.code = 'invalid_request';
  throw e;
}
function throwNotFound(msg) {
  const e = new Error(msg);
  e.code = 'not_found';
  throw e;
}
function throwFetchFailed(msg) {
  const e = new Error(msg);
  e.code = 'fetch_failed';
  throw e;
}
function throwInternal(msg) {
  const e = new Error(msg);
  e.code = 'internal_error';
  throw e;
}
