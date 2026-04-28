// git-history.mjs — Git 履歴を Visualizer (Phase D α) から読むための read-only 抽象
//
// 使い方:
//   const { commits, truncated, error } = await getFileHistory(vaultDir, { since: '2026-01-01', subPath: 'wiki/' });
//   const content = await getFileContentAtCommit(vaultDir, sha, 'wiki/index.md');
//
// Security / Trust boundary (plan 26042402 §Security + review 26042403):
//   - 全て **spawn('git', [...])** で argv 配列渡し (shell injection 回避、KIOKU 既存 pattern 踏襲)
//   - `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c protocol.version=2` を全 runGit に inject
//     + env に `GIT_CONFIG_NOSYSTEM=1` を追加 (vault .git/config 侵害時の RCE trap 防御 = H1)
//   - sha / relPath / subPath は allow-list で validation (H2)
//   - vaultDir は cwd としてのみ使用 (ディレクトリ存在確認は呼び出し側)
//   - 非 git repo / git 未インストール時は shape 保持で観測可能 error を返す (fail-safe, H3)
//   - 外部ネットワーク一切なし、git fetch/push は呼ばない (read-only: log, show, rev-parse, ls-tree)
//   - stdout は size cap でくくる (非常に大きな repo 対応、現状 16 MiB 上限)
//   - SIGTERM 後 2 秒で SIGKILL escalation + spawn option timeout 60s (M1: smudge filter hang 防御)
//   - close/error race を settled flag で gate (H4: ENOENT 時の double-resolve 防止)
//   - `ls-tree -z` / `log -z` で NUL separator を使用 (M6+M7: 日本語 filename / newline-in-subject 対応)
//
// 正典: plan/claude/26042402_visualizer-concept-sketch.md §View 1 / §View 2
//       plan/claude/26042403_meeting_v1-visualizer-review.md §HIGH + §Medium + §P1/P2

import { spawn } from 'node:child_process';

const MAX_STDOUT_BYTES = 16 * 1024 * 1024; // 16 MiB
const GIT_CMD = 'git';

// H1: fsmonitor / hooksPath / protocol を hard-code で無効化。
// .git/config 侵害時の任意コード実行経路 (fsmonitor / pre-command hook / http.* via protocol v1) を遮断。
const SAFE_CONFIG = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'protocol.version=2',
];

// H2: relPath / subPath validator。日本語 / CJK / ASCII / 空白 / ハイフン / ドット / スラッシュ / アンダースコア を許容。
// revspec に悪用される ':'、pathspec escape の '..'、絶対パスの '/' 先頭は reject。
// 参考: Obsidian のページ名に使われる文字集合 + 多言語 ingestion 実績。
const SAFE_RELPATH_RE = /^[\p{L}\p{N}_./\- ]+$/u;

// M5: SHA-1 (40 hex) に加え SHA-256 (64 hex) も許容。short sha は 4 文字以上。
const SHA_RE = /^[0-9a-f]{4,64}$/;

// M1: smudge filter 等で SIGTERM 後に hang した場合の強制 kill までの待ち時間
const SIGKILL_TIMEOUT_MS = 2000;
// spawn option timeout (Node 15.1+): 全体上限 60 秒
const SPAWN_TIMEOUT_MS = 60000;

export class GitHistoryError extends Error {
  constructor(message, code = 'git_error') {
    super(message);
    this.name = 'GitHistoryError';
    this.code = code;
  }
}

function assertSafeRelPath(value, fieldName) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new GitHistoryError(`${fieldName} must be non-empty string <= 4096 chars`, 'invalid_args');
  }
  if (value.includes('\0') || value.includes(':') || value.includes('..') || value.startsWith('/')) {
    throw new GitHistoryError(`invalid ${fieldName} (path traversal or revspec injection)`, 'invalid_args');
  }
  if (!SAFE_RELPATH_RE.test(value)) {
    throw new GitHistoryError(`invalid ${fieldName} (unsafe characters)`, 'invalid_args');
  }
}

