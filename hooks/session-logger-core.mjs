// session-logger-core.mjs — claude-brain agent-agnostic core (v0.7.0 Q2)
//
// Multi-agent (Claude Code / Gemini CLI / Codex CLI) 共通の hook ロジック。
// 各 agent adapter (hooks/adapters/{claude,gemini,codex}.mjs) が stdin の
// agent-specific JSON を NormalizedEvent に変換して本 core の
// ingestNormalizedEvent(normEv, ctx) を呼ぶ。core は NormalizedEvent を
// 信頼せず独立再 validate する (BLUE-CORE-VAL-1..8、MF4 plan 26042405)。
//
// Node 18+ 組み込みモジュールのみ。外部ネットワーク禁止。
// エラー時も安全側に倒す: throw は adapter 側 safeMain で catch され exit 0。

import { appendFile, mkdir, readFile, writeFile, rename, open, stat, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';

import { maskText as mask } from '../scripts/lib/masking.mjs';

// -----------------------------------------------------------------------------
// 定数 / enum (closed sets)
// -----------------------------------------------------------------------------

export const INDEX_VERSION = 1;
export const MAX_STDOUT_CHARS = 2000;
export const MAX_TITLE_CODEPOINTS = 50;
export const MAX_STDIN_BYTES = 16 * 1024 * 1024; // 16 MiB (M1)
export const MAX_SESSION_ID_CHARS = 256;
export const INDEX_LOCK_STALE_MS = 30_000; // lock が 30s 以上古ければ steal

/** @type {ReadonlySet<string>} */
export const EVENT_NAMES = new Set([
  'user_prompt',
  'assistant_stop',
  'tool_use',
  'session_start',
  'session_end',
  'post_compact',
]);

/** @type {ReadonlySet<string>} */
export const AGENT_NAMES = new Set(['claude', 'gemini', 'codex']);

export const BASH_BLOCKLIST = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'which', 'where', 'type',
  'echo', 'printf', 'pwd', 'cd', 'test', 'true', 'false', 'grep', 'rg', 'find',
  'diff', 'sort', 'uniq', 'tr', 'cut', 'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'ln',
  'chmod', 'chown', 'touch', 'basename', 'dirname', 'realpath', 'readlink',
  'tree', 'du', 'df', 'less', 'more', 'xargs', 'tee', 'whoami', 'hostname',
  'date', 'uname', 'env', 'set', 'export', 'alias', 'id', 'jq',
]);

/**
 * @typedef {Object} NormalizedEvent
 * @property {string} sessionId               - ASCII + `-` / `_`、非空、<=256 chars
 * @property {'user_prompt'|'assistant_stop'|'tool_use'|'session_start'|'session_end'|'post_compact'} eventName
 * @property {'claude'|'gemini'|'codex'} agent
 * @property {Date} timestamp
 * @property {{ text: string }} [userPrompt]                         - user_prompt 用
 * @property {{ transcriptPath?: string, text?: string }} [assistantResponse] - assistant_stop 用
 * @property {{ name: string, input?: unknown, response?: unknown }} [toolUse] - tool_use 用
 * @property {{ reason?: string }} [sessionEnd]                      - session_end 用 (Claude exit_reason / Gemini reason)
 * @property {string} [cwd]
 */

/**
 * @typedef {Object} Context
 * @property {string} vault
 * @property {string} sessionLogsDir
 * @property {string} internalDir
 * @property {string} indexPath
 */

/**
 * @typedef {Object} OutputIntent
 * @property {'none'|'systemMessage'|'hookSpecificOutput'|'block'} type
 * @property {string} [text]
 * @property {Record<string, unknown>} [payload]
 * @property {string} [reason]
 */

const OUTPUT_NONE = Object.freeze({ type: 'none' });

// -----------------------------------------------------------------------------
// 環境変数 / 汎用ユーティリティ
// -----------------------------------------------------------------------------

