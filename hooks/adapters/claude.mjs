#!/usr/bin/env node
// hooks/adapters/claude.mjs — Claude Code v2 hook adapter (v0.7.0 Q2)
//
// Claude Code の ~/.claude/settings.json から stdin JSON を受け取り、
// NormalizedEvent に canonicalize して core (session-logger-core.mjs) に渡す。
// core からの OutputIntent を Claude v2 stdout schema (hookSpecificOutput /
// systemMessage) に戻して書き出す。
//
// hot.md opt-in prompt (v0.5.1 Phase B、`KIOKU_HOT_AUTO_PROMPT=1`) は
// **Claude Code v2 の Stop event 専用 `systemMessage` 機構** を使うため
// 本 adapter 専用に配置 (MF4、plan 26042405 §Task 3)。他 agent には port しない。

import { pathToFileURL } from 'node:url';

import { buildContext, envTruthy, ingestNormalizedEvent, readStdin } from '../session-logger-core.mjs';
import { assertTranscriptInRoot, debugRejection, escapeForSystemMessage, safeMain } from './_common.mjs';

// -----------------------------------------------------------------------------
// Claude Code v2 hook_event_name → NormalizedEvent.eventName
// -----------------------------------------------------------------------------

const EVENT_MAP = {
  UserPromptSubmit: 'user_prompt',
  Stop: 'assistant_stop',
  PostToolUse: 'tool_use',
  SessionEnd: 'session_end',
  // SessionStart / PreToolUse / PostCompact は session-logger の scope 外
  // (wiki-context-injector.mjs 管轄 / 未使用、MF5)
};

// -----------------------------------------------------------------------------
// Claude v2 JSON payload → NormalizedEvent 変換
// -----------------------------------------------------------------------------

/**
 * @param {Record<string, unknown>} payload Claude v2 hook stdin JSON
 * @returns {import('../session-logger-core.mjs').NormalizedEvent | null}
 */
export function claudePayloadToNormalizedEvent(payload) {
  // S6-4 Layer 1: 各 reject 箇所で debugRejection (KIOKU_DEBUG 時のみ stderr、
  // reason code のみ / payload 値は書かない)。返却契約 (null) は不変。
  if (!payload || typeof payload !== 'object') {
    debugRejection('claude', 'INVALID_PAYLOAD');
    return null;
  }
  const rawEvent = payload.hook_event_name;
  if (typeof rawEvent !== 'string') {
    debugRejection('claude', 'INVALID_EVENT_NAME');
    return null;
  }
  const eventName = EVENT_MAP[rawEvent];
  if (!eventName) {
    debugRejection('claude', 'UNSUPPORTED_EVENT');
    return null;
  }
  const sessionId = payload.session_id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    debugRejection('claude', 'INVALID_SESSION_ID');
    return null;
  }

  /** @type {import('../session-logger-core.mjs').NormalizedEvent} */
  const normEv = {
    sessionId,
    eventName,
    agent: 'claude',
    timestamp: new Date(),
    cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
  };

  if (eventName === 'user_prompt') {
    if (typeof payload.prompt === 'string') {
      normEv.userPrompt = { text: payload.prompt };
    } else {
      normEv.userPrompt = { text: '' };
    }
  } else if (eventName === 'assistant_stop') {
    // Claude Code は transcript_path 経由で差分 JSONL を読む。inline text は提供しない。
    normEv.assistantResponse = {
      transcriptPath: typeof payload.transcript_path === 'string' ? payload.transcript_path : undefined,
    };
  } else if (eventName === 'tool_use') {
    if (typeof payload.tool_name === 'string') {
      normEv.toolUse = {
        name: payload.tool_name,
        input: payload.tool_input ?? {},
        response: payload.tool_response ?? {},
      };
    }
  } else if (eventName === 'session_end') {
    normEv.sessionEnd = {
      reason: typeof payload.exit_reason === 'string' ? payload.exit_reason : undefined,
    };
  }

  return normEv;
}

// -----------------------------------------------------------------------------
// hot.md opt-in prompt (v0.5.1 Phase B、claude adapter 専用、MF4)
// -----------------------------------------------------------------------------

/**
 * Stop event 後の追加動作: `KIOKU_HOT_AUTO_PROMPT=1` が truthy のとき top-level
 * `systemMessage` を stdout に emit し、次 turn の system prompt に hot.md 更新
 * 検討を提案する。Claude Code v2 schema (hotfix 4 原典、2026-04-23)。
 *
 * 他 agent (Gemini / Codex) の Stop 系 event では schema 非互換のため port しない。
 */
