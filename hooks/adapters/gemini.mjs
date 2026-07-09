#!/usr/bin/env node
// hooks/adapters/gemini.mjs — Gemini CLI hook adapter (v0.7.0 Q2)
//
// Google Gemini CLI の `~/.gemini/settings.json` から stdin JSON を受け取り、
// NormalizedEvent に canonicalize して core (session-logger-core.mjs) に渡す。
// Gemini の hook system は Claude Code v2 と near-identical な schema を持つが
// event 名と tool 名 (snake_case) が異なるため本 adapter で remap する。
//
// Gemini CLI 公式 migration tool `gemini hooks migrate --from-claude` の
// authoritative EVENT_MAPPING 定数 (packages/cli/src/commands/hooks/migrate.ts)
// に準拠。詳細は research/gemini-cli-hook-spec.md 参照。

import { pathToFileURL } from 'node:url';

import { buildContext, envTruthy, ingestNormalizedEvent, readStdin } from '../session-logger-core.mjs';
import { assertTranscriptInRoot, debugRejection, safeMain } from './_common.mjs';

// -----------------------------------------------------------------------------
// Gemini CLI hook_event_name → NormalizedEvent.eventName
// -----------------------------------------------------------------------------

const EVENT_MAP = {
  BeforeAgent: 'user_prompt',
  AfterAgent: 'assistant_stop',
  AfterTool: 'tool_use',
  SessionEnd: 'session_end',
  // SessionStart / PreCompress / BeforeTool / BeforeToolSelection / Notification /
  // BeforeModel / AfterModel は session-logger scope 外
  // (SessionStart は git pull shell hook、PreCompress は hot.md の wiki-context-injector
  // 管轄 / v0.7.0 では未 port、それ以外は session log に載せない意思決定)
};

// -----------------------------------------------------------------------------
// Gemini tool 名 (snake_case) → canonical (Claude 互換、core が期待する form)
// -----------------------------------------------------------------------------

const TOOL_NAME_MAP = {
  run_shell_command: 'Bash',
  replace: 'Edit',
  write_file: 'Write',
  // Gemini に MultiEdit 相当は無し。read_file / glob / grep / ls は core の
  // handleToolUse で match しないため passthrough (session log に載らず silent drop)
};

/**
 * Gemini tool 名を canonical 名 (Claude 互換) に変換。
 *
 * PR #56 SF-C review fix: spoof defense。Gemini 側の fabricated payload が
 * canonical 名 ('Bash' / 'Edit' / 'Write' 等) で tool_name を詐称できないよう、
 * TOOL_NAME_MAP の **key (Gemini snake_case 名)** のみを accept する。
 * それ以外 (canonical 名を含む未知 tool) は null 返却で handleToolUse default
 * branch (silent drop、OUTPUT_NONE) に誘導。
 *
 * @returns {string | null} canonical 名 (mapping 成功時) / null (reject)
 */
function remapToolName(geminiName) {
  if (typeof geminiName !== 'string') return null;
  if (Object.prototype.hasOwnProperty.call(TOOL_NAME_MAP, geminiName)) {
    return TOOL_NAME_MAP[geminiName];
  }
  // 未知の Gemini tool (read_file / glob / grep / ls 等 session log 対象外) や
  // canonical 名 passthrough (spoof attempt) は null で reject。core handleToolUse
  // は toolUse.name が string でない場合 silent drop する (BLUE-CORE-VAL-8 で
  // non-empty string 要求、null は validation で reject される)。
  return null;
}

// -----------------------------------------------------------------------------
// Gemini stdin payload → NormalizedEvent
// -----------------------------------------------------------------------------

/**
 * @param {Record<string, unknown>} payload Gemini CLI hook stdin JSON
 * @returns {import('../session-logger-core.mjs').NormalizedEvent | null}
 */