export function envTruthy(val) {
  if (!val) return false;
  return /^(1|true|yes|on)$/i.test(String(val).trim());
}

// YAML スカラー値の安全埋込: 制御/不可視文字除去 + YAML 構造文字を quote。
// frontmatter injection 対策 (RED-L0-02, M3)、sessionId に `\n---` を入れても境界偽装不可。
// 注: 不可視文字クラスは \uXXXX escape で書く (literal U+2028/U+2029 は JS parser が
//     行セパレータとして扱い regex literal を壊すため)。
export function yamlSafeValue(v) {
  if (v == null) return '';
  let s = String(v)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\u200b-\u200f\u2028-\u2029\ufeff]/g, '');
  if (/[:#&*!|>'"%@`[\]{},]|^\s|\s$|^[-?~]|^(null|true|false|yes|no|on|off)$/i.test(s)) {
    return `'${s.replace(/'/g, "''")}'`;
  }
  return s;
}

export function localNow(date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const YYYY = date.getFullYear();
  const MM = pad(date.getMonth() + 1);
  const DD = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  const tzOffset = -date.getTimezoneOffset();
  const tzSign = tzOffset >= 0 ? '+' : '-';
  const tzH = pad(Math.floor(Math.abs(tzOffset) / 60));
  const tzM = pad(Math.abs(tzOffset) % 60);
  const iso = `${YYYY}-${MM}-${DD}T${hh}:${mm}:${ss}${tzSign}${tzH}:${tzM}`;
  const compactDate = `${YYYY}${MM}${DD}`;
  const compactTime = `${hh}${mm}${ss}`;
  const clock = `${hh}:${mm}:${ss}`;
  return { iso, compactDate, compactTime, clock };
}

export function sanitizeSidPrefix(sessionId) {
  const head = String(sessionId || '').slice(0, 4).toLowerCase();
  return head.replace(/[^a-z0-9]/g, '_') || '____';
}

export function sanitizeTitle(raw) {
  if (!raw || typeof raw !== 'string') return 'untitled';
  let s = raw;
  s = s.replace(/[\x00-\x1f\x7f]/g, ' ');
  s = s.replace(/[/\\]/g, '-');
  s = s.replace(/[<>:"|?*]/g, '-');
  s = s.normalize('NFC');
  s = s.replace(/\s+/g, ' ').trim().replace(/ /g, '-');
  s = s.replace(/^[-.]+|[-.]+$/g, '');
  const codepoints = Array.from(s);
  if (codepoints.length > MAX_TITLE_CODEPOINTS) {
    s = codepoints.slice(0, MAX_TITLE_CODEPOINTS).join('');
    s = s.replace(/^[-.]+|[-.]+$/g, '');
  }
  return s || 'untitled';
}

export function buildFileName({ compactDate, compactTime }, sessionId, title) {
  const sid4 = sanitizeSidPrefix(sessionId);
  return `${compactDate}-${compactTime}-${sid4}-${title}.md`;
}

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  if (s.length <= n) return s;
  return s.slice(0, n) + ' ... (truncated)';
}

function quoteCallout(text) {
  return text.split('\n').map((l) => `> ${l}`).join('\n');
}

function splitBashCommand(cmd) {
  const segments = cmd.split(/(?:;|&&|\|\||\|)/);
  return segments.map((s) => s.trim()).filter(Boolean);
}

function firstWord(segment) {
  const m = segment.match(/^\s*([^\s]+)/);
  if (!m) return '';
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(m[1])) {
    const rest = segment.replace(/^\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s*/, '');
    return firstWord(rest);
  }
  return m[1];
}

