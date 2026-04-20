// env-helpers.mjs — MCP サーバー共通の環境変数ヘルパ
//
// 2026-04-20 機能 2.2 security review (blue M-1 + L-4 / open-issues #13) 対応:
//   - url-fetch / url-image / ingest-url で重複していた envPositiveInt を統合
//   - Number("") === 0 や Number("abc") === NaN の footgun を避け、
//     正の有限数のみ受理するポリシーで cap / timeout / redirects の
//     fail-open 無効化を防ぐ

/**
 * Read a positive integer environment variable, falling back to a safe default.
 *
 * Treats empty-string / "0" / negative / NaN as unset-and-default so that
 * an operator mis-configuring `KIOKU_URL_MAX_SIZE_BYTES=0` (intended to
 * disable) or `=foo` (typo) does not silently turn the cap off.
 *
 * @param {string} name Environment variable name
 * @param {number} fallback Default value when not set / invalid
 * @returns {number} positive finite number (may be non-integer, caller caps if needed)
 */
export function envPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
