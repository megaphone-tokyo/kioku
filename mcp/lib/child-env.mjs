// child-env.mjs — MCP 子プロセス向けの環境変数 allowlist (2026-04-20 新設)
//
// 2026-04-20 security-review HIGH-d1 fix:
//   旧実装では `ENV_ALLOW_PREFIXES = ['KIOKU_', ...]` と `KIOKU_` プレフィックスを
//   丸ごと許可していたため、テスト / 運用用途の以下 env が MCP 子プロセスに
//   propagate していた (production leak → 多層防御破綻):
//     - KIOKU_URL_ALLOW_LOOPBACK (SSRF 最終防衛線)
//     - KIOKU_URL_IGNORE_ROBOTS (robots bypass)
//     - KIOKU_EXTRACT_URL_SCRIPT / KIOKU_ALLOW_EXTRACT_URL_OVERRIDE (任意 bash 経路)
//     - KIOKU_URL_MAX_* / KIOKU_URL_USER_AGENT 等 (親 process でのみ有効な設定)
//
//   本モジュールでは **exact-match allowlist** に切り替え、propagate が必要な
//   ものだけを明示列挙する。子側で再評価されるべき security env は意図的に
//   落とす (子の URL fetch / robots check は現在経路上は起きないが、将来の
//   chain 拡張時に bypass を継承しない defense-in-depth)。
//
//   MED-d2 fix: 旧 `ingest-pdf.mjs` と `llm-fallback.mjs` で同じロジックを個別
//   管理していた drift を共通モジュールに統合。ingest-pdf / llm-fallback 双方が
//   本モジュールを import することで allowlist 変更を 1 箇所で反映できる。

/**
 * 完全一致で子に propagate する環境変数 (常時).
 *
 * - OS 標準: PATH, HOME, USER 等 (claude CLI / shell が必要とする)
 * - Node: TMPDIR, NODE_PATH, NODE_OPTIONS
 * - 本 MCP サーバー用: OBSIDIAN_VAULT (子 claude が Vault 認識に使う)
 * - KIOKU_ 内部通信フラグ:
 *    - KIOKU_NO_LOG       : Hook 再帰抑止
 *    - KIOKU_MCP_CHILD    : 子プロセスからの親 WARN 抑制判定
 *    - KIOKU_DEBUG        : デバッグ出力
 *    - KIOKU_LLM_FB_OUT   : LLM fallback が結果を書き出す絶対パス
 *    - KIOKU_LLM_FB_LOG   : LLM fallback の stderr ログパス
 *
 * 以下は **意図的に exclude** (production leak 回避):
 *    KIOKU_URL_ALLOW_LOOPBACK / KIOKU_URL_IGNORE_ROBOTS /
 *    KIOKU_URL_MAX_* / KIOKU_URL_USER_AGENT / KIOKU_URL_REFRESH_DAYS /
 *    KIOKU_EXTRACT_URL_SCRIPT / KIOKU_ALLOW_EXTRACT_URL_OVERRIDE /
 *    KIOKU_EXTRACT_EPUB_SCRIPT / KIOKU_ALLOW_EXTRACT_EPUB_OVERRIDE /   // Phase 2 機能 2.4
 *    KIOKU_DOC_MAX_EXTRACT_BYTES / KIOKU_DOC_MAX_ENTRIES /              // Phase 2 機能 2.4
 *    KIOKU_DOC_MAX_ENTRY_BYTES / KIOKU_DOC_MAX_INPUT_BYTES /            // Phase 2 機能 2.4
 *    KIOKU_INGEST_MAX_SECONDS など
 *
 * Phase 2 (2026-04-22): EPUB ingest の size cap は claude -p 子に届くべきではない
 *   ため exact allowlist には追加しない。extract-epub.mjs spawn 時に呼出側が
 *   明示注入する (meeting 26042202 合意、prompt injection 経由で size cap を巨大化
 *   される攻撃の遮断)。
 */
export const ENV_ALLOW_EXACT = new Set([
  // OS 標準
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TZ',
  'LANG', 'LC_ALL', 'LC_CTYPE',
  // Node
  'TMPDIR', 'NODE_PATH', 'NODE_OPTIONS',
  // KIOKU 本体
  'OBSIDIAN_VAULT',
  // KIOKU 内部通信フラグ (子プロセスが正しく振る舞うために必要)
  'KIOKU_NO_LOG',
  'KIOKU_MCP_CHILD',
  'KIOKU_DEBUG',
  'KIOKU_LLM_FB_OUT',
  'KIOKU_LLM_FB_LOG',
  // v0.5.1 Phase B (Task B-4): Stop hook の hot.md 更新 opt-in prompt 制御.
  // session-logger が子 claude として実行されるケースでも user の opt-in 設定を
  // propagate させる。default 未設定なら何も起きない (fail-safe).
  'KIOKU_HOT_AUTO_PROMPT',
]);

/**
 * プレフィックス一致で子に propagate する許可リスト.
 *
 * - ANTHROPIC_ : claude CLI の API キー / 設定 (ANTHROPIC_API_KEY 等)
 * - CLAUDE_    : claude CLI の設定 (CLAUDE_HOME, CLAUDE_CONFIG_DIR 等)
 * - XDG_       : XDG Base Directory (~/.config, ~/.cache の解決に必要)
 *
 * `KIOKU_` はここから **意図的に削除**。KIOKU_ は exact-match allowlist の
 * 内部通信フラグだけを通す (HIGH-d1 fix)。
 */
export const ENV_ALLOW_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'XDG_'];

/**
 * 親プロセスの process.env を allowlist でフィルタし、extraEnv を上書き合成する.
 *
 * @param {Record<string,string>} [extraEnv] - 子に追加で渡したい env (allowlist 無視で通る)
 * @returns {Record<string,string>} 子プロセス用の最小 env
 */
export function buildChildEnv(extraEnv = {}) {
  const out = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (ENV_ALLOW_EXACT.has(key) || ENV_ALLOW_PREFIXES.some((p) => key.startsWith(p))) {
      out[key] = val;
    }
  }
  return { ...out, ...extraEnv };
}