export function isAllBlocked(cmd) {
  const segments = splitBashCommand(cmd);
  if (segments.length === 0) return true;
  for (const seg of segments) {
    const word = firstWord(seg);
    if (!BASH_BLOCKLIST.has(word)) return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// stdin 読み込み (SF5 / M1: 16 MiB cap で early return)
// -----------------------------------------------------------------------------

export async function readStdin(maxBytes = MAX_STDIN_BYTES) {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > maxBytes) {
      // payload 過大: early return で core に進まず安全側に倒す
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// -----------------------------------------------------------------------------
// ログ / 索引
// -----------------------------------------------------------------------------

export function debugLog(ctx, msg) {
  if (!envTruthy(process.env.KIOKU_DEBUG)) return;
  process.stderr.write(`[claude-brain] ${msg}\n`);
  writeErrorLog(ctx, `DEBUG: ${msg}`).catch(() => {});
}

export async function writeErrorLog(ctx, msg) {
  if (!ctx || !ctx.internalDir) return;
  try {
    await mkdir(ctx.internalDir, { recursive: true });
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    await appendFile(join(ctx.internalDir, 'errors.log'), line, 'utf8');
  } catch {
    // 無視
  }
}

export async function loadIndex(ctx) {
  try {
    const raw = await readFile(ctx.indexPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.sessions !== 'object') {
      throw new Error('malformed index');
    }
    return parsed;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { version: INDEX_VERSION, sessions: {} };
    }
    try {
      const backup = `${ctx.indexPath}.broken-${Date.now()}`;
      await rename(ctx.indexPath, backup);
      await writeErrorLog(ctx, `WARN: index.json corrupted, moved to ${backup}`);
    } catch {
      /* ignore */
    }
    return { version: INDEX_VERSION, sessions: {} };
  }
}

export async function saveIndex(ctx, index) {
  const tmp = `${ctx.indexPath}.tmp`;
  const payload = JSON.stringify(index, null, 2);
  await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, ctx.indexPath);
}

export function newSessionEntry(fileName, isoDate, transcriptPath) {
  return {
    file: fileName,
    created: isoDate,
    first_prompt_saved: false,
    transcript_path: transcriptPath || null,
    transcript_read_offset: 0,
    counters: {
      user_prompts: 0,
      assistant_turns: 0,
      bash_commands_logged: 0,
      file_edits: 0,
    },
  };
}

// -----------------------------------------------------------------------------
// index.lock (SF1: BLUE-CORE-CONCURRENT-1 / 3 child proc 並列 100 event)
// -----------------------------------------------------------------------------

// §33 fix: process.kill(pid, 0) で alive check (open-issues §33、原典 plan/
// claude/26042408 §3 item 1)。EPERM は existence の証 (kill perm は無いが process は
// 存在)、ESRCH は no-such-process。それ以外は alive 扱いで保守的に倒す
// (race の中で誤って alive な lock を奪わない pessimistic 判定)。
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

async function readLockPid(lockPath) {
  try {
    const content = await readFile(lockPath, 'utf8');
    const parsed = parseInt(content.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

// §33 fix: index.lock TOCTOU race 対策 (open-issues §33)。
//
// 旧実装の race window:
//   1. process A が 'wx' で lock 取得、PID=A を write
//   2. process B が stat(lock) → mtime stale 判定 → unlink → 'wx' で再取得
//      (A の lock を steal してしまう)、PID=B を write
//   3. process A は自分が lock を所有していると思って index 書き込み、release で
//      lockPath を unlink → B の現有 lock を消す事故が起き得る
//
// 防御 2 段:
//   (a) **Steal 前に PID alive check**: stale な mtime でも owner PID が alive なら
//       steal しない (process が遅いだけかもしれない)。dead PID / unparseable /
//       自 PID (orphan) のみ steal する。
//   (b) **取得後に content re-verify**: 'wx' 成功直後に lock の中身を読み戻し、
//       自分の PID が残っていることを確認する。race で奪われていたら retry。
async function acquireIndexLock(ctx) {
  const lockPath = `${ctx.indexPath}.lock`;
  const deadline = Date.now() + 5_000;
  const myPid = String(process.pid);
  while (true) {
    try {
      const fh = await open(lockPath, 'wx', 0o600);
      try {
        await fh.write(myPid);
      } finally {
        await fh.close();
      }
      // (b) 取得後 content verify: race で奪われた場合 retry
      const ownerPid = await readLockPid(lockPath);
      if (ownerPid !== process.pid) {
        if (Date.now() > deadline) {
          throw new Error('index.lock timeout');
        }
        await new Promise((r) => setTimeout(r, 10 + Math.random() * 30));
        continue;
      }
      return lockPath;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') {
        throw err;
      }
      // 既存 lock: stale 判定 + (a) PID alive check で steal 可否を決定
      try {
        const s = await stat(lockPath);
        if (Date.now() - s.mtimeMs > INDEX_LOCK_STALE_MS) {
          const ownerPid = await readLockPid(lockPath);
          if (ownerPid === null || !isProcessAlive(ownerPid)) {
            // 安全に steal: unparseable content / dead owner
            // (自 pid match は steal 条件にしない: 同 Node process 内の Promise.all
            //  並列 ingest で全 instance が process.pid を共有するため、self-pid
            //  shortcut は in-process double-acquire 事故を起こす)
            await unlink(lockPath).catch(() => {});
            continue;
          }
          // alive owner: stale mtime でも steal しない (process が遅いだけかも)、
          // deadline まで待機 retry
        }
      } catch {
        // stat 失敗 → 次周回で再 open 試行
      }
      if (Date.now() > deadline) {
        throw new Error('index.lock timeout');
      }
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 30));
    }
  }
}

async function releaseIndexLock(lockPath) {
  try {
    await unlink(lockPath);
  } catch {
    /* ignore */
  }
}

// -----------------------------------------------------------------------------
// セッションファイル解決 / frontmatter
// -----------------------------------------------------------------------------

export function buildFrontmatter(normEv, ts) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || '';
  const lines = [
    '---',
    'type: session-log',
    // §41 fix (v0.7.1): agent field を type: 直後に emit。multi-agent (claude /
    // gemini / codex) の session log を frontmatter で識別可能にする。
    // normEv.agent は validateNormalizedEvent (BLUE-CORE-VAL-5) で AGENT_NAMES
    // closed enum 検証済のため theoretical injection 不可。defense-in-depth で
    // yamlSafeValue を必ず通す (既存 cwd / sessionId と同じ pattern)。
    `agent: ${yamlSafeValue(normEv.agent)}`,
    `session_id: ${yamlSafeValue(normEv.sessionId)}`,
    `hostname: ${yamlSafeValue(hostname())}`,
    `cwd: ${yamlSafeValue(normEv.cwd || '')}`,
    `date: ${ts.iso}`,
    `project_dir: ${projectDir ? yamlSafeValue(projectDir) : 'null'}`,
    'ingested: false',
    'related: []',
    '---',
    '',
  ];
  return lines.join('\n');
}

