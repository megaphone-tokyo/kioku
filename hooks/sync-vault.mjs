#!/usr/bin/env node
// hooks/sync-vault.mjs — Vault Git sync with retry queue (Sprint 4 Phase 4 PR A4).
//
// Replaces the inline shell oneliners that previously lived in:
//   - scripts/install/user/install-hooks.sh         SessionStart (pull) / SessionEnd (push)
//   - scripts/install/user/install-hooks-gemini.sh  same pair
//   - scripts/install/user/install-hooks-codex.sh   same pair
//
// Two CLI modes invoked by hook commands:
//   --pull-and-retry  (SessionStart): git pull --rebase, then drain retry queue
//   --push            (SessionEnd):   git add/commit/push; on failure, enqueue
//
// Failure semantics (preserves prior `2>/dev/null || true` behavior):
//   - Never exits non-zero. Always exit code 0 so the hook chain never blocks
//     a Claude session. Status is communicated via stderr text only.
//   - User-facing messages go to stderr in Japanese (UX consistency with prior
//     silent flow). Token literals are scrubbed via maskText (LEARN#13 +
//     scan-secrets MASK_RULES single source of truth from scripts/lib/masking.mjs).
//
// Retry queue file: $OBSIDIAN_VAULT/.kioku-sync-retry.json
//   {
//     "errorType":    "network" | "non-fast-forward" | "auth" | "unknown",
//     "message":      "<masked stderr excerpt, <=512 chars>",
//     "firstAttempt": "<ISO8601>",
//     "lastAttempt":  "<ISO8601>",
//     "retryCount":   <int>
//   }
//
// Security contract (open-issues §40 / LEARN#13):
//   - Every stderr string is passed through maskText() before write or print.
//     maskText already covers ghp_*, github_pat_*, Bearer, embedded URL creds.
//   - Never reads process.env.GH_TOKEN/GITHUB_TOKEN; the queue records type +
//     masked message only.
//   - Writes are atomic (tmp file + rename) so a partial JSON can never be
//     observed by a concurrent reader (doctor.sh, SessionStart hook).
//   - Reads tolerate malformed JSON by treating queue as absent (defensive).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { maskText } from '../scripts/lib/masking.mjs';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const RETRY_QUEUE_FILENAME = '.kioku-sync-retry.json';
const MAX_STDERR_EXCERPT = 512;
const COMMIT_PATHS = ['wiki/', 'raw-sources/', 'templates/', 'CLAUDE.md'];

// -----------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// -----------------------------------------------------------------------------

/**
 * Classify a git push/pull stderr into one of four bucket strings.
 * Kept conservative: only patterns we're confident map to a single bucket.
 */
export function classifyGitError(stderr) {
  if (typeof stderr !== 'string' || stderr.length === 0) return 'unknown';
  if (
    /Could not resolve host/i.test(stderr) ||
    /network is unreachable/i.test(stderr) ||
    /connection refused/i.test(stderr) ||
    /operation timed out/i.test(stderr) ||
    /could not read from remote repository/i.test(stderr) ||
    /unable to access/i.test(stderr)
  ) {
    return 'network';
  }
  if (
    /\bnon-fast-forward\b/i.test(stderr) ||
    /\[rejected\]/i.test(stderr) ||
    /failed to push some refs/i.test(stderr) ||
    /tip of your current branch is behind/i.test(stderr)
  ) {
    return 'non-fast-forward';
  }
  if (
    /authentication failed/i.test(stderr) ||
    /permission denied \(publickey\)/i.test(stderr) ||
    /invalid username or password/i.test(stderr) ||
    /could not read username/i.test(stderr) ||
    /403 forbidden/i.test(stderr) ||
    /401 unauthorized/i.test(stderr)
  ) {
    return 'auth';
  }
  return 'unknown';
}

/**
 * Mask credential-like substrings before they leak into the retry queue file
 * or user-visible stderr. Thin wrapper for maskText — keeping the named export
 * so call sites read intentionally ("we are masking for credential safety").
 */
export function maskCredentials(text) {
  if (typeof text !== 'string') return '';
  return maskText(text);
}

