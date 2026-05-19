// test-helpers.mjs — shared test fixtures across KIOKU test suites.
//
// Sprint 4 Phase 2 PR B2 (LEARN#8b N=3 extract: withoutQmd lived in 3 test files).
// Sprint 4 Phase 3 PR C3 (LEARN#8b N=2 observation: mockMobileViewport shared
//   across mobile-viz-simplified.test.mjs + mobile-performance-budget.test.mjs).
// Sprint 4 Phase 4 PR B4 (LEARN#8b N=2 observation: mockGitPushFailure +
//   readRetryQueue planned for sync-diagnostic.test.sh PATH-stub coverage +
//   future hot-fix regression tests).
// Sprint 5 PR B5 (LEARN#8b N=3 mandatory extract: classifyError + maskCredentials
//   + retry queue I/O duplication 達 N=3 [hooks/sync-vault.mjs +
//   hooks/auto-ingest-retry.mjs + planned 3rd retry-style helper] →
//   mockAutoIngestFailure + readAutoIngestRetryQueue を本ファイルに集約。
//   PATH-stub mechanism は mockGitPushFailure と同じ pattern を踏襲、retry queue
//   read は readRetryQueue (sync 側) と pair で「retry queue 全種類を 1 file で
//   inspect できる」test ergonomics を実現)。
// Sprint 5.5 PR B55 (LEARN#8b N=4 reinforcement: queue/log read wrapper 系が
//   readRetryQueue + readAutoIngestRetryQueue + readAutoIngestManualReviewQueue
//   で既に N=3 集約済。本 PR は 4 つ目 caller (discoverQueries dynamic learning
//   usage log) として mockSessionLogScan + readUsageLog を追加。readUsageLog は
//   readAutoIngestRetryQueue と同 contract = missing は null (production
//   discoverqueries-learning.mjs の readUsageLog は canonical empty shape を
//   返す別 contract、test-helper 側は `=== null` 判定 ergonomics を優先)。
//   mockSessionLogScan は scanSessionLogs が拾える minimal session-log fixture
//   を programmatic 生成する。)

import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Run `fn` with PATH neutralized so that the `qmd` binary is unreachable.
 * Forces handleSearch (and any downstream that probes for qmd) to fall back
 * to the in-process Node grep walker. Restores PATH in `finally` even on
 * `fn` throw. Returns whatever `fn` returns.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withoutQmd(fn) {
  const prev = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  try {
    return await fn();
  } finally {
    process.env.PATH = prev;
  }
}

/**
 * Install a Mobile viewport shim on globalThis (window + matchMedia) for tests
 * that exercise viz-template.html JS in a Node 18+ stdlib-only environment.
 * Returns a restore function — call it in `finally` to undo the shim.
 *
 * Note: this is a *minimal* shim, not a full DOM. It only provides
 *   - global.window.innerWidth
 *   - global.window.matchMedia(query) → { matches, addEventListener, removeEventListener }
 * Tests that need DOM rendering should also load jsdom separately; but
 * mockMobileViewport itself stays jsdom-free so quick `matchMedia` branch
 * checks work without external deps.
 *
 * @param {number} width — viewport width in CSS px (default 375 = iPhone SE)
 * @returns {() => void} restore function (idempotent)
 */
export function mockMobileViewport(width = 375) {
  const prevWindow = globalThis.window;
  const prevHasWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const shim = {
    innerWidth: width,
    matchMedia(query) {
      const m = /\(\s*max-width:\s*(\d+)px\s*\)/i.exec(query || '');
      const matches = m ? width <= Number(m[1]) : false;
      return {
        matches,
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        onchange: null,
        dispatchEvent() { return false; },
      };
    },
  };
  globalThis.window = shim;
  let restored = false;
  return function restore() {
    if (restored) return;
    restored = true;
    if (prevHasWindow) {
      globalThis.window = prevWindow;
    } else {
      delete globalThis.window;
    }
  };
}

/**
 * PATH-stub that makes `git push` fail with a canned stderr matching one of
 * the `classifyGitError` buckets. Other git subcommands (add/commit/diff/
 * symbolic-ref/log/rev-parse/pull) are delegated to the real `git` so the
 * test exercises the real `shouldRunPush` pre-flight + add/commit chain and
 * only the terminal `push` fails.
 *
 * Usage:
 *   const restore = await mockGitPushFailure('network');
 *   try { await run(); } finally { await restore(); }
 *
 * @param {'network' | 'non-fast-forward' | 'auth'} errorType
 * @returns {Promise<() => Promise<void>>} restore function (idempotent)
 */