export async function ensureSessionFile(ctx, index, normEv, ts) {
  const sid = normEv.sessionId;
  const existing = index.sessions[sid];
  if (existing) {
    const tp = normEv.assistantResponse?.transcriptPath;
    if (!existing.transcript_path && tp) {
      existing.transcript_path = tp;
    }
    return existing;
  }

  // 新規セッション: 最初のイベントが user_prompt + prompt text でなければ作成しない。
  // ghost session guard (現行 session-logger.mjs:222 の NormalizedEvent 版、MF1)。
  if (normEv.eventName !== 'user_prompt' || !normEv.userPrompt?.text) {
    return null;
  }

  const title = sanitizeTitle(normEv.userPrompt.text);
  const fileName = buildFileName(ts, sid, title);
  const entry = newSessionEntry(fileName, ts.iso, normEv.assistantResponse?.transcriptPath);
  entry.first_prompt_saved = true;
  index.sessions[sid] = entry;

  const filePath = join(ctx.sessionLogsDir, fileName);
  const fm = buildFrontmatter(normEv, ts);
  await writeFile(filePath, fm, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

  return entry;
}

// -----------------------------------------------------------------------------
// イベントハンドラ (NormalizedEvent 対応、agent 非依存)
// -----------------------------------------------------------------------------

async function handleUserPrompt(normEv, ctx, index, entry, ts) {
  const text = normEv.userPrompt?.text;
  if (typeof text !== 'string' || text.length === 0) return OUTPUT_NONE;
  const masked = mask(text);
  const body = `\n## User (${ts.clock})\n\n${masked}\n`;
  await appendFile(join(ctx.sessionLogsDir, entry.file), body, 'utf8');
  entry.counters.user_prompts += 1;
  return OUTPUT_NONE;
}

async function handleAssistantStop(normEv, ctx, index, entry, ts) {
  const ar = normEv.assistantResponse || {};
  // 優先順位: agent が inline text を提供していればそれを使う (Gemini AfterAgent.prompt_response、
  // Codex Stop.last_assistant_message)。無ければ transcript_path からの JSONL 解析 (Claude Code 経路)。
  let assistantText = '';

  if (typeof ar.text === 'string' && ar.text.length > 0) {
    assistantText = ar.text;
  } else {
    const transcriptPath = ar.transcriptPath || entry.transcript_path;
    if (!transcriptPath) {
      await writeErrorLog(ctx, `WARN: assistant_stop without transcript_path (session=${normEv.sessionId})`);
      return OUTPUT_NONE;
    }
    entry.transcript_path = transcriptPath;

    let fileStat;
    try {
      fileStat = await stat(transcriptPath);
    } catch (err) {
      await writeErrorLog(ctx, `WARN: transcript not accessible: ${err.message}`);
      return OUTPUT_NONE;
    }

    let offset = Number(entry.transcript_read_offset || 0);
    if (offset > fileStat.size) offset = 0;

    let chunk = '';
    try {
      const fh = await open(transcriptPath, 'r');
      try {
        const toRead = fileStat.size - offset;
        if (toRead <= 0) return OUTPUT_NONE;
        const buf = Buffer.alloc(toRead);
        await fh.read(buf, 0, toRead, offset);
        chunk = buf.toString('utf8');
      } finally {
        await fh.close();
      }
    } catch (err) {
      await writeErrorLog(ctx, `WARN: transcript read failed: ${err.message}`);
      return OUTPUT_NONE;
    }

    const endsWithNewline = chunk.endsWith('\n');
    const lines = chunk.split('\n');
    const consumedLines = endsWithNewline ? lines.slice(0, -1) : lines.slice(0, -1);
    const consumedBytes = Buffer.byteLength(
      consumedLines.join('\n') + (consumedLines.length > 0 ? '\n' : ''),
      'utf8',
    );
    const newOffset = offset + consumedBytes;

    const assistantTexts = [];
    for (const line of consumedLines) {
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj || obj.type !== 'assistant') continue;
      const content = obj.message && obj.message.content;
      if (!Array.isArray(content)) continue;
      const textParts = content
        .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text);
      if (textParts.length === 0) continue;
      assistantTexts.push(textParts.join(''));
    }

    entry.transcript_read_offset = newOffset;

    if (assistantTexts.length === 0) {
      return OUTPUT_NONE;
    }

    assistantText = assistantTexts.join('\n\n');
  }

  const masked = mask(assistantText);
  const body = `\n## Assistant (${ts.clock})\n\n${masked}\n`;
  await appendFile(join(ctx.sessionLogsDir, entry.file), body, 'utf8');
  entry.counters.assistant_turns += 1;
  return OUTPUT_NONE;
}

