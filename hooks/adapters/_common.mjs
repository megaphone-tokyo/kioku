// hooks/adapters/_common.mjs — v0.7.0 Q2 adapter 共通ユーティリティ
//
// 全 adapter (claude / gemini / codex) が必ず経由する entry wrapper と
// agent に依存しない sanitizer を提供する。core (session-logger-core.mjs)
// と重複する logic は置かず、adapter boundary 固有のもののみ。

import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { realpath } from 'node:fs/promises';

// §38 fix: process listener register を module-scope gate で 1 process 内 1 回のみに
// 限定する。以前は safeMain 呼び出し毎に process.on(...) が register され、同一
// process 内で safeMain が複数回実行 (test harness で複数 adapter を import +
// 起動する scenario など) されると listener が累積し MaxListenersExceededWarning
// に到達する risk があった (open-issues §38、原典 plan/claude/26042408 §3 item 7)。
let _crashListenersRegistered = false;

/**
 * `unhandledRejection` / `uncaughtException` の crash listener を idempotent
 * に register する。同一 process 内で複数回呼んでも追加 listener を生まない。
 *
 * test 用に export している: safeMain 全体を実行すると entry 完了時に
 * `process.exit(0)` が走り test process が落ちるため、gate logic だけを
 * 直接 unit test するための分離 entry。production では safeMain から透過的
 * に呼ばれるため adapter は import 不要。
 */
export function ensureCrashListenersIdempotent() {
  if (_crashListenersRegistered) return;
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
  _crashListenersRegistered = true;
}

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
  ensureCrashListenersIdempotent();
  Promise.resolve()
    .then(() => entryFn())
    .then(
      () => process.exit(0),
      () => process.exit(0),
    );
}

// -----------------------------------------------------------------------------
// §36 fix: transcript path safe-root boundary check
// -----------------------------------------------------------------------------

// agent 別 transcript safe root allowlist。
// CLI (Claude Code / Gemini CLI / Codex CLI) が信用できる前提で、敵対的 hook stdin
// injection (CLI binary が compromised される scenario) に対する defense-in-depth。
// 現実的 threat model に入る前に、agent-specific 既知 path 以外を core が読み込む
// 経路を塞ぐ (open-issues §36、原典 plan/claude/26042408 §3 item 4)。
//
// homedir() は呼び出し時に評価して HOME env 変更 (test harness) を反映する。
function computeTranscriptSafeRoots(agent) {
  const home = homedir();
  const map = {
    claude: [join(home, '.claude', 'projects')],
    // Gemini CLI は research/gemini-cli-hook-spec.md で transcript_path 確定なし。
    // 既知候補 (.gemini/chats / .gemini/sessions) を共に許容。
    gemini: [join(home, '.gemini', 'chats'), join(home, '.gemini', 'sessions')],
    codex: [join(home, '.codex', 'sessions')],
  };
  return map[agent] || null;
}

export class TranscriptPathError extends Error {
  constructor(reason) {
    super(`assertTranscriptInRoot: ${reason}`);
    this.code = reason;
  }
}

/**
 * `transcript_path` が agent 既知の safe root subpath か prefix check する。
 * realpath を通すため symlink escape も検出する。`/etc/passwd` 等 vault 外
 * 任意 path を core (session-logger-core.mjs) に渡さないための adapter boundary
 * gate。
 *
 * - 不適切な agent / 非文字列 path / realpath 失敗 → throw `TranscriptPathError`
 * - safe root subpath → resolve した real path を返す
 * - safe root 外 → throw `TranscriptPathError('OUTSIDE_SAFE_ROOTS')`
 *
 * @param {'claude'|'gemini'|'codex'} agent
 * @param {string} transcriptPath
 * @returns {Promise<string>} resolved real path (safe)
 */
export async function assertTranscriptInRoot(agent, transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    throw new TranscriptPathError('PATH_NOT_STRING');
  }
  const roots = computeTranscriptSafeRoots(agent);
  if (!roots) throw new TranscriptPathError('UNKNOWN_AGENT');

  let realTranscript;
  try {
    realTranscript = await realpath(transcriptPath);
  } catch (err) {
    throw new TranscriptPathError(`REALPATH_FAILED:${(err && err.code) || 'UNKNOWN'}`);
  }

  for (const root of roots) {
    let realRoot;
    try {
      realRoot = await realpath(root);
    } catch {
      // root が存在しない agent (このマシンに該当 CLI 未 install) は skip
      continue;
    }
    if (realTranscript === realRoot || realTranscript.startsWith(realRoot + sep)) {
      return realTranscript;
    }
  }
  throw new TranscriptPathError('OUTSIDE_SAFE_ROOTS');
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
