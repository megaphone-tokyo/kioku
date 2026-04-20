// urls-txt-parser.mjs — raw-sources/<subdir>/urls.txt の行をパース
//
// 形式:
//   URL [; key=value [; key=value ...]]
//   # コメント (行全体、または行途中の ' #' 以降)
//
// サポート key:
//   tags          — カンマ区切りのタグ
//   title         — タイトル上書き
//   source_type   — 記事種別 (article / paper / etc.)
//   refresh_days  — 整数 (1..3650) または "never"
//
// 設計書 §4.6: per-URL refresh_days で Wiki ごとに再取得頻度を制御する。

const ALLOWED_KEYS = new Set(['tags', 'title', 'source_type', 'refresh_days']);
const REFRESH_DAYS_MIN = 1;
const REFRESH_DAYS_MAX = 3650; // 10 年

/**
 * @param {string} text
 * @returns {{entries: Array<{url: string, meta: object, lineNo: number}>, warnings: string[]}}
 */
export function parseUrlsTxt(text) {
  const entries = [];
  const warnings = [];
  if (typeof text !== 'string') return { entries, warnings };
  const lines = text.split(/\r?\n/);
  let lineNo = 0;
  for (const raw of lines) {
    lineNo += 1;
    // コメント除去 — 行頭の # と、空白直後の # のみを検出 (URL 内の #fragment は保持)。
    const line = stripInlineComment(raw).trim();
    if (!line) continue;
    const segments = line.split(';').map((s) => s.trim());
    const urlPart = segments[0];
    if (!/^https?:\/\//.test(urlPart)) {
      warnings.push(`line ${lineNo}: not a URL: ${urlPart}`);
      continue;
    }
    const meta = {};
    for (let i = 1; i < segments.length; i++) {
      const kv = segments[i];
      if (!kv) continue;
      const eqIdx = kv.indexOf('=');
      if (eqIdx === -1) {
        warnings.push(`line ${lineNo}: malformed DSL (no "="): ${kv}`);
        continue;
      }
      const key = kv.slice(0, eqIdx).trim();
      const val = kv.slice(eqIdx + 1).trim();
      if (!ALLOWED_KEYS.has(key)) {
        warnings.push(`line ${lineNo}: unknown DSL key: ${key}`);
        continue;
      }
      if (key === 'tags') {
        meta.tags = val.split(',').map((t) => t.trim()).filter(Boolean);
      } else if (key === 'refresh_days') {
        if (val === 'never') {
          meta.refresh_days = 'never';
        } else {
          const n = Number(val);
          if (Number.isInteger(n) && n >= REFRESH_DAYS_MIN && n <= REFRESH_DAYS_MAX) {
            meta.refresh_days = n;
          } else {
            warnings.push(
              `line ${lineNo}: invalid refresh_days value: ${val} (expected "never" or int ${REFRESH_DAYS_MIN}-${REFRESH_DAYS_MAX})`,
            );
          }
        }
      } else {
        meta[key] = val;
      }
    }
    entries.push({ url: urlPart, meta, lineNo });
  }
  return { entries, warnings };
}

/**
 * URL fragment (#) とコメント (#) を区別するため、行頭 # または空白直後 # のみコメント扱い。
 * 行の先頭が # → 丸ごとコメント。それ以外で最初に見つかる ' #' の前まで有効。
 */
function stripInlineComment(line) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('#')) return '';
  const idx = line.indexOf(' #');
  return idx === -1 ? line : line.slice(0, idx);
}