async function handleToolUse(normEv, ctx, index, entry, ts) {
  const tu = normEv.toolUse || {};
  const toolName = tu.name;
  const input = tu.input || {};
  const response = tu.response || {};

  if (toolName === 'Bash') {
    const cmd = input.command;
    if (typeof cmd !== 'string' || cmd.length === 0) return OUTPUT_NONE;
    if (isAllBlocked(cmd)) return OUTPUT_NONE;

    const maskedCmd = mask(cmd);
    const stdoutRaw = truncate(response.stdout || '', MAX_STDOUT_CHARS);
    const stdoutMasked = mask(stdoutRaw);

    const parts = [
      '',
      `> [!terminal]- Bash (${ts.clock})`,
      '> ```bash',
      ...maskedCmd.split('\n').map((l) => `> ${l}`),
      '> ```',
    ];
    if (stdoutMasked) parts.push(quoteCallout(stdoutMasked));
    parts.push('');
    await appendFile(join(ctx.sessionLogsDir, entry.file), parts.join('\n'), 'utf8');
    entry.counters.bash_commands_logged += 1;
    return OUTPUT_NONE;
  }

  if (toolName === 'Edit' || toolName === 'Write') {
    const filePath = input.file_path || '';
    const body = `\n> [!file] ${toolName}: ${filePath} (${ts.clock})\n`;
    await appendFile(join(ctx.sessionLogsDir, entry.file), body, 'utf8');
    entry.counters.file_edits += 1;
    return OUTPUT_NONE;
  }

  if (toolName === 'MultiEdit') {
    const filePath = input.file_path || '';
    const n = Array.isArray(input.edits) ? input.edits.length : 0;
    const body = `\n> [!file] MultiEdit: ${filePath} (${ts.clock}) — ${n} edits\n`;
    await appendFile(join(ctx.sessionLogsDir, entry.file), body, 'utf8');
    entry.counters.file_edits += 1;
    return OUTPUT_NONE;
  }

  return OUTPUT_NONE;
}

