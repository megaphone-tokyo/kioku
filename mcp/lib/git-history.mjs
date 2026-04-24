// git-history.mjs — Git 履歴を Visualizer (Phase D α) から読むための read-only 抽象
//
// 使い方:
//   const commits = await getFileHistory(vaultDir, { since: '2026-01-01', subPath: 'wiki/' });
//   const content = await getFileContentAtCommit(vaultDir, sha, 'wiki/index.md');
//
// Security / Trust boundary:
//   - 全て **spawn('git', [...])** で argv 配列渡し (shell injection 回避、KIOKU 既存 pattern 踏襲)
//   - vaultDir は cwd としてのみ使用 (ディレクトリ存在確認は呼び出し側)
//   - 非 git repo / git 未インストール時は `null` または空配列を返す (fail-safe)
//   - 外部ネットワーク一切なし、git fetch/push は呼ばない (read-only: log, show, rev-parse)
//   - stdout は size cap でくくる (非常に大きな repo 対応、現状 16 MiB 上限)
//
// 正典: plan/claude/26042402_visualizer-concept-sketch.md §View 1 / §View 2

import { spawn } from 'node:child_process';

const MAX_STDOUT_BYTES = 16 * 1024 * 1024; // 16 MiB
const GIT_CMD = 'git';

export class GitHistoryError extends Error {
  constructor(message, code = 'git_error') {
    super(message);
    this.name = 'GitHistoryError';
    this.code = code;
  }
}

// 内部: git コマンドを spawn で実行し、stdout/stderr/code を返す
// args は必ず配列で渡す (shell injection 回避)
async function runGit(cwd, args) {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new GitHistoryError('git args must be array of strings', 'invalid_args');
  }
  return new Promise((resolve) => {
    const child = spawn(GIT_CMD, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let truncated = false;

    child.stdout.on('data', (chunk) => {
      if (stdoutBytes + chunk.length > MAX_STDOUT_BYTES) {
        truncated = true;
        const remaining = MAX_STDOUT_BYTES - stdoutBytes;
        if (remaining > 0) {
          stdoutChunks.push(chunk.subarray(0, remaining));
          stdoutBytes = MAX_STDOUT_BYTES;
        }
        child.kill('SIGTERM');
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('error', (err) => {
      // ENOENT (git not installed) etc. — resolve で error を返す (throw しない)
      resolve({ code: -1, stdout: '', stderr: err.message, truncated: false, error: err });
    });
    child.on('close', (code) => {
      resolve({
        code,
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
// 返り値: [{ sha, shortSha, timestamp (ms since epoch), author, subject, files: [paths...] }]
// git が無い or repo じゃない場合は空配列
export async function getFileHistory(vaultDir, options = {}) {
  if (!(await isGitRepo(vaultDir))) return [];
  const { since, subPath = '', maxCommits = 1000 } = options;
  if (typeof maxCommits !== 'number' || maxCommits < 1 || maxCommits > 100000) {
    throw new GitHistoryError('maxCommits out of range (1..100000)', 'invalid_args');
  }
  if (typeof subPath !== 'string') {
    throw new GitHistoryError('subPath must be string', 'invalid_args');
  }
  const args = [
    'log',
    '--name-only',
    '--no-decorate',
    '--no-merges',
    `--max-count=${maxCommits}`,
    // 区切り用の sentinel を使う (改行を含むファイル名にも耐える想定、
    // ただし git は newline 含むパスを別の escape で出すので完全ではない)
    '--format=COMMIT\x1f%H\x1f%h\x1f%ct\x1f%an\x1f%s',
  ];
  if (since) args.push(`--since=${since}`);
  args.push('--');
  if (subPath) args.push(subPath);

  const res = await runGit(vaultDir, args);
  if (res.code !== 0) return [];
  return parseGitLogOutput(res.stdout);
}

// 単一 commit の指定ファイル内容を取得、不在時は null
export async function getFileContentAtCommit(vaultDir, sha, relPath) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{4,40}$/.test(sha)) {
    throw new GitHistoryError('invalid sha format', 'invalid_args');
  }
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new GitHistoryError('relPath must be non-empty string', 'invalid_args');
  }
  if (relPath.includes('\0') || relPath.length > 4096) {
    throw new GitHistoryError('invalid relPath', 'invalid_args');
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
export async function listFilesAtCommit(vaultDir, sha, { subPath = 'wiki/' } = {}) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{4,40}$/.test(sha)) {
    throw new GitHistoryError('invalid sha format', 'invalid_args');
  }
  const args = ['ls-tree', '-r', '--name-only', sha];
  if (subPath) args.push('--', subPath);
  const res = await runGit(vaultDir, args);
  if (res.code !== 0) return [];
  return res.stdout.split('\n').filter((l) => l.length > 0);
}

// 内部 parser: git log の stdout を commit 配列に
// format: "COMMIT\x1f<sha>\x1f<short>\x1f<unixtime>\x1f<author>\x1f<subject>\n<file>\n<file>\n\nCOMMIT..."
export function parseGitLogOutput(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return [];
  const commits = [];
  const blocks = stdout.split('COMMIT\x1f').slice(1); // 先頭は空
  for (const block of blocks) {
    const lines = block.split('\n');
    const headerLine = lines[0];
    if (!headerLine) continue;
    const parts = headerLine.split('\x1f');
    if (parts.length < 5) continue;
    const [sha, shortSha, ctStr, author, subject] = parts;
    const ts = Number(ctStr);
    if (!Number.isFinite(ts)) continue;
    const files = lines.slice(1).filter((l) => l.length > 0);
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