export function geminiPayloadToNormalizedEvent(payload) {
  // S6-4 Layer 1: 各 reject 箇所で debugRejection (KIOKU_DEBUG 時のみ stderr、
  // reason code のみ / payload 値は書かない)。返却契約 (null) は不変。
  if (!payload || typeof payload !== 'object') {
    debugRejection('gemini', 'INVALID_PAYLOAD');
    return null;
  }
  const rawEvent = payload.hook_event_name;
  if (typeof rawEvent !== 'string') {
    debugRejection('gemini', 'INVALID_EVENT_NAME');
    return null;
  }
  const eventName = EVENT_MAP[rawEvent];
  if (!eventName) {
    debugRejection('gemini', 'UNSUPPORTED_EVENT');
    return null;
  }
  const sessionId = payload.session_id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    debugRejection('gemini', 'INVALID_SESSION_ID');
    return null;
  }

  /** @type {import('../session-logger-core.mjs').NormalizedEvent} */
  const normEv = {
    sessionId,
    eventName,
    agent: 'gemini',
    timestamp: new Date(),
    cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
  };

  if (eventName === 'user_prompt') {
    normEv.userPrompt = {
      text: typeof payload.prompt === 'string' ? payload.prompt : '',
    };
  } else if (eventName === 'assistant_stop') {
    // Gemini AfterAgent は inline `prompt_response` を提供する。core は text を優先、
    // transcript_path は fallback (研究段階で transcript JSON shape 未確定のため)。
    const resp = {};
    if (typeof payload.prompt_response === 'string' && payload.prompt_response.length > 0) {
      resp.text = payload.prompt_response;
    }
    if (typeof payload.transcript_path === 'string') {
      resp.transcriptPath = payload.transcript_path;
    }
    normEv.assistantResponse = resp;
  } else if (eventName === 'tool_use') {
    const geminiToolName = payload.tool_name;
    if (typeof geminiToolName !== 'string' || geminiToolName.length === 0) {
      // tool_name 不在 / 非文字列 → tool_use event 自体を reject (null 返却)
      debugRejection('gemini', 'INVALID_TOOL_NAME');
      return null;
    }
    const canonical = remapToolName(geminiToolName);
    if (canonical == null) {
      // PR #56 SF-C review fix: remapToolName が null → 未知 tool or canonical
      // 名 spoof attempt。tool_use event 自体を reject して core validation に
      // 届ける前に silent drop する。
      debugRejection('gemini', 'UNSUPPORTED_TOOL');
      return null;
    }
    normEv.toolUse = {
      name: canonical,
      input: payload.tool_input ?? {},
      response: payload.tool_response ?? {},
    };
  } else if (eventName === 'session_end') {
    // Gemini `reason` values: "exit" / "clear" / "logout" / "prompt_input_exit" / "other"
    normEv.sessionEnd = {
      reason: typeof payload.reason === 'string' ? payload.reason : undefined,
    };
  }

  return normEv;
}

// -----------------------------------------------------------------------------
// 主 entry
// -----------------------------------------------------------------------------

/**
 * gemini adapter の main。stdin を読み、NormalizedEvent に変換して core を呼ぶ。
 * KIOKU_NO_LOG / KIOKU_NO_LOG_GEMINI で no-op 化 (SF4)。
 * hot.md opt-in prompt は **claude adapter 専用** のため本 adapter では emit しない
 * (MF4、plan 26042405 §Task 3)。
 */
export async function main() {
  // SF4: KIOKU_NO_LOG で全 agent 停止、KIOKU_NO_LOG_GEMINI で Gemini のみ停止
  if (envTruthy(process.env.KIOKU_NO_LOG)) return;
  if (envTruthy(process.env.KIOKU_NO_LOG_GEMINI)) return;

  // §43: agent='gemini' で self-recursion guard を skip (Gemini に auto-ingest 再帰 risk なし)
  const ctx = await buildContext({ agent: 'gemini' });
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

  const normEv = geminiPayloadToNormalizedEvent(payload);
  if (!normEv) return;

  // §36 fix: transcript_path safe root boundary check (allowlist 外は drop、
  // Gemini は inline `prompt_response` text を別途持つため assistant_stop は
  // text fallback で続行可能)。
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
    // core の validation / IO error は adapter の safeMain で exit 0 化
    return;
  }
}

// -----------------------------------------------------------------------------
// Entry (直接 invoke 時のみ safeMain 発火、test import 時は hang 回避)
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