async function handleSessionEnd(normEv, ctx, index, entry, ts) {
  const c = entry.counters;
  // §35 fix: reason は CLI が現状 enum 文字列のみを入れるが、将来 vendor schema
  // drift で free-form 文字列に拡張される可能性に備え、他の user-controlled
  // field と同様 mask + yamlSafeValue を必ず通す (open-issues §35、原典 plan/
  // claude/26042408 §3 item 3)。
  const rawReason = normEv.sessionEnd?.reason || 'unknown';
  const exitReason = yamlSafeValue(mask(rawReason));
  const body = [
    '',
    '---',
    '',
    `## Session Summary (${ts.clock})`,
    '',
    `- exit_reason: ${exitReason}`,
    `- user_prompts: ${c.user_prompts}`,
    `- assistant_turns: ${c.assistant_turns}`,
    `- bash_commands_logged: ${c.bash_commands_logged}`,
    `- file_edits: ${c.file_edits}`,
    '',
  ].join('\n');
  await appendFile(join(ctx.sessionLogsDir, entry.file), body, 'utf8');
  return OUTPUT_NONE;
}

async function handleSessionStart() {
  // session_start は Claude 側は session-logger scope 外 (wiki-context-injector.mjs 管轄、MF5)。
  // 他 agent (Gemini / Codex) からも session log は作らない設計 (最初の user_prompt で作成)。
  return OUTPUT_NONE;
}

async function handlePostCompact() {
  // post_compact は hot.md injection 専用、本 core は session log append しない (scope 分離)。
  return OUTPUT_NONE;
}

/** @type {Record<string, (normEv: NormalizedEvent, ctx: Context, index: any, entry: any, ts: any) => Promise<OutputIntent>>} */
const HANDLERS = {
  user_prompt: handleUserPrompt,
  assistant_stop: handleAssistantStop,
  tool_use: handleToolUse,
  session_start: handleSessionStart,
  session_end: handleSessionEnd,
  post_compact: handlePostCompact,
};

// -----------------------------------------------------------------------------
// Context 構築 (adapter が呼ぶ)
// -----------------------------------------------------------------------------