export async function mockGitPushFailure(errorType) {
  const errorMessages = {
    'network': 'fatal: unable to access: Could not resolve host: github.com',
    'non-fast-forward':
      ' ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs',
    'auth': 'fatal: Authentication failed for https://github.com/org/repo.git',
  };
  if (!Object.prototype.hasOwnProperty.call(errorMessages, errorType)) {
    throw new Error(`mockGitPushFailure: unsupported errorType "${errorType}"`);
  }

  // Locate the real git binary BEFORE we shadow PATH so the stub can delegate
  // every non-push subcommand. command -v inside the stub would otherwise loop
  // back into the stub itself.
  const realGit = await locateRealGit(process.env.PATH || '');
  if (!realGit) {
    throw new Error('mockGitPushFailure: real git not found on PATH');
  }

  const stubDir = await mkdtemp(join(tmpdir(), 'kioku-git-mock-'));
  const stubGit = join(stubDir, 'git');
  const stubScript = [
    '#!/usr/bin/env bash',
    `REAL_GIT=${shellQuote(realGit)}`,
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    push)',
    `      echo ${shellQuote(errorMessages[errorType])} >&2`,
    '      exit 1',
    '      ;;',
    '  esac',
    'done',
    'exec "$REAL_GIT" "$@"',
    '',
  ].join('\n');
  await writeFile(stubGit, stubScript, 'utf8');
  await chmod(stubGit, 0o755);

  const prevPath = process.env.PATH;
  process.env.PATH = `${stubDir}:${prevPath || ''}`;

  let restored = false;
  return async function restore() {
    if (restored) return;
    restored = true;
    process.env.PATH = prevPath;
    await rm(stubDir, { recursive: true, force: true });
  };
}

/**
 * Read and parse `.kioku-sync-retry.json` from a Vault path. Returns `null` if
 * the file is missing or malformed (mirroring the contract of
 * `readRetryQueue` in `hooks/sync-vault.mjs`). Thin wrapper so test code does
 * not need to import the production helper just to peek at the queue file.
 *
 * @param {string} vaultPath — absolute path to the Vault directory
 * @returns {Promise<object | null>}
 */
