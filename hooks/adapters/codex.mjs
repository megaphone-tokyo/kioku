#!/usr/bin/env node
// hooks/adapters/codex.mjs — OpenAI Codex CLI hook adapter (v0.7.0 Q2)
//
// Codex CLI の `~/.codex/hooks.json` (feature flag: `[features] codex_hooks = true`
// in `~/.codex/config.toml`) から stdin JSON を受け取り、NormalizedEvent に
// canonicalize して core に渡す。
//
// Codex は Claude Code と near-identical な stdin/stdout schema を持つ一方、
// 以下の gap がある (research/codex-cli-hook-spec.md + go-no-go-assessment.md):
//   - SessionEnd event 無し → install-hooks-codex.sh が Stop event で git-sync
//     shell を 2 段登録する pattern で emulate (本 adapter は session_end を
//     emit しない、install script の責務)
//   - PostToolUse は Bash tool のみ intercept (Edit/Write/MultiEdit は Codex
//     自体が hook 発火しない。auto-ingest の transcript parser で offline 補完)
//   - PostCompact event 無し → v0.7.0 scope 外 (hot.md port は v0.7.1+)
//
// Stop event は **per-turn** で発火する (Claude SessionEnd 相当の「1 セッション
// 終了時」ではない)。そのため install-hooks-codex.sh では Stop event に
// adapter 実行 + git commit+push の 2 段 hook を登録、per-turn で idempotent に
// git sync する (IH-CODEX-GIT-SYNC-1/2 test で pin、PM A1 指示)。

import { pathToFileURL } from 'node:url';

import { buildContext, envTruthy, ingestNormalizedEvent, readStdin } from '../session-logger-core.mjs';
import { safeMain } from './_common.mjs';

// -----------------------------------------------------------------------------
// Codex CLI hook_event_name → NormalizedEvent.eventName
// -----------------------------------------------------------------------------

const EVENT_MAP = {
  UserPromptSubmit: 'user_prompt',
  Stop: 'assistant_stop',
  PostToolUse: 'tool_use',
  // SessionEnd は Codex に event 無し (null 返却で skip、install-hooks-codex.sh が
  // per-Stop git-sync で emulate、plan 26042405 addendum A1)
  // SessionStart は shell git pull 専用、adapter は handle しない
  // PreToolUse / PermissionRequest / PostCompact は session log に載せない
};

// -----------------------------------------------------------------------------
// Codex stdin payload → NormalizedEvent
// -----------------------------------------------------------------------------

/**
 * @param {Record<string, unknown>} payload Codex CLI hook stdin JSON
 * @returns {import('../session-logger-core.mjs').NormalizedEvent | null}
 */
export function codexPayloadToNormalizedEvent(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const rawEvent = payload.hook_event_name;
  if (typeof rawEvent !== 'string') return null;
  const eventName = EVENT_MAP[rawEvent];
  if (!eventName) return null;
  const sessionId = payload.session_id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;

  /** @type {import('../session-logger-core.mjs').NormalizedEvent} */
  const normEv = {
    sessionId,
    eventName,
    agent: 'codex',
    timestamp: new Date(),
    cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
  };

  if (eventName === 'user_prompt') {
    normEv.userPrompt = {
      text: typeof payload.prompt === 'string' ? payload.prompt : '',
    };
  } else if (eventName === 'assistant_stop') {
    // Codex は `last_assistant_message` を inline で提供 (nullable)。無ければ transcript fallback。
    const resp = {};
    if (typeof payload.last_assistant_message === 'string' && payload.last_assistant_message.length > 0) {
      resp.text = payload.last_assistant_message;
    }
    if (typeof payload.transcript_path === 'string') {
      resp.transcriptPath = payload.transcript_path;
    }
    normEv.assistantResponse = resp;
  } else if (eventName === 'tool_use') {
    // Codex は Bash のみ intercept (research §Codex gap 1)。tool_name は 'Bash' 直通。
    //
    // PR #56 SF-C review fix: spoof defense。Codex 側の fabricated payload が
    // 'Edit' / 'Write' / 'MultiEdit' 等で詐称しても Codex 自体は intercept しない
    // 仕様 (Bash only)。本 adapter は仕様と一致しない tool_name を reject して
    // core に届ける前に silent drop する。
    const toolName = payload.tool_name;
    if (toolName !== 'Bash') {
      return null;
    }
    normEv.toolUse = {
      name: toolName,
      input: payload.tool_input ?? {},
      response: payload.tool_response ?? {},
    };
  }
  // Codex には session_end event が無いため本 adapter は session_end を emit しない。
  // install-hooks-codex.sh が Stop event で git sync を emulate する。

  return normEv;
}

// -----------------------------------------------------------------------------
// 主 entry
// -----------------------------------------------------------------------------

/**
 * codex adapter の main。stdin を読み、NormalizedEvent に変換して core を呼ぶ。
 * KIOKU_NO_LOG / KIOKU_NO_LOG_CODEX で no-op 化 (SF4)。
 * hot.md opt-in prompt は **claude adapter 専用** のため本 adapter では emit しない
 * (MF4、plan 26042405 §Task 3)。
 */
export async function main() {
  // SF4: KIOKU_NO_LOG で全 agent 停止、KIOKU_NO_LOG_CODEX で Codex のみ停止
  if (envTruthy(process.env.KIOKU_NO_LOG)) return;
  if (envTruthy(process.env.KIOKU_NO_LOG_CODEX)) return;

  // §43: agent='codex' で self-recursion guard を skip (Codex に auto-ingest 再帰 risk なし)
  const ctx = await buildContext({ agent: 'codex' });
  if (!ctx) return;

  const raw = await readStdin();
  if (raw == null) return; // payload 過大 (>16 MiB、SF5)
  if (!raw.trim()) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const normEv = codexPayloadToNormalizedEvent(payload);
  if (!normEv) return;

  try {
    await ingestNormalizedEvent(normEv, ctx);
  } catch {
    return;
  }
}

// -----------------------------------------------------------------------------
// Entry
// -----------------------------------------------------------------------------

export function run() {
  safeMain(main);
}

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