/**
 * OBSIDIAN_VAULT から Context を構築。vault が未設定 / cwd が vault 内 / vault が
 * ディレクトリでない等の理由で hook を no-op 化する条件は null を返す。
 *
 * Self-recursion guard (cwd in vault → null) は **Claude 専用** (§43、v0.7.0 fix):
 *   - auto-ingest cron が `claude -p` を vault dir で起動 → hook 発火 → log 増殖
 *     → 再 ingest → 無限 loop の trap を防ぐため、Claude では cwd in vault で no-op 化
 *   - 非 Claude agent (Gemini / Codex) は auto-ingest が呼ばないため再帰 risk 無し、
 *     vault 内 cwd でも普通に log 取る (RYU 2026-04-27 Codex 実機 verify で発見)
 *   - default は agent='claude' (back-compat、未指定時は guard fire)
 *
 * @param {{ agent?: 'claude' | 'gemini' | 'codex' }} [opts]
 * @returns {Promise<Context|null>}
 */
export async function buildContext({ agent = 'claude' } = {}) {
  const vault = process.env.OBSIDIAN_VAULT;
  if (!vault) return null;

  // Self-recursion guard: Claude のみ (auto-ingest re-entrance 防止)
  if (agent === 'claude') {
    try {
      const realVault = await realpath(vault);
      const realCwd = await realpath(process.cwd());
      if (realCwd === realVault || realCwd.startsWith(realVault + '/')) return null;
    } catch (err) {
      // §34 fix: realpath 失敗 (EROFS / ENOENT / EACCES on symlink target 等) は
      // throw せず literal path で best-effort fallback compare を継続する。
      // 観測性のため KIOKU_DEBUG=1 のときだけ stderr に warn を出す
      // (open-issues §34、原典 plan/claude/26042408 §3 item 2)。
      if (envTruthy(process.env.KIOKU_DEBUG)) {
        try {
          process.stderr.write(
            `[claude-brain] buildContext realpath fallback: ${(err && err.message) || 'unknown'}\n`,
          );
        } catch {
          /* ignore */
        }
      }
      const cwd = process.cwd();
      if (cwd === vault || cwd.startsWith(vault + '/')) return null;
    }
  }

  try {
    const s = await stat(vault);
    if (!s.isDirectory()) return null;
  } catch {
    return null;
  }

  const sessionLogsDir = join(vault, 'session-logs');
  const internalDir = join(sessionLogsDir, '.claude-brain');
  const indexPath = join(internalDir, 'index.json');
  return { vault, sessionLogsDir, internalDir, indexPath };
}

// -----------------------------------------------------------------------------
// BLUE-CORE-VAL: NormalizedEvent 独立 validation (adapter を信頼せず、MF4)
// -----------------------------------------------------------------------------