/**
 * Atomically write the retry queue file. Writes to a tmp file in the parent
 * directory of the target, then renames into place — rename is atomic on the
 * same filesystem, so concurrent readers never see partial JSON.
 */
export async function writeRetryQueue(retryQueuePath, entry) {
  const parent = dirname(retryQueuePath);
  const tmpDir = await mkdtemp(join(parent, '.kioku-sync-retry-tmp-'));
  const tmpFile = join(tmpDir, 'queue.json');
  try {
    await writeFile(tmpFile, JSON.stringify(entry, null, 2) + '\n', 'utf8');
    await rename(tmpFile, retryQueuePath);
  } finally {
    try {
      await unlink(tmpFile);
    } catch {
      /* expected when rename succeeded */
    }
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* tolerate */
    }
  }
}

/**
 * Read and parse the retry queue. Returns null if file is missing or malformed
 * (defensive: a corrupt queue should not block SessionStart).
 */
export async function readRetryQueue(retryQueuePath) {
  if (!existsSync(retryQueuePath)) return null;
  try {
    const raw = await readFile(retryQueuePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Remove the retry queue file. Idempotent — missing file is not an error.
 */
export async function clearRetryQueue(retryQueuePath) {
  try {
    await unlink(retryQueuePath);
  } catch (e) {
    if (e && e.code === 'ENOENT') return;
    // best-effort; don't throw — the queue file is auxiliary state
  }
}

/**
 * Build a retry queue entry. Centralizes the masking + truncation contract so
 * callers cannot forget to mask. `previous` lets callers preserve firstAttempt
 * + retryCount when updating an existing entry.
 */
export function buildRetryQueueEntry({ errorType, stderr, previous, now }) {
  const clock = typeof now === 'function' ? now : () => new Date().toISOString();
  const ts = clock();
  const message = maskCredentials(stderr || '').slice(0, MAX_STDERR_EXCERPT);
  if (previous && typeof previous === 'object') {
    return {
      errorType,
      message,
      firstAttempt: previous.firstAttempt || ts,
      lastAttempt: ts,
      retryCount: Number.isFinite(previous.retryCount) ? previous.retryCount + 1 : 1,
    };
  }
  return {
    errorType,
    message,
    firstAttempt: ts,
    lastAttempt: ts,
    retryCount: 0,
  };
}

/**
 * Compute the retry queue path for a given vault. Centralized so tests + impl
 * agree on the filename.
 */
export function retryQueuePathFor(vaultPath) {
  return join(vaultPath, RETRY_QUEUE_FILENAME);
}

// -----------------------------------------------------------------------------
// Git invocation (kept narrow so spawn injection via opts.spawn enables mocking)
// -----------------------------------------------------------------------------

function runGit(vaultPath, args, opts) {
  const spawn = (opts && opts.spawn) || spawnSync;
  const result = spawn('git', args, {
    cwd: vaultPath,
    encoding: 'utf8',
  });
  return {
    status: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// -----------------------------------------------------------------------------
// Pre-flight (preserves prior shell oneliner gates)
// -----------------------------------------------------------------------------

export async function shouldRunPush({ vaultPath, env = process.env, spawn }) {
  if (env.KIOKU_NO_LOG === '1') return false;
  if (!existsSync(vaultPath)) return false;
  const gitignorePath = join(vaultPath, '.gitignore');
  if (!existsSync(gitignorePath)) return false;
  let gitignore;
  try {
    gitignore = await readFile(gitignorePath, 'utf8');
  } catch {
    return false;
  }
  if (!/^session-logs\//m.test(gitignore)) return false;
  const head = runGit(vaultPath, ['symbolic-ref', '-q', 'HEAD'], { spawn });
  if (head.status !== 0) return false;
  return true;
}

// -----------------------------------------------------------------------------
// SessionEnd flow: add + commit + push, queue on failure
// -----------------------------------------------------------------------------

export async function syncToRemote({
  vaultPath,
  env = process.env,
  spawn,
  stderr = (msg) => process.stderr.write(msg + '\n'),
  now,
}) {
  if (!(await shouldRunPush({ vaultPath, env, spawn }))) {
    return { status: 'skipped' };
  }

  runGit(vaultPath, ['add', ...COMMIT_PATHS], { spawn });

  const cached = runGit(vaultPath, ['diff', '--cached', '--quiet'], { spawn });
  if (cached.status === 0) {
    return { status: 'no-changes' };
  }

  const commitMsg = `auto: wiki update ${formatNowForCommit(now)}`;
  const commit = runGit(vaultPath, ['commit', '-m', commitMsg, '--quiet'], { spawn });
  if (commit.status !== 0) {
    return { status: 'commit-failed', stderr: maskCredentials(commit.stderr) };
  }

  const push = runGit(vaultPath, ['push', '--quiet'], { spawn });
  if (push.status === 0) {
    await clearRetryQueue(retryQueuePathFor(vaultPath));
    return { status: 'pushed' };
  }

  const errorType = classifyGitError(push.stderr);
  const queuePath = retryQueuePathFor(vaultPath);
  const previous = await readRetryQueue(queuePath);
  const entry = buildRetryQueueEntry({
    errorType,
    stderr: push.stderr,
    previous,
    now,
  });
  await writeRetryQueue(queuePath, entry);
  stderr(`クラウド同期できませんでした。次回 Claude 起動時に再同期されます (詳細: ${errorType})`);
  return { status: 'queued', errorType, retryCount: entry.retryCount };
}

// -----------------------------------------------------------------------------
// SessionStart flow: pull, then drain retry queue if present
// -----------------------------------------------------------------------------

export async function checkAndRetrySync({
  vaultPath,
  env = process.env,
  spawn,
  stderr = (msg) => process.stderr.write(msg + '\n'),
  stdout = (msg) => process.stdout.write(msg + '\n'),
  now,
}) {
  if (env.KIOKU_NO_LOG === '1') return { status: 'skipped' };
  if (!existsSync(vaultPath)) return { status: 'skipped' };

  runGit(vaultPath, ['pull', '--rebase', '--quiet'], { spawn });

  const queuePath = retryQueuePathFor(vaultPath);
  const previous = await readRetryQueue(queuePath);
  if (!previous) return { status: 'no-retry-needed' };

  const head = runGit(vaultPath, ['symbolic-ref', '-q', 'HEAD'], { spawn });
  if (head.status !== 0) {
    stderr(`クラウド同期の retry queue が残っていますが、現在のブランチ状態で再試行できません (累計 ${previous.retryCount} 回)`);
    return { status: 'retry-blocked', retryCount: previous.retryCount };
  }

  const retryPush = runGit(vaultPath, ['push', '--quiet'], { spawn });
  if (retryPush.status === 0) {
    await clearRetryQueue(queuePath);
    stdout(`クラウド同期が再開しました (前回失敗から ${previous.retryCount + 1} 回目で成功)`);
    return { status: 'retry-success', retryCount: previous.retryCount + 1 };
  }

  const errorType = classifyGitError(retryPush.stderr);
  const entry = buildRetryQueueEntry({
    errorType,
    stderr: retryPush.stderr,
    previous,
    now,
  });
  await writeRetryQueue(queuePath, entry);
  stderr(`クラウド同期に再失敗 (累計 ${entry.retryCount} 回、最新 error: ${errorType})`);
  return { status: 'retry-failed', errorType, retryCount: entry.retryCount };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function formatNowForCommit(now) {
  const iso = (typeof now === 'function' ? now() : new Date().toISOString());
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[1]}${m[2]}${m[3]}-${m[4]}${m[5]}`;
}

// -----------------------------------------------------------------------------
// CLI entry (LEARN#14 isEntry pattern — never fires during test import)
// -----------------------------------------------------------------------------

function isEntry() {
  return Boolean(
    process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

async function main() {
  const mode = process.argv[2];
  const vaultPath = process.env.OBSIDIAN_VAULT;
  if (!vaultPath) {
    return;
  }
  try {
    if (mode === '--pull-and-retry') {
      await checkAndRetrySync({ vaultPath });
    } else if (mode === '--push') {
      await syncToRemote({ vaultPath });
    }
  } catch (e) {
    try {
      process.stderr.write(
        `sync-vault: unexpected error (${maskCredentials(String((e && e.message) || e))})\n`
      );
    } catch {
      /* suppress secondary failures */
    }
  }
}

if (isEntry()) {
  main();
}
