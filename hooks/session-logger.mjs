#!/usr/bin/env node
// session-logger.mjs — claude-brain Hook 本体
//
// Claude Code の Hook イベントを stdin JSON で受け取り、1 セッション = 1 Markdown
// ファイルとして $OBSIDIAN_VAULT/session-logs/ に追記する。
// Node 18+ 組み込みモジュールのみ使用。外部ネットワーク禁止。
// エラー時も常に exit 0 (Claude Code をブロックしないフェイルセーフ)。

import { appendFile, mkdir, readFile, writeFile, rename, open, stat, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';

import { maskText as mask } from '../scripts/lib/masking.mjs';

// -----------------------------------------------------------------------------
// 定数
// -----------------------------------------------------------------------------

const INDEX_VERSION = 1;
const MAX_STDOUT_CHARS = 2000;
const MAX_TITLE_CODEPOINTS = 50;

const BASH_BLOCKLIST = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'which', 'where', 'type',
  'echo', 'printf', 'pwd', 'cd', 'test', 'true', 'false', 'grep', 'rg', 'find',
  'diff', 'sort', 'uniq', 'tr', 'cut', 'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'ln',
  'chmod', 'chown', 'touch', 'basename', 'dirname', 'realpath', 'readlink',
  'tree', 'du', 'df', 'less', 'more', 'xargs', 'tee', 'whoami', 'hostname',
  'date', 'uname', 'env', 'set', 'export', 'alias', 'id', 'jq',
]);

// マスキング規則 (MASK_RULES) は ../scripts/lib/masking.mjs に集約した。
// 新パターン追加時はそちらのコメント (同期対象 3 箇所) を参照すること。
// v0.4.0 Tier B#1: 旧自前 mask() を削除し maskText() に委譲。INVISIBLE_CHARS
// 除去 + NFC 正規化を Hook 経路にも適用 (RED-L0-01 / BLUE-L0-01)。

// 環境変数の真偽判定を 1 / true / yes / on (case-insensitive) に統一する。
// 既定は fail-safe (値が不明瞭なら falsy 側に倒さず truthy に寄せる) 設計。
// KIOKU_NO_LOG は "true" でも発火すべき (再帰ログ防止の本意)。
// v0.4.0 Tier B#1 (BLUE-L0-02): strict `=== '1'` の truthy drift 対策。
function envTruthy(val) {
  if (!val) return false;
  return /^(1|true|yes|on)$/i.test(String(val).trim());
}

// YAML スカラー値を安全に埋め込むためのヘルパ。
// - 制御文字 (U+0000..U+001F, U+007F) と Unicode 不可視/区切り文字を除去。
// - YAML 構造文字を含む場合は単一引用符で囲み、単引用符自体は '' に倍化する。
// v0.4.0 Tier B#1 (RED-L0-02): frontmatter injection 対策。
// session_id / cwd / project_dir が改行や `---` を含む場合に YAML 境界を偽装
// できないようにする。
function yamlSafeValue(v) {
  if (v == null) return '';
  let s = String(v)
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\u200B-\u200F\u2028-\u2029\uFEFF]/g, '');
  if (/[:#&*!|>'"%@`[\]{},]|^\s|\s$|^[-?~]|^(null|true|false|yes|no|on|off)$/i.test(s)) {
    return `'${s.replace(/'/g, "''")}'`;
  }
  return s;
}

// -----------------------------------------------------------------------------
// ユーティリティ
// -----------------------------------------------------------------------------

function debugLog(ctx, msg) {
  if (!envTruthy(process.env.KIOKU_DEBUG)) return;
  process.stderr.write(`[claude-brain] ${msg}\n`);
  writeErrorLog(ctx, `DEBUG: ${msg}`).catch(() => {});
}

async function writeErrorLog(ctx, msg) {
  if (!ctx || !ctx.internalDir) return;
  try {
    await mkdir(ctx.internalDir, { recursive: true });
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    await appendFile(join(ctx.internalDir, 'errors.log'), line, 'utf8');
  } catch {
    // 無視: エラーログ書き込み失敗は黙殺
  }
}