function maybeEmitHotCachePrompt(eventName) {
  if (eventName !== 'assistant_stop') return;
  if (!envTruthy(process.env.KIOKU_HOT_AUTO_PROMPT)) return;
  const rawPrompt = [
    '## ホットキャッシュ更新 (opt-in 提案)',
    '',
    '直近のセッション状況を踏まえて、$OBSIDIAN_VAULT/wiki/hot.md を短い引き継ぎメモ',
    '(Recent Context、500 word 以下) として更新すべきか検討してください。',
    '更新する場合は `kioku_write_wiki` または直接 Edit で hot.md を書き換えてください。',
    '秘密情報 (API key / token / PII) は絶対に含めないこと (scan-secrets.sh が検知します)。',
  ].join('\n');
  // PR #56 SF-B review fix: 現状 prompt は静的文字列で exploit path 無いが、
  // future に prompt 内容を動的 (session log 抜粋等) へ拡張した時の XSS
  // regression tripwire として escapeForSystemMessage を毎 emit で必ず通す。
  // CLAUDE-ADPT-HOT-5 が本 wrap の存在を assertion で pin する。
  const prompt = escapeForSystemMessage(rawPrompt, 'claude');
  process.stdout.write(JSON.stringify({ systemMessage: prompt }));
}

// -----------------------------------------------------------------------------
// 主 entry
// -----------------------------------------------------------------------------

/**
 * claude adapter の main。stdin を読み、NormalizedEvent に変換して core を呼ぶ。
 * KIOKU_NO_LOG / KIOKU_NO_LOG_CLAUDE で no-op 化 (SF4)。
 * Stop event かつ hot.md opt-in が set なら追加 systemMessage を emit。
 */
export async function main() {
  // SF4: KIOKU_NO_LOG で全 agent 停止、KIOKU_NO_LOG_CLAUDE で Claude のみ停止
  if (envTruthy(process.env.KIOKU_NO_LOG)) return;
  if (envTruthy(process.env.KIOKU_NO_LOG_CLAUDE)) return;

  const ctx = await buildContext({ agent: 'claude' });
  if (!ctx) return; // OBSIDIAN_VAULT 未設定 / cwd-in-vault (Claude only re-entrance guard) / vault が dir でない

  const raw = await readStdin();
  if (raw == null) return; // payload 過大 (>16 MiB、SF5)
  if (!raw.trim()) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const normEv = claudePayloadToNormalizedEvent(payload);
  if (!normEv) return;

  // §36 fix: transcript_path を core が無条件で stat/open/read する前に safe root
  // boundary check。allowlist 外 (敵対的 stdin injection 等) は transcriptPath
  // field を drop して silent fallback (Claude には inline text 無いので assistant_stop
  // は no-op 化、log は欠損するが filesystem boundary は保護される)。
  if (normEv.eventName === 'assistant_stop' && normEv.assistantResponse?.transcriptPath) {
    try {
      await assertTranscriptInRoot(normEv.agent, normEv.assistantResponse.transcriptPath);
    } catch {
      delete normEv.assistantResponse.transcriptPath;
    }
  }

  try {
    await ingestNormalizedEvent(normEv, ctx);
  } catch {
    // core は validation / IO error を throw するが adapter は常に exit 0。
    // safeMain が await エラーを catch する前に hot.md prompt emission を skip する
    // 方が安全: Stop イベントでも core が失敗したら hot.md prompt は出さない。
    return;
  }

  // core 処理成功時のみ hot.md 提案を emit (F4 MF4)
  maybeEmitHotCachePrompt(normEv.eventName);
}

// -----------------------------------------------------------------------------
// Entry (shim / 直接 invoke の両方をサポート)
// -----------------------------------------------------------------------------

/**
 * 直接 invoke 時 (node adapters/claude.mjs) と shim (session-logger.mjs) から
 * 共通で呼ばれる runtime entry。test は本関数を呼ばずに export された helper
 * (claudePayloadToNormalizedEvent) だけを利用できる。
 */
export function run() {
  safeMain(main);
}

// ESM での "is this file the entry script?" 判定: process.argv[1] の resolved URL と
// import.meta.url を比較。test が import しただけの場合は entry ではないので
// stdin 読み取りが発動しない。
const isEntry = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return import.meta.url === pathToFileURL(arg).href;
  } catch {
    return false;
  }
})();

if (isEntry) {
  run();
}