export class CoreValidationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export function validateNormalizedEvent(normEv) {
  // BLUE-CORE-VAL-1: object
  if (!normEv || typeof normEv !== 'object') {
    throw new CoreValidationError('BLUE-CORE-VAL-1', 'normEv is not an object');
  }
  // BLUE-CORE-VAL-2: sessionId が ASCII + `-` / `_` の非空
  if (typeof normEv.sessionId !== 'string' || normEv.sessionId.length === 0) {
    throw new CoreValidationError('BLUE-CORE-VAL-2', 'sessionId is empty');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(normEv.sessionId)) {
    throw new CoreValidationError('BLUE-CORE-VAL-2', 'sessionId has forbidden characters');
  }
  // BLUE-CORE-VAL-3: sessionId length cap
  if (normEv.sessionId.length > MAX_SESSION_ID_CHARS) {
    throw new CoreValidationError('BLUE-CORE-VAL-3', 'sessionId too long');
  }
  // BLUE-CORE-VAL-4: eventName closed enum
  if (!EVENT_NAMES.has(normEv.eventName)) {
    throw new CoreValidationError('BLUE-CORE-VAL-4', `unknown eventName: ${normEv.eventName}`);
  }
  // BLUE-CORE-VAL-5: agent closed enum
  if (!AGENT_NAMES.has(normEv.agent)) {
    throw new CoreValidationError('BLUE-CORE-VAL-5', `unknown agent: ${normEv.agent}`);
  }
  // BLUE-CORE-VAL-6: timestamp is Date
  if (!(normEv.timestamp instanceof Date) || Number.isNaN(normEv.timestamp.valueOf())) {
    throw new CoreValidationError('BLUE-CORE-VAL-6', 'timestamp must be a valid Date');
  }
  // BLUE-CORE-VAL-7: userPrompt.text 型 (存在時)
  if (normEv.userPrompt !== undefined) {
    if (!normEv.userPrompt || typeof normEv.userPrompt.text !== 'string') {
      throw new CoreValidationError('BLUE-CORE-VAL-7', 'userPrompt.text must be a string');
    }
  }
  // BLUE-CORE-VAL-8: toolUse.name 型 (存在時) / cwd 型 (存在時)
  if (normEv.toolUse !== undefined) {
    if (!normEv.toolUse || typeof normEv.toolUse.name !== 'string' || normEv.toolUse.name.length === 0) {
      throw new CoreValidationError('BLUE-CORE-VAL-8', 'toolUse.name must be a non-empty string');
    }
  }
  if (normEv.cwd !== undefined && typeof normEv.cwd !== 'string') {
    throw new CoreValidationError('BLUE-CORE-VAL-8', 'cwd must be a string if present');
  }
}

// -----------------------------------------------------------------------------
// 主要 entry: ingestNormalizedEvent
// -----------------------------------------------------------------------------

/**
 * adapter から呼ばれる単一 entry point。core は adapter を信頼せず validation +
 * mkdir + lock + handler dispatch + index 永続化を行う。戻り値は OutputIntent
 * (v0.7.0 現状は { type: 'none' } のみ使用、将来 systemMessage / hookSpecificOutput 拡張余地)。
 *
 * @param {NormalizedEvent} normEv
 * @param {Context} ctx
 * @returns {Promise<OutputIntent>}
 */
export async function ingestNormalizedEvent(normEv, ctx) {
  validateNormalizedEvent(normEv);

  if (!ctx || typeof ctx.sessionLogsDir !== 'string' || typeof ctx.indexPath !== 'string') {
    throw new CoreValidationError('BLUE-CORE-VAL-CTX', 'invalid context');
  }

  // mkdir 0o700 (adapter が buildContext 済でも race 回避のため再 mkdir)
  await mkdir(ctx.sessionLogsDir, { recursive: true, mode: 0o700 });
  await mkdir(ctx.internalDir, { recursive: true, mode: 0o700 });

  const ts = localNow(normEv.timestamp || new Date());
  const handler = HANDLERS[normEv.eventName];
  if (!handler) {
    // defensive: enum validator が通っているはずだが保険
    return OUTPUT_NONE;
  }

  const lockPath = await acquireIndexLock(ctx);
  try {
    const index = await loadIndex(ctx);
    let entry;
    try {
      entry = await ensureSessionFile(ctx, index, normEv, ts);
      if (!entry) {
        // ghost session (non-user_prompt が先着): index / file いずれも触らず終了
        debugLog(ctx, `skipped ghost ${normEv.eventName} session=${normEv.sessionId.slice(0, 8)}`);
        return OUTPUT_NONE;
      }
      const intent = await handler(normEv, ctx, index, entry, ts);
      await saveIndex(ctx, index);
      debugLog(ctx, `handled ${normEv.eventName} session=${normEv.sessionId.slice(0, 8)}`);
      return intent || OUTPUT_NONE;
    } catch (err) {
      await writeErrorLog(ctx, `ERROR: handler failed (${normEv.eventName}): ${err && err.message}`);
      throw err;
    }
  } finally {
    await releaseIndexLock(lockPath);
  }
}