// 内部: git コマンドを spawn で実行し、stdout/stderr/code を返す
// args は必ず配列で渡す (shell injection 回避)
async function runGit(cwd, args) {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new GitHistoryError('git args must be array of strings', 'invalid_args');
  }
  return new Promise((resolve) => {
    let settled = false; // H4: close/error race gate
    const child = spawn(GIT_CMD, [...SAFE_CONFIG, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1', // H1: /etc/gitconfig を無視
        LC_ALL: 'C',
      },
      timeout: SPAWN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let truncated = false;
    let sigkillTimer = null;

    const escalateKill = () => {
      if (sigkillTimer) return;
      sigkillTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already exited */
        }
      }, SIGKILL_TIMEOUT_MS);
      sigkillTimer.unref?.();
    };

    child.stdout.on('data', (chunk) => {
      if (stdoutBytes + chunk.length > MAX_STDOUT_BYTES) {
        truncated = true;
        const remaining = MAX_STDOUT_BYTES - stdoutBytes;
        if (remaining > 0) {
          stdoutChunks.push(chunk.subarray(0, remaining));
          stdoutBytes = MAX_STDOUT_BYTES;
        }
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        escalateKill();
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (sigkillTimer) clearTimeout(sigkillTimer);
      resolve({
        code: -1,
        stdout: '',
        stderr: err.message,
        truncated: false,
        spawnError: err,
      });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (sigkillTimer) clearTimeout(sigkillTimer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        truncated,
      });
    });
  });
}

// vaultDir が git repo かどうか判定 (rev-parse --git-dir で安価に)
export async function isGitRepo(vaultDir) {
  if (typeof vaultDir !== 'string' || vaultDir.length === 0) return false;
  const res = await runGit(vaultDir, ['rev-parse', '--is-inside-work-tree']);
  if (res.code !== 0) return false;
  return res.stdout.trim() === 'true';
}

// since は ISO 8601 date (例: "2026-01-01") もしくは git が受理する任意書式
// subPath は vault-relative (例: "wiki/" / "wiki/index.md")、空なら全体
// maxCommits は安全上限 (default 1000)
// 返り値 (H3 / plan P2 observability contract):
//   { commits: [{sha, shortSha, timestamp, author, subject, files}], truncated, error }
//   commits は新しい順、git が無い / repo じゃない場合は commits=[], error='not_a_git_repo'
export async function getFileHistory(vaultDir, options = {}) {
  if (!(await isGitRepo(vaultDir))) {
    return { commits: [], truncated: false, error: 'not_a_git_repo' };
  }
  const { since, subPath = '', maxCommits = 1000 } = options;
  if (typeof maxCommits !== 'number' || maxCommits < 1 || maxCommits > 100000) {
    throw new GitHistoryError('maxCommits out of range (1..100000)', 'invalid_args');
  }
  if (typeof subPath !== 'string') {
    throw new GitHistoryError('subPath must be string', 'invalid_args');
  }
  if (subPath.length > 0) {
    assertSafeRelPath(subPath, 'subPath'); // H2
  }
  if (since !== undefined && typeof since !== 'string') {
    throw new GitHistoryError('since must be a string', 'invalid_args'); // M8
  }
  // M6+M7: -z で commit record を NUL terminated、field は \x01 separator。
  // subject に newline / \x01 を含んでいても確実に parse 可能。
  const args = [
    'log',
    '--name-only',
    '--no-decorate',
    '--no-merges',
    `--max-count=${maxCommits}`,
    '-z',
    '--format=KIOKU%x01%H%x01%h%x01%ct%x01%an%x01%s',
  ];
  if (since) args.push(`--since=${since}`);
  args.push('--');
  if (subPath) args.push(subPath);

  const res = await runGit(vaultDir, args);
  if (res.code !== 0) {
    return {
      commits: [],
      truncated: res.truncated,
      error: res.spawnError ? res.spawnError.message : (res.stderr || `git exit ${res.code}`),
    };
  }
  return {
    commits: parseGitLogOutput(res.stdout),
    truncated: res.truncated,
    error: null,
  };
}

