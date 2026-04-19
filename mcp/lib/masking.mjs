// masking.mjs — MCP 入力 body のマスキングルール。
//
// IMPORTANT: hooks/session-logger.mjs の MASK_RULES と同じ内容を保つこと。
// 新パターンを追加するときは、scan-secrets.sh の PATTERNS と合わせて 3 箇所同期する。
// 順序重要: 長いプレフィックスから先にマッチさせる。

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
