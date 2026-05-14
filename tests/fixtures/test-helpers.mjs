// test-helpers.mjs — shared test fixtures across KIOKU test suites.
//
// Sprint 4 Phase 2 PR B2 (LEARN#8b N=3 extract: withoutQmd lived in 3 test files).
// Sprint 4 Phase 3 PR C3 (LEARN#8b N=2 observation: mockMobileViewport shared
//   across mobile-viz-simplified.test.mjs + mobile-performance-budget.test.mjs).
// Sprint 4 Phase 4 PR B4 (LEARN#8b N=2 observation: mockGitPushFailure +
//   readRetryQueue planned for sync-diagnostic.test.sh PATH-stub coverage +
//   future hot-fix regression tests).

import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