// 単一 commit の指定ファイル内容を取得、不在時は null
// relPath は vault-relative (例: 'wiki/index.md')。allowedPrefixes が指定されたら prefix 縛り。
export async function getFileContentAtCommit(vaultDir, sha, relPath, options = {}) {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
    throw new GitHistoryError('invalid sha format', 'invalid_args');
  }
  assertSafeRelPath(relPath, 'relPath'); // H2 + M4
  const { allowedPrefixes } = options;
  if (Array.isArray(allowedPrefixes) && allowedPrefixes.length > 0) {
    const ok = allowedPrefixes.some((p) => typeof p === 'string' && relPath.startsWith(p));
    if (!ok) {
      throw new GitHistoryError(`relPath must start with one of: ${allowedPrefixes.join(', ')}`, 'invalid_args');
    }
  }
  const res = await runGit(vaultDir, ['show', `${sha}:${relPath}`]);
  if (res.code !== 0) {
    // non-existent file at that commit は正常ケース → null
    return null;
  }
  return res.stdout;
}

// 指定 commit での wiki/ 配下の md file 一覧 (path のみ)
// 実際の tree を ls-tree で listing (log より確実)
// 返り値 (plan P2 shape): { files: [...], truncated, error }
export async function listFilesAtCommit(vaultDir, sha, { subPath = 'wiki/' } = {}) {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
    throw new GitHistoryError('invalid sha format', 'invalid_args');
  }
  if (typeof subPath !== 'string') {
    throw new GitHistoryError('subPath must be string', 'invalid_args');
  }
  if (subPath.length > 0) {
    assertSafeRelPath(subPath, 'subPath'); // H2
  }
  // M6: -z で NUL separator、日本語 / quoted path 問題を完全回避
  const args = ['ls-tree', '-r', '--name-only', '-z', sha];
  if (subPath) args.push('--', subPath);
  const res = await runGit(vaultDir, args);
  if (res.code !== 0) {
    return {
      files: [],
      truncated: res.truncated,
      error: res.spawnError ? res.spawnError.message : (res.stderr || `git exit ${res.code}`),
    };
  }
  return {
    files: res.stdout.split('\0').filter((l) => l.length > 0),
    truncated: res.truncated,
    error: null,
  };
}

// 内部 parser: git log -z の stdout を commit 配列に
// actual git format (確認済, git 2.x): "KIOKU\x01<sha>\x01<short>\x01<ct>\x01<author>\x01<subject>\0\n<file>\0<file>\0KIOKU\x01..."
// -z 下では --format= の末尾に \0、続いて file list が \n<file>\0<file>\0 で続く。
// 次の record は KIOKU\x01 で始まる (\0\0 record separator は使われない実装がある)。
// subject / file 名に newline / \x01 が含まれても KIOKU sentinel と \0 で確実に区切られる (M7)。
export function parseGitLogOutput(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return [];
  const commits = [];
  // KIOKU sentinel で record 分割 (先頭の空 string は skip)
  const blocks = stdout.split('KIOKU\x01').slice(1);
  for (const block of blocks) {
    // block = "<sha>\x01<short>\x01<ct>\x01<author>\x01<subject>\0\n<file>\0<file>\0"
    // or "<sha>\x01...<subject>\0" (no file touched)
    const headerEnd = block.indexOf('\0');
    const header = headerEnd >= 0 ? block.substring(0, headerEnd) : block;
    // file section: 先頭の \n を skip (git が自動挿入する header/file 区切り)
    let fileSection = headerEnd >= 0 ? block.substring(headerEnd + 1) : '';
    if (fileSection.startsWith('\n')) fileSection = fileSection.substring(1);
    const parts = header.split('\x01');
    if (parts.length < 5) continue;
    const [sha, shortSha, ctStr, author, subject] = parts;
    const ts = Number(ctStr);
    if (!Number.isFinite(ts)) continue;
    const files = fileSection.split('\0').filter((l) => l.length > 0);
    commits.push({
      sha,
      shortSha,
      timestamp: ts * 1000, // ms since epoch
      author,
      subject,
      files,
    });
  }
  return commits;
}
