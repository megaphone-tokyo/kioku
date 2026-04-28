// hooks/adapters/_common.mjs — v0.7.0 Q2 adapter 共通ユーティリティ
//
// 全 adapter (claude / gemini / codex) が必ず経由する entry wrapper と
// agent に依存しない sanitizer を提供する。core (session-logger-core.mjs)
// と重複する logic は置かず、adapter boundary 固有のもののみ。

/**
 * 全 adapter の entry は必ず safeMain を経由する (MF5、plan 26042405 §Task 3)。
 * Claude Code / Gemini CLI / Codex CLI のどれでも hook が throw したり
 * unhandledRejection を発生させても、**exit 0 を返して親 CLI をブロックしない** 契約。
 *
 * 使い方:
 *   import { safeMain } from './_common.mjs';
 *   safeMain(async () => { ... });  // ファイル末尾で呼ぶ
 *
 * @param {() => Promise<void>} entryFn
 */
export function safeMain(entryFn) {
  process.on('unhandledRejection', (err) => {
    try {
      process.stderr.write(`[claude-brain] unhandledRejection: ${err && err.message}\n`);
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
  // uncaughtException も同様 (stdin 読み取り中の sync error など)
  process.on('uncaughtException', (err) => {
    try {
      process.stderr.write(`[claude-brain] uncaughtException: ${err && err.message}\n`);
    } catch {
      /* ignore */
    }
    process.exit(0);
  });

  Promise.resolve()
    .then(() => entryFn())
    .then(
      () => process.exit(0),
      () => process.exit(0),
    );
}

/**
 * systemMessage などで chat UI に表示されるテキストから、render 時の XSS 誘引
 * になりうる Markdown 構文を strip する (SF2、BLUE-ADPT-XSS-1..3)。
 *
 * 対象:
 * - Markdown image: `![alt](url)` → `[image: alt]` (自動読込みの副作用を回避)
 * - Markdown link:  `[text](url)` → `text` (任意 URL への誘導を遮断)
 * - HTML tag:       `<script>...` / `<iframe>...` → そのまま落とす (chat UI は通常 sanitize 済だが二重防御)
 *
 * @param {string} text
 * @param {'claude'|'gemini'|'codex'} [agent] 将来の agent 別挙動分岐用 (v0.7.0 では未使用)
 * @returns {string}
 */
export function escapeForSystemMessage(text, agent) {
  void agent;
  if (typeof text !== 'string') return '';
  let s = text;
  // Image: ![alt](url) → [image: alt]
  s = s.replace(/!\[([^\]]*)\]\([^\)]*\)/g, (_match, alt) => `[image: ${alt || ''}]`);
  // Link: [text](url) → text
  s = s.replace(/\[([^\]]+)\]\(([^\)]*)\)/g, (_match, inner) => inner);
  // HTML tag: <...> → drop (but preserve literal `<` / `>` in code-fence sections by being
  //   conservative: only strip recognizable tag-like sequences that begin with < followed by
  //   letter/slash)
  s = s.replace(/<\/?[A-Za-z][^>]*>/g, '');
  return s;
}