export async function readRetryQueue(vaultPath) {
  const queuePath = join(vaultPath, '.kioku-sync-retry.json');
  if (!existsSync(queuePath)) return null;
  try {
    const raw = await readFile(queuePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * PATH-stub that makes one of the auto-ingest extract scripts fail with a
 * canned stderr matching one of the `classifyAutoIngestError` buckets. Used by
 * `tests/auto-ingest-diagnostic.test.sh` to exercise `doctor.sh
 * check_auto_ingest_state` paths without relying on real PDF / EPUB / DOCX
 * binaries or a live `claude` CLI.
 *
 * The stub script writes the canned stderr message to its stderr stream and
 * exits with the supplied rc. By default rc=99 (matches auto-ingest.sh's
 * `*` → enqueue branch). Caller passes the absolute path back into
 * auto-ingest.sh via `KIOKU_EXTRACT_PDF_SCRIPT` (or the matching env var for
 * EPUB / DOCX / URL) plus `KIOKU_ALLOW_EXTRACT_*_OVERRIDE=1` to bypass the
 * VULN-004 env-injection guard.
 *
 * Returns an object with the stub script `path` (caller passes to the
 * relevant `KIOKU_EXTRACT_*_SCRIPT`) and a `restore` function that removes
 * the stub directory.
 *
 * Usage:
 *   const { path, restore } = await mockAutoIngestFailure('llm_failed');
 *   try { ... } finally { await restore(); }
 *
 * @param {'extract_failed' | 'llm_failed' | 'fs_error' | 'sha256_drift' | 'unknown'} errorType
 * @param {{ rc?: number }} [opts]
 * @returns {Promise<{ path: string, restore: () => Promise<void> }>}
 */
export async function mockAutoIngestFailure(errorType, opts = {}) {
  const errorMessages = {
    'extract_failed': 'extract-pdf.sh: failed (rc=1) — stub injected by mockAutoIngestFailure',
    'llm_failed': 'claude -p timed out (test mock from mockAutoIngestFailure)',
    'fs_error': 'ENOENT: no such file or directory, open ... (test mock)',
    'sha256_drift': 'source_sha256 mismatch detected for chunk (test mock)',
    'unknown': 'something unexpected happened (test mock)',
  };
  if (!Object.prototype.hasOwnProperty.call(errorMessages, errorType)) {
    throw new Error(`mockAutoIngestFailure: unsupported errorType "${errorType}"`);
  }
  const rc = Number.isFinite(opts.rc) ? opts.rc : 99;

  const stubDir = await mkdtemp(join(tmpdir(), 'kioku-auto-ingest-mock-'));
  const stubPath = join(stubDir, 'extract-stub.sh');
  const stubScript = [
    '#!/usr/bin/env bash',
    `echo ${shellQuote(errorMessages[errorType])} >&2`,
    `exit ${rc}`,
    '',
  ].join('\n');
  await writeFile(stubPath, stubScript, 'utf8');
  await chmod(stubPath, 0o755);

  let restored = false;
  return {
    path: stubPath,
    async restore() {
      if (restored) return;
      restored = true;
      await rm(stubDir, { recursive: true, force: true });
    },
  };
}

/**
 * Read and parse `.kioku-auto-ingest-retry.json` from a Vault path. Returns
 * `null` if the file is missing (unlike `readAutoIngestRetryQueue` in
 * `hooks/auto-ingest-retry.mjs` which returns the canonical empty shape) — the
 * test ergonomic here favors `=== null` checks for "queue absent" assertions.
 * Returns `{ entries: [...] }` on success.
 *
 * Companion to `readRetryQueue` (sync side) and `readManualReviewQueue` so
 * test code can inspect both kioku queue files via this single fixtures module.
 *
 * @param {string} vaultPath — absolute path to the Vault directory
 * @returns {Promise<object | null>}
 */
export async function readAutoIngestRetryQueue(vaultPath) {
  const queuePath = join(vaultPath, '.kioku-auto-ingest-retry.json');
  if (!existsSync(queuePath)) return null;
  try {
    const raw = await readFile(queuePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Read and parse `.kioku-auto-ingest-manual-review.json` from a Vault path.
 * Same contract as `readAutoIngestRetryQueue` — returns `null` if file missing.
 *
 * @param {string} vaultPath — absolute path to the Vault directory
 * @returns {Promise<object | null>}
 */
export async function readAutoIngestManualReviewQueue(vaultPath) {
  const queuePath = join(vaultPath, '.kioku-auto-ingest-manual-review.json');
  if (!existsSync(queuePath)) return null;
  try {
    const raw = await readFile(queuePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Generate a minimal session-log file under `${vaultPath}/session-logs/` that
 * `scanSessionLogs` (mcp/lib/discoverqueries-learning.mjs) can pick up. The
 * file body repeats `query` `count` times in a `## User (HH:MM:SS)` block so
 * the query signal extraction (#tag / [[wikilink]] / ATX heading) registers
 * `count` occurrences. `query` is emitted as a bare `#query` tag ref so it
 * survives the pre-strip → mask → PII sanitize pipeline.
 *
 * Used by `tests/discoverqueries-diagnostic.test.sh` to seed a usage-log
 * baseline (after the production `appendToUsageLog` consumes the scan result)
 * without depending on real Claude sessions.
 *
 * @param {string} vaultPath — absolute path to the temp Vault directory
 * @param {string} query — query token (tag-friendly: lowercase + hyphen)
 * @param {number} [count=1] — occurrence count to write
 * @returns {Promise<string>} absolute path to the generated session-log file
 */
export async function mockSessionLogScan(vaultPath, query, count = 1) {
  if (typeof vaultPath !== 'string' || vaultPath.length === 0) {
    throw new Error('mockSessionLogScan: vaultPath required');
  }
  if (typeof query !== 'string' || query.length === 0) {
    throw new Error('mockSessionLogScan: query required');
  }
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
  const sessionLogsDir = join(vaultPath, 'session-logs');
  await mkdir(sessionLogsDir, { recursive: true });
  const lines = ['## User (12:00:00)', ''];
  for (let i = 0; i < n; i += 1) {
    lines.push(`#${query} mention ${i + 1}`);
  }
  lines.push('');
  const stamp = `20260515-120000-mock-${query}`.replace(/[^a-zA-Z0-9-]/g, '-');
  const filePath = join(sessionLogsDir, `${stamp}.md`);
  await writeFile(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

/**
 * Read and parse `.kioku-discoverqueries-usage.json` from a Vault path.
 * Returns `null` if the file is missing (mirrors the test-friendly contract of
 * `readAutoIngestRetryQueue` — note this differs from the production
 * `readUsageLog` in `mcp/lib/discoverqueries-learning.mjs` which returns the
 * canonical empty `{ version, entries: [] }` shape; here the `=== null` check
 * is the ergonomic for "usage log absent" assertions). Returns the parsed
 * object on success, `null` on malformed JSON.
 *
 * Companion to `readRetryQueue` / `readAutoIngestRetryQueue` /
 * `readAutoIngestManualReviewQueue` so test code can inspect every kioku
 * state file via this single fixtures module (LEARN#8b N=4 reinforcement).
 *
 * @param {string} vaultPath — absolute path to the Vault directory
 * @returns {Promise<object | null>}
 */
export async function readUsageLog(vaultPath) {
  const logPath = join(vaultPath, '.kioku-discoverqueries-usage.json');
  if (!existsSync(logPath)) return null;
  try {
    const raw = await readFile(logPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Quote a string for safe embedding in a single-quoted bash literal.
 * Closes the quote, escapes a single quote, then reopens.
 */
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * Walk PATH entries to find the first real `git` binary, ignoring directories
 * we may have just injected (the stub dir starts with `kioku-git-mock-`).
 */
async function locateRealGit(pathEnv) {
  const { stat: fsStat } = await import('node:fs/promises');
  const entries = pathEnv.split(':').filter(Boolean);
  for (const entry of entries) {
    if (entry.includes('kioku-git-mock-')) continue;
    const candidate = join(entry, 'git');
    try {
      const s = await fsStat(candidate);
      if (s.isFile()) return candidate;
    } catch {
      // candidate absent — keep looking
    }
  }
  return null;
}
