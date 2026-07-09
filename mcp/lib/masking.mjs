// masking.mjs — MCP 入力 body のマスキングルール。
//
// masking SSOT の構造 (v0.11 S6-3、plan 26070601 §4.3):
//   scripts/lib/masking.mjs の SHARED LITERAL ブロックと literal 一致を維持する
//   再宣言 (MCP は独立 npm プロジェクトのため import 共有しない)。
//   wrapper の関数名が歴史的に 2 系統 (maskText / applyMasks) あり file 単位の
//   byte-identical 統合は不可能なため、「SHARED LITERAL ブロックの literal 一致 +
//   thin wrapper の明示分離」を SSOT の定義とする。新しいパターンを追加するとき
//   は scripts/lib/masking.mjs 側 header の同期手順 (scan-secrets.sh の ERE /
//   app/ 側 2 copy を含む 4-way) に従うこと。
//   同一性は tests/mask-parity.test.mjs が機械 verify する。
//
// 2026-06-05 F-libs-03 (H1-IMM-04) fix:
//   sanitizeSourceType は scripts/lib/masking.mjs の同名関数と byte-identical な
//   関数 body を維持する。MCP 経路 (kioku_ingest_url 等) で source_type を
//   frontmatter に落とす前に必ず通すことで、prompt injection / シェルメタ /
//   不可視 Unicode を除去する。横展開 (kioku_write_note / kioku_write_wiki /
//   kioku_ingest_document / kioku_ingest_pdf) は H2 defer。

// ============================================================================
// === BEGIN SHARED LITERAL (masking SSOT) ===
// このブロックは scripts/lib/masking.mjs と mcp/lib/masking.mjs で literal 一致
// を維持する (plan 26070601 §4.3)。同一性は tests/mask-parity.test.mjs が
// (a) MASK_RULES の serialize 比較 (b) sanitizeSourceType.toString() 比較
// (c) 代表 input 12 種の behavioral parity で機械 verify する。
// このブロックを編集するときは必ず両 file を同時に更新し、同 test を回すこと。
// 順序重要: 長いプレフィックスから先にマッチさせる。
// ============================================================================

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

// MASK_RULES 適用前に Unicode 不可視/書字方向制御文字を除去して NFC 正規化する
// ための前処理 regex。ソフトハイフンや ZWSP が ASCII パターンを分断してトークン
// (sk-ant-*, ghp_*, AKIA*, Bearer *) を素通りさせる攻撃を防ぐ。
// 参照: security-review/meeting/2026-04-17_feature-2-red-blue.md (VULN-002/003/014)
const INVISIBLE_CHARS_RE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/gu;

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

// ============================================================================
// === END SHARED LITERAL ===
// ============================================================================

// ============================================================================
// thin wrapper — SHARED LITERAL の外。関数名は歴史的経緯で file ごとに異なる
// (本 file = applyMasks / scripts/lib/masking.mjs = maskText)。呼び出し元が多く regression 面積が大きいため
// rename はしない (plan 26070601 §4.3 drift D1)。関数 body は両 file で同一
// logic を保ち、tests/mask-parity.test.mjs (c) の behavioral parity で verify
// する。
// ============================================================================

// MCP 入力 body に対してマスキングルールを適用する。
export function applyMasks(text) {
  if (typeof text !== 'string') return text;
  let out = text.replace(INVISIBLE_CHARS_RE, '').normalize('NFC');
  for (const [re, repl] of MASK_RULES) {
    out = out.replace(re, repl);
  }
  return out;
}
