// masking.mjs — MCP 入力 body のマスキングルール。
//
// IMPORTANT: hooks/session-logger.mjs の MASK_RULES と同じ内容を保つこと。
// 新パターンを追加するときは、scan-secrets.sh の PATTERNS と合わせて 3 箇所同期する。
// 順序重要: 長いプレフィックスから先にマッチさせる。
//
// 2026-06-05 F-libs-03 (H1-IMM-04) fix:
//   sanitizeSourceType は scripts/lib/masking.mjs の同名関数と byte-identical な
//   関数 body を維持する (4-way SSOT: parent scripts / parent mcp / app scripts /
//   app mcp)。MCP 経路 (kioku_ingest_url 等) で source_type を frontmatter に
//   落とす前に必ず通すことで、prompt injection / シェルメタ / 不可視 Unicode を
//   除去する。横展開 (kioku_write_note / kioku_write_wiki / kioku_ingest_document /
//   kioku_ingest_pdf) は H2 defer。

export const MASK_RULES = [
  [/sk-ant-[A-Za-z0-9\-_]{20,}/g, 'sk-ant-***'],
  [/sk-proj-[A-Za-z0-9\-_]{20,}/g, 'sk-proj-***'],
  [/sk-[A-Za-z0-9]{20,}/g, 'sk-***'],
  [/ghp_[A-Za-z0-9]{20,}/g, 'ghp_***'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_***'],
  [/gho_[A-Za-z0-9]{20,}/g, 'gho_***'],
  [/ghu_[A-Za-z0-9]{20,}/g, 'ghu_***'],
  [/AIza[A-Za-z0-9\-_]{20,}/g, 'AIza***'],
  [/AKIA[A-Z0-9]{16}/g, 'AKIA***'],
  [/xox[baprs]-[A-Za-z0-9\-]{10,}/g, 'xox*-***'],
  [/vercel_[A-Za-z0-9\-_]{20,}/g, 'vercel_***'],
  [/npm_[A-Za-z0-9]{20,}/g, 'npm_***'],
  [/[spr]k_(live|test)_[A-Za-z0-9]{20,}/g, 'stripe_***'],
  [/sbp_[A-Za-z0-9]{20,}/g, 'sbp_***'],
  [/private_key_id["']?\s*[:=]\s*["']?[a-f0-9]{40}/gi, 'private_key_id=***'],
  [/(?:SharedAccessKey|AccountKey)\s*=\s*[A-Za-z0-9+/=]{20,}/g, 'AzureKey=***'],
  [/Bearer\s+[A-Za-z0-9\-._~+/=]+/g, 'Bearer ***'],
  [/(?:Basic|Digest)\s+[A-Za-z0-9+/=]{10,}/g, 'Authorization ***'],
  [/:\/\/[^:]+:[^@]+@/g, '://***:***@'],
  [
    /(password|passwd|secret|token|api[_\-]?key)\s*[:=]\s*["']?([^\s"'&]+)["']?/gi,
    '$1=***',
  ],
  [
    /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g,
    '<PRIVATE KEY REDACTED>',
  ],
];

// MASK_RULES 適用前に Unicode 不可視/書字方向制御文字を除去して NFC 正規化する。
// ソフトハイフンや ZWSP がトークンプレフィックスを分断して ASCII パターンを
// 素通りさせる攻撃を防ぐため。
// 参照: security-review/meeting/2026-04-17_feature-2-red-blue.md (VULN-002/003/014)
const INVISIBLE_CHARS_RE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/gu;

export function applyMasks(text) {
  if (typeof text !== 'string') return text;
  let out = text.replace(INVISIBLE_CHARS_RE, '').normalize('NFC');
  for (const [re, repl] of MASK_RULES) {
    out = out.replace(re, repl);
  }
  return out;
}

// source_type や frontmatter 由来の短い文字列を YAML/シェルに安全に落とすための
// sanitize。設計書 26041705 §4.2 の規約に基づき、以下を除去する:
//   - 制御文字 (U+0000〜U+001F, U+007F)
//   - Unicode 不可視/書字方向制御文字 (ZWSP, RTLO, BOM, soft hyphen 等)
//   - シェルメタ文字 (` $ ; & |)
// 出力は NFC 正規化してホモグリフ攻撃の一次防御とする。
// 目的は prompt injection 耐性と YAML/シェル整合性の保証のみで、
// 一般的な記号 (英数 / ハイフン / アンダースコア / 空白 / ドット / コロン) は通す。
export function sanitizeSourceType(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(INVISIBLE_CHARS_RE, '')
    .replace(/[`$;&|]/g, '')
    .normalize('NFC')
    .trim();
}