// ローカルタイムゾーンのタイムスタンプ生成 (OSS-001: Asia/Tokyo ハードコードを廃止)
function localNow(date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const YYYY = date.getFullYear();
  const MM = pad(date.getMonth() + 1);
  const DD = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  // タイムゾーンオフセットを計算 (getTimezoneOffset は UTC - local を分で返す)
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

function sanitizeSidPrefix(sessionId) {
  const head = String(sessionId || '').slice(0, 4).toLowerCase();
  return head.replace(/[^a-z0-9]/g, '_') || '____';
}

// プロンプト文字列をファイル名用にサニタイズする
function sanitizeTitle(raw) {
  if (!raw || typeof raw !== 'string') return 'untitled';
  let s = raw;
  // 1. 制御文字 → 空白
  s = s.replace(/[\x00-\x1f\x7f]/g, ' ');
  // 2. パス区切り → -
  s = s.replace(/[/\\]/g, '-');
  // 3. Windows 予約文字 → -
  s = s.replace(/[<>:"|?*]/g, '-');
  // 4. Unicode NFC 正規化
  s = s.normalize('NFC');
  // 5. 連続空白を 1 つに、空白を -
  s = s.replace(/\s+/g, ' ').trim().replace(/ /g, '-');
  // 6. 先頭末尾の - と . をトリム
  s = s.replace(/^[-.]+|[-.]+$/g, '');
  // 7. 最大 50 code point (surrogate safe)
  const codepoints = Array.from(s);
  if (codepoints.length > MAX_TITLE_CODEPOINTS) {
    s = codepoints.slice(0, MAX_TITLE_CODEPOINTS).join('');
    s = s.replace(/^[-.]+|[-.]+$/g, '');
  }
  return s || 'untitled';
}

function buildFileName({ compactDate, compactTime }, sessionId, title) {
  const sid4 = sanitizeSidPrefix(sessionId);
  return `${compactDate}-${compactTime}-${sid4}-${title}.md`;
}

// -----------------------------------------------------------------------------
// stdin 読み込み
// -----------------------------------------------------------------------------

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// -----------------------------------------------------------------------------
// 索引ファイル管理
// -----------------------------------------------------------------------------

async function loadIndex(ctx) {
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
    // 破損 → 退避
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

async function saveIndex(ctx, index) {
  const tmp = `${ctx.indexPath}.tmp`;
  const payload = JSON.stringify(index, null, 2);
  await writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, ctx.indexPath);
}

function newSessionEntry(fileName, isoDate, transcriptPath) {
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
// セッションファイル解決 (索引 lookup + 新規作成)
// -----------------------------------------------------------------------------

async function ensureSessionFile(ctx, index, payload, ts) {
  const sid = payload.session_id;
  const existing = index.sessions[sid];
  if (existing) {
    // transcript_path が後から到着する場合は記録しておく
    if (!existing.transcript_path && payload.transcript_path) {
      existing.transcript_path = payload.transcript_path;
    }
    return existing;
  }

  // 新規セッション: 最初のイベントが UserPromptSubmit + prompt でなければ作成しない。
  // これにより Claude Code のサブエージェント等が発行する「ユーザー発話を伴わない」
  // ゴーストセッションのファイル生成を防ぐ。
  if (payload.hook_event_name !== 'UserPromptSubmit' || !payload.prompt) {
    return null;
  }

  const title = sanitizeTitle(payload.prompt);
  const fileName = buildFileName(ts, sid, title);
  const entry = newSessionEntry(fileName, ts.iso, payload.transcript_path);
  entry.first_prompt_saved = true;
  index.sessions[sid] = entry;

  const filePath = join(ctx.sessionLogsDir, fileName);
  const fm = buildFrontmatter(payload, ts);
  await writeFile(filePath, fm, { encoding: 'utf8', mode: 0o600, flag: 'wx' });

  return entry;
}

function buildFrontmatter(payload, ts) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || '';
  const lines = [
    '---',
    'type: session-log',
    `session_id: ${yamlSafeValue(payload.session_id)}`,
    `hostname: ${yamlSafeValue(hostname())}`,
    `cwd: ${yamlSafeValue(payload.cwd || '')}`,
    `date: ${ts.iso}`,
    `project_dir: ${projectDir ? yamlSafeValue(projectDir) : 'null'}`,
    'ingested: false',
    'related: []',
    '---',
    '',
  ];
  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// イベントハンドラ
// -----------------------------------------------------------------------------

async function handleUserPromptSubmit(payload, ctx, index, entry, ts) {
  if (typeof payload.prompt !== 'string' || payload.prompt.length === 0) return;
  const masked = mask(payload.prompt);
  const body = `\n## User (${ts.clock})\n\n${masked}\n`;
  await appendFile(join(ctx.sessionLogsDir, entry.file), body, 'utf8');
  entry.counters.user_prompts += 1;
}

async function handleStop(payload, ctx, index, entry, ts) {
  // transcript_path から差分 assistant メッセージを抽出
  const transcriptPath = payload.transcript_path || entry.transcript_path;
  if (!transcriptPath) {
    await writeErrorLog(ctx, `WARN: Stop without transcript_path (session=${payload.session_id})`);
    return;
  }
  entry.transcript_path = transcriptPath;

  let fileStat;
  try {
    fileStat = await stat(transcriptPath);
  } catch (err) {
    await writeErrorLog(ctx, `WARN: transcript not accessible: ${err.message}`);
    return;
  }

  let offset = Number(entry.transcript_read_offset || 0);
  if (offset > fileStat.size) {
    // rotate / truncate 検知 → 最初から読み直す
    offset = 0;
  }

  let chunk = '';
  try {
    const fh = await open(transcriptPath, 'r');
    try {
      const toRead = fileStat.size - offset;
      if (toRead <= 0) return;
      const buf = Buffer.alloc(toRead);
      await fh.read(buf, 0, toRead, offset);
      chunk = buf.toString('utf8');
    } finally {
      await fh.close();
    }
  } catch (err) {
    await writeErrorLog(ctx, `WARN: transcript read failed: ${err.message}`);
    return;
  }

  // 完結した行だけ処理。末尾が改行で終わらない場合、最後の行は保留
  const endsWithNewline = chunk.endsWith('\n');
  const lines = chunk.split('\n');
  const consumedLines = endsWithNewline ? lines.slice(0, -1) : lines.slice(0, -1);
  const tail = endsWithNewline ? '' : lines[lines.length - 1];

  const consumedBytes = Buffer.byteLength(
    consumedLines.join('\n') + (consumedLines.length > 0 ? '\n' : ''),
    'utf8',
  );
  const newOffset = offset + consumedBytes;

  // assistant テキストを抽出
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
    // 全ての assistant 行が thinking/tool_use だけだった場合 → 何も書かない
    // (ただしスキーマ不一致検知のため、何らかの assistant 行はあったはず)
    return;
  }

  const combined = assistantTexts.join('\n\n');
  const masked = mask(combined);
  const body = `\n## Assistant (${ts.clock})\n\n${masked}\n`;
  await appendFile(join(ctx.sessionLogsDir, entry.file), body, 'utf8');
  entry.counters.assistant_turns += 1;
  void tail;
}

function splitBashCommand(cmd) {
  // ; && || | で分割 (厳密ではないが簡易でよい)
  const segments = cmd.split(/(?:;|&&|\|\||\|)/);
  return segments.map((s) => s.trim()).filter(Boolean);
}

function firstWord(segment) {
  const m = segment.match(/^\s*([^\s]+)/);
  if (!m) return '';
  // 環境変数代入 (FOO=bar cmd) はスキップして次の語へ
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(m[1])) {
    const rest = segment.replace(/^\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s*/, '');
    return firstWord(rest);
  }
  return m[1];
}

function isAllBlocked(cmd) {
  const segments = splitBashCommand(cmd);
  if (segments.length === 0) return true;
  for (const seg of segments) {
    const word = firstWord(seg);
    if (!BASH_BLOCKLIST.has(word)) return false;
  }
  return true;
}

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  if (s.length <= n) return s;
  return s.slice(0, n) + ' ... (truncated)';
}

function quoteCallout(text) {
  return text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

async function handlePostToolUse(payload, ctx, index, entry, ts) {
  const toolName = payload.tool_name;
  const input = payload.tool_input || {};
  const response = payload.tool_response || {};

  if (toolName === 'Bash') {
    const cmd = input.command;
    if (typeof cmd !== 'string' || cmd.length === 0) return;
    if (isAllBlocked(cmd)) return;

    const maskedCmd = mask(cmd);
    const stdout = mask(truncate(response.stdout || '', MAX_STDOUT_CHARS));

    const parts = [
      '',
      `> [!terminal]- Bash (${ts.clock})`,
      '> ```bash',
      ...maskedCmd.split('\n').map((l) => `> ${l}`),
      '> ```',
    ];
    if (stdout) {
      parts.push(quoteCallout(stdout));
    }
    parts.push('');
    await appendFile(join(ctx.sessionLogsDir, entry.file), parts.join('\n'), 'utf8');
    entry.counters.bash_commands_logged += 1;
    return;
  }

  if (toolName === 'Edit' || toolName === 'Write') {
    const filePath = input.file_path || '';
    const body = `\n> [!file] ${toolName}: ${filePath} (${ts.clock})\n`;
    await appendFile(join(ctx.sessionLogsDir, entry.file), body, 'utf8');
    entry.counters.file_edits += 1;
    return;
  }

  if (toolName === 'MultiEdit') {
    const filePath = input.file_path || '';
    const n = Array.isArray(input.edits) ? input.edits.length : 0;
    const body = `\n> [!file] MultiEdit: ${filePath} (${ts.clock}) — ${n} edits\n`;
    await appendFile(join(ctx.sessionLogsDir, entry.file), body, 'utf8');
    entry.counters.file_edits += 1;
    return;
  }
  // それ以外のツールは記録しない
}

async function handleSessionEnd(payload, ctx, index, entry, ts) {
  const c = entry.counters;
  const exitReason = payload.exit_reason || 'unknown';
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
}

const HANDLERS = {
  UserPromptSubmit: handleUserPromptSubmit,
  Stop: handleStop,
  PostToolUse: handlePostToolUse,
  SessionEnd: handleSessionEnd,
  // SessionStart: 将来追加する場合はここに 1 行
};

// -----------------------------------------------------------------------------
// メイン
// -----------------------------------------------------------------------------

async function main() {
  // KIOKU_NO_LOG が truthy (1 / true / yes / on) のときは Hook 全体を no-op 化する。
  // auto-ingest.sh / auto-lint.sh が起動する claude -p サブプロセスは
  // 親の ~/.claude/settings.json を継承するため、このフラグがないと
  // サブプロセス自身の活動が session-logs/ に再帰的に記録されてしまう。
  // v0.4.0 Tier B#1 (BLUE-L0-02): strict `=== '1'` から envTruthy 経由に変更し、
  // ユーザーが直感的に `=true` と書いた場合の silent drift を防ぐ (fail-safe)。
  if (envTruthy(process.env.KIOKU_NO_LOG)) return;

  const vault = process.env.OBSIDIAN_VAULT;
  if (!vault) return;

  // VULN-003 + OSS-011: cwd が Vault 内の場合も no-op 化 (symlink も解決して比較)
  try {
    const realVault = await realpath(vault);
    const realCwd = await realpath(process.cwd());
    if (realCwd === realVault || realCwd.startsWith(realVault + '/')) return;
  } catch {
    // realpath 失敗時はフォールバック (vault が存在しない等)
    const cwd = process.cwd();
    if (cwd === vault || cwd.startsWith(vault + '/')) return;
  }

  try {
    const s = await stat(vault);
    if (!s.isDirectory()) return;
  } catch {
    return;
  }

  const sessionLogsDir = join(vault, 'session-logs');
  const internalDir = join(sessionLogsDir, '.claude-brain');
  const indexPath = join(internalDir, 'index.json');
  const ctx = { vault, sessionLogsDir, internalDir, indexPath };

  let payload;
  try {
    const raw = await readStdin();
    if (!raw.trim()) return;
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  if (!payload || typeof payload !== 'object') return;
  if (!payload.session_id || !payload.hook_event_name) return;

  const handler = HANDLERS[payload.hook_event_name];
  if (!handler) return;

  try {
    await mkdir(sessionLogsDir, { recursive: true, mode: 0o700 });
    await mkdir(internalDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    await writeErrorLog(ctx, `ERROR: mkdir failed: ${err.message}`);
    return;
  }

  const ts = localNow();
  const index = await loadIndex(ctx);

  let entry;
  try {
    entry = await ensureSessionFile(ctx, index, payload, ts);
    if (!entry) {
      // 新規セッションで UserPromptSubmit 以外のイベントが先に来たケース (ghost)。
      // ファイルも index も触らずに終了する。
      debugLog(ctx, `skipped ghost ${payload.hook_event_name} session=${payload.session_id.slice(0, 8)}`);
      return;
    }
    await handler(payload, ctx, index, entry, ts);
  } catch (err) {
    await writeErrorLog(ctx, `ERROR: handler failed (${payload.hook_event_name}): ${err.message}`);
    return;
  }

  try {
    await saveIndex(ctx, index);
  } catch (err) {
    await writeErrorLog(ctx, `ERROR: saveIndex failed: ${err.message}`);
  }

  debugLog(ctx, `handled ${payload.hook_event_name} session=${payload.session_id.slice(0, 8)}`);
}

process.on('unhandledRejection', (err) => {
  process.stderr.write(`[claude-brain] unhandledRejection: ${err && err.message}\n`);
  process.exit(0);
});

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
