// tests/sync-retry.test.mjs — Sprint 4 Phase 4 PR A4 (BLUE-SYNC-A4-1..5)
//
// Target: hooks/sync-vault.mjs
//
// Test prefixes:
//   - BLUE-SYNC-A4-1   classifyGitError buckets (network / non-fast-forward / auth / unknown)
//   - BLUE-SYNC-A4-2   maskCredentials scrubs ghp_*, github_pat_*, Bearer, embedded URL creds
//   - BLUE-SYNC-A4-3   retry queue write/read round-trip + atomic rename + malformed-tolerant
//   - BLUE-SYNC-A4-4   syncToRemote on push failure enqueues masked entry (firstAttempt set)
//   - BLUE-SYNC-A4-5   checkAndRetrySync drains queue on success / increments on re-failure
//
// Design notes:
//   - We inject a `spawn` mock into the public helpers (no PATH stub needed).
//     PR B4 introduces a PATH-based mockGitPushFailure for end-to-end coverage;
//     for PR A4 the in-process injection is sufficient and faster.
//   - Every test uses mkdtemp + rm to keep the real Vault untouched.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildRetryQueueEntry,
  checkAndRetrySync,
  classifyGitError,
  clearRetryQueue,
  maskCredentials,
  readRetryQueue,
  retryQueuePathFor,
  syncToRemote,
  writeRetryQueue,
} from '../hooks/sync-vault.mjs';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function makeVault() {
  const dir = await mkdtemp(join(tmpdir(), 'kioku-sync-vault-'));
  // mimic the pre-flight gates so shouldRunPush returns true
  await writeFile(join(dir, '.gitignore'), 'session-logs/\n.obsidian/\n', 'utf8');
  return dir;
}

/**
 * Build a stub spawn function that mimics spawnSync's return shape. Routes
 * `git <args>` to a per-test scripted table. Unknown commands return status=0
 * with empty stdout/stderr so add/diff probes are inert by default.
 */
function makeGitStub(table) {
  return (cmd, args) => {
    if (cmd !== 'git') return { status: 0, stdout: '', stderr: '' };
    const key = args.join(' ');
    if (table[key] !== undefined) return table[key];
    // wildcard prefix support for `add <paths...>`, `commit -m <msg> --quiet`
    for (const prefix of Object.keys(table)) {
      if (prefix.endsWith(' *') && key.startsWith(prefix.slice(0, -2))) {
        return table[prefix];
      }
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

// -----------------------------------------------------------------------------
// BLUE-SYNC-A4-1: classifyGitError buckets
// -----------------------------------------------------------------------------

describe('BLUE-SYNC-A4-1 classifyGitError', () => {
  test('network: DNS failure', () => {
    assert.equal(
      classifyGitError('fatal: unable to access: Could not resolve host: github.com'),
      'network'
    );
  });

  test('network: connection refused', () => {
    assert.equal(classifyGitError('ssh: connect to host github.com port 22: Connection refused'), 'network');
  });

  test('network: operation timed out', () => {
    assert.equal(classifyGitError('fatal: unable to access: Operation timed out'), 'network');
  });

  test('non-fast-forward: rejected push', () => {
    assert.equal(
      classifyGitError(' ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs'),
      'non-fast-forward'
    );
  });

  test('non-fast-forward: tip behind remote', () => {
    assert.equal(
      classifyGitError("hint: Updates were rejected because the tip of your current branch is behind"),
      'non-fast-forward'
    );
  });

  test('auth: ssh public key denied', () => {
    assert.equal(classifyGitError('git@github.com: Permission denied (publickey).'), 'auth');
  });

  test('auth: HTTPS 403', () => {
    assert.equal(classifyGitError('remote: 403 Forbidden\nfatal: unable to access'), 'network');
    // ^ note: also matches "unable to access" → network bucket wins by ordering.
    // Pure 403 without unable-to-access should still hit auth:
    assert.equal(classifyGitError('remote: 403 Forbidden'), 'auth');
  });

  test('unknown: empty + unrecognized', () => {
    assert.equal(classifyGitError(''), 'unknown');
    assert.equal(classifyGitError(null), 'unknown');
    assert.equal(classifyGitError('some unrelated git diagnostic'), 'unknown');
  });
});

// -----------------------------------------------------------------------------
// BLUE-SYNC-A4-2: maskCredentials (delegates to maskText)
// -----------------------------------------------------------------------------

describe('BLUE-SYNC-A4-2 maskCredentials', () => {
  test('masks ghp_ classic token', () => {
    const input = 'fatal: Authentication failed for https://ghp_ABCDEFGHIJ1234567890abcdefg@github.com/org/repo.git';
    const masked = maskCredentials(input);
    assert.equal(masked.includes('ghp_ABCDEFGHIJ1234567890'), false, 'ghp_ literal must not leak');
    assert.equal(masked.includes('ghp_***'), true);
  });

  test('masks github_pat_ fine-grained token', () => {
    const input = 'remote: github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz fail';
    const masked = maskCredentials(input);
    assert.equal(/github_pat_11ABCDEFG0abcdefghijklm/.test(masked), false);
    assert.equal(masked.includes('github_pat_***'), true);
  });

  test('masks Bearer header', () => {
    const input = 'Authorization: Bearer abc.DEF.GHIjklmnop123';
    const masked = maskCredentials(input);
    assert.equal(masked.includes('abc.DEF.GHIjklmnop123'), false);
    assert.equal(masked.includes('Bearer ***'), true);
  });

  test('masks embedded URL credentials', () => {
    const input = 'fatal: unable to access https://user123:pass456@github.com/repo.git';
    const masked = maskCredentials(input);
    assert.equal(masked.includes('user123:pass456'), false);
    assert.equal(masked.includes('://***:***@'), true);
  });

  test('non-string input returns empty string', () => {
    assert.equal(maskCredentials(null), '');
    assert.equal(maskCredentials(undefined), '');
    assert.equal(maskCredentials(42), '');
  });

  test('plain text without secrets passes through', () => {
    const input = 'network is unreachable';
    assert.equal(maskCredentials(input), input);
  });
});

// -----------------------------------------------------------------------------
// BLUE-SYNC-A4-3: retry queue write/read round-trip + atomic + malformed
// -----------------------------------------------------------------------------

describe('BLUE-SYNC-A4-3 retry queue I/O', () => {
  test('write then read returns the same entry', async () => {
    const vault = await makeVault();
    try {
      const qPath = retryQueuePathFor(vault);
      const entry = buildRetryQueueEntry({
        errorType: 'network',
        stderr: 'Could not resolve host: github.com',
        now: () => '2026-05-15T10:00:00.000Z',
      });
      await writeRetryQueue(qPath, entry);
      assert.equal(existsSync(qPath), true);
      const round = await readRetryQueue(qPath);
      assert.deepEqual(round, entry);
      assert.equal(entry.retryCount, 0);
      assert.equal(entry.firstAttempt, '2026-05-15T10:00:00.000Z');
      assert.equal(entry.lastAttempt, '2026-05-15T10:00:00.000Z');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('subsequent buildRetryQueueEntry preserves firstAttempt and increments retryCount', () => {
    const previous = buildRetryQueueEntry({
      errorType: 'network',
      stderr: 'first failure',
      now: () => '2026-05-15T10:00:00.000Z',
    });
    const next = buildRetryQueueEntry({
      errorType: 'network',
      stderr: 'second failure',
      previous,
      now: () => '2026-05-15T11:00:00.000Z',
    });
    assert.equal(next.firstAttempt, '2026-05-15T10:00:00.000Z', 'firstAttempt preserved across retries');
    assert.equal(next.lastAttempt, '2026-05-15T11:00:00.000Z');
    assert.equal(next.retryCount, 1, 'retryCount increments by 1');
  });

  test('readRetryQueue returns null for missing file', async () => {
    const vault = await makeVault();
    try {
      const round = await readRetryQueue(retryQueuePathFor(vault));
      assert.equal(round, null);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('readRetryQueue tolerates malformed JSON (returns null)', async () => {
    const vault = await makeVault();
    try {
      const qPath = retryQueuePathFor(vault);
      await writeFile(qPath, '{ not valid json', 'utf8');
      const round = await readRetryQueue(qPath);
      assert.equal(round, null, 'malformed JSON must not throw');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('clearRetryQueue idempotent (missing file is not an error)', async () => {
    const vault = await makeVault();
    try {
      const qPath = retryQueuePathFor(vault);
      await clearRetryQueue(qPath); // should not throw
      await writeRetryQueue(qPath, { errorType: 'network', message: '', firstAttempt: 't', lastAttempt: 't', retryCount: 0 });
      assert.equal(existsSync(qPath), true);
      await clearRetryQueue(qPath);
      assert.equal(existsSync(qPath), false);
      await clearRetryQueue(qPath); // second time still no throw
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('serialized queue file content never includes raw token literal', async () => {
    const vault = await makeVault();
    try {
      const qPath = retryQueuePathFor(vault);
      const entry = buildRetryQueueEntry({
        errorType: 'auth',
        stderr: 'fatal: Authentication failed for https://ghp_VeryRealLookingTokenLiteral1234567890@github.com/org/repo.git',
        now: () => '2026-05-15T10:00:00.000Z',
      });
      await writeRetryQueue(qPath, entry);
      const raw = await readFile(qPath, 'utf8');
      assert.equal(
        raw.includes('ghp_VeryRealLookingTokenLiteral1234567890'),
        false,
        'token literal must never appear in serialized queue file'
      );
      assert.equal(raw.includes('ghp_***'), true, 'masked replacement must be present');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// BLUE-SYNC-A4-4: syncToRemote on push failure → enqueue masked entry
// -----------------------------------------------------------------------------

describe('BLUE-SYNC-A4-4 syncToRemote push failure flow', () => {
  test('push failure writes retry queue with classified error + masked stderr', async () => {
    const vault = await makeVault();
    try {
      const stderrLines = [];
      const spawn = makeGitStub({
        'symbolic-ref -q HEAD': { status: 0, stdout: 'refs/heads/main\n', stderr: '' },
        'add wiki/ raw-sources/ templates/ CLAUDE.md': { status: 0, stdout: '', stderr: '' },
        'diff --cached --quiet': { status: 1, stdout: '', stderr: '' }, // 1 = there are staged changes
        'commit *': { status: 0, stdout: '', stderr: '' },
        'push --quiet': {
          status: 1,
          stdout: '',
          stderr: 'fatal: unable to access https://ghp_LeakedTokenLiteral12345678901234@github.com/org/repo.git: Could not resolve host: github.com',
        },
      });
      const result = await syncToRemote({
        vaultPath: vault,
        env: { KIOKU_NO_LOG: '0' },
        spawn,
        stderr: (msg) => stderrLines.push(msg),
        now: () => '2026-05-15T10:00:00.000Z',
      });
      assert.equal(result.status, 'queued');
      assert.equal(result.errorType, 'network');
      assert.equal(result.retryCount, 0, 'first failure starts at retryCount=0');

      const qPath = retryQueuePathFor(vault);
      assert.equal(existsSync(qPath), true);
      const raw = await readFile(qPath, 'utf8');
      assert.equal(raw.includes('ghp_LeakedTokenLiteral12345678901234'), false, 'no token literal in queue file');
      assert.equal(raw.includes('ghp_***'), true);

      assert.equal(stderrLines.length, 1, 'user notice emitted once');
      assert.equal(
        /クラウド同期できませんでした.*network/.test(stderrLines[0]),
        true,
        'Japanese user notice mentions classified error type'
      );
      assert.equal(stderrLines[0].includes('ghp_'), false, 'user notice never includes token-like literal');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('successful push clears stale retry queue', async () => {
    const vault = await makeVault();
    try {
      const qPath = retryQueuePathFor(vault);
      await writeRetryQueue(qPath, {
        errorType: 'network',
        message: 'old failure',
        firstAttempt: '2026-05-14T10:00:00.000Z',
        lastAttempt: '2026-05-14T11:00:00.000Z',
        retryCount: 3,
      });
      const spawn = makeGitStub({
        'symbolic-ref -q HEAD': { status: 0, stdout: 'refs/heads/main\n', stderr: '' },
        'add wiki/ raw-sources/ templates/ CLAUDE.md': { status: 0, stdout: '', stderr: '' },
        'diff --cached --quiet': { status: 1, stdout: '', stderr: '' },
        'commit *': { status: 0, stdout: '', stderr: '' },
        'push --quiet': { status: 0, stdout: '', stderr: '' },
      });
      const result = await syncToRemote({
        vaultPath: vault,
        env: { KIOKU_NO_LOG: '0' },
        spawn,
        stderr: () => {},
      });
      assert.equal(result.status, 'pushed');
      assert.equal(existsSync(qPath), false, 'stale retry queue cleared on success');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('KIOKU_NO_LOG=1 short-circuits before any git invocation', async () => {
    const vault = await makeVault();
    try {
      let calls = 0;
      const spawn = (cmd, args) => {
        calls += 1;
        return { status: 0, stdout: '', stderr: '' };
      };
      const result = await syncToRemote({
        vaultPath: vault,
        env: { KIOKU_NO_LOG: '1' },
        spawn,
        stderr: () => {},
      });
      assert.equal(result.status, 'skipped');
      assert.equal(calls, 0, 'no git calls when KIOKU_NO_LOG=1');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('detached HEAD blocks push (v0.4.0 Tier A#2 regression, migrated from install-hooks.test.sh)', async () => {
    const vault = await makeVault();
    try {
      let pushCalls = 0;
      const spawn = (cmd, args) => {
        if (args[0] === 'symbolic-ref') {
          return { status: 1, stdout: '', stderr: 'fatal: ref HEAD is not a symbolic ref\n' };
        }
        if (args[0] === 'push') pushCalls += 1;
        return { status: 0, stdout: '', stderr: '' };
      };
      const result = await syncToRemote({
        vaultPath: vault,
        env: { KIOKU_NO_LOG: '0' },
        spawn,
        stderr: () => {},
      });
      assert.equal(result.status, 'skipped', 'detached HEAD must short-circuit before push');
      assert.equal(pushCalls, 0, 'git push must not be invoked on detached HEAD');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('missing session-logs/ in .gitignore blocks push (mis-installed vault guard)', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'kioku-sync-vault-bad-'));
    try {
      // .gitignore deliberately lacks session-logs/ entry
      await writeFile(join(vault, '.gitignore'), '.obsidian/\n', 'utf8');
      let calls = 0;
      const spawn = (cmd, args) => {
        calls += 1;
        if (args[0] === 'symbolic-ref') return { status: 0, stdout: 'refs/heads/main\n', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      };
      const result = await syncToRemote({
        vaultPath: vault,
        env: { KIOKU_NO_LOG: '0' },
        spawn,
        stderr: () => {},
      });
      assert.equal(result.status, 'skipped');
      // shouldRunPush bails before symbolic-ref check, so no calls at all
      assert.equal(calls, 0, 'no git calls when .gitignore lacks session-logs/');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// BLUE-SYNC-A4-5: checkAndRetrySync drains queue / increments on re-failure
// -----------------------------------------------------------------------------

describe('BLUE-SYNC-A4-5 checkAndRetrySync flow', () => {
  test('no queue → pulls and returns no-retry-needed', async () => {
    const vault = await makeVault();
    try {
      const pullCalls = [];
      const spawn = makeGitStub({
        'pull --rebase --quiet': { status: 0, stdout: '', stderr: '' },
      });
      // wrap spawn to record pull invocation
      const trackedSpawn = (cmd, args, opts) => {
        if (cmd === 'git' && args[0] === 'pull') pullCalls.push(args.join(' '));
        return spawn(cmd, args, opts);
      };
      const result = await checkAndRetrySync({
        vaultPath: vault,
        env: { KIOKU_NO_LOG: '0' },
        spawn: trackedSpawn,
        stderr: () => {},
        stdout: () => {},
      });
      assert.equal(result.status, 'no-retry-needed');
      assert.equal(pullCalls.length, 1, 'pull --rebase --quiet invoked once');
      assert.equal(pullCalls[0], 'pull --rebase --quiet');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('queue present + push succeeds → clears queue + emits success notice', async () => {
    const vault = await makeVault();
    try {
      const qPath = retryQueuePathFor(vault);
      await writeRetryQueue(qPath, {
        errorType: 'network',
        message: 'prior failure',
        firstAttempt: '2026-05-14T10:00:00.000Z',
        lastAttempt: '2026-05-14T11:00:00.000Z',
        retryCount: 2,
      });

      const stdoutLines = [];
      const spawn = makeGitStub({
        'pull --rebase --quiet': { status: 0, stdout: '', stderr: '' },
        'symbolic-ref -q HEAD': { status: 0, stdout: 'refs/heads/main\n', stderr: '' },
        'push --quiet': { status: 0, stdout: '', stderr: '' },
      });
      const result = await checkAndRetrySync({
        vaultPath: vault,
        env: { KIOKU_NO_LOG: '0' },
        spawn,
        stderr: () => {},
        stdout: (msg) => stdoutLines.push(msg),
      });
      assert.equal(result.status, 'retry-success');
      assert.equal(result.retryCount, 3, 'reports retryCount incremented (2 prior + 1 retry attempt)');
      assert.equal(existsSync(qPath), false, 'queue cleared on retry success');
      assert.equal(stdoutLines.length, 1);
      assert.equal(/クラウド同期が再開しました/.test(stdoutLines[0]), true);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('queue present + push still fails → updates queue with incremented count + preserves firstAttempt', async () => {
    const vault = await makeVault();
    try {
      const qPath = retryQueuePathFor(vault);
      await writeRetryQueue(qPath, {
        errorType: 'network',
        message: 'prior',
        firstAttempt: '2026-05-14T10:00:00.000Z',
        lastAttempt: '2026-05-14T11:00:00.000Z',
        retryCount: 1,
      });

      const stderrLines = [];
      const spawn = makeGitStub({
        'pull --rebase --quiet': { status: 0, stdout: '', stderr: '' },
        'symbolic-ref -q HEAD': { status: 0, stdout: 'refs/heads/main\n', stderr: '' },
        'push --quiet': {
          status: 1,
          stdout: '',
          stderr: ' ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs',
        },
      });
      const result = await checkAndRetrySync({
        vaultPath: vault,
        env: { KIOKU_NO_LOG: '0' },
        spawn,
        stderr: (msg) => stderrLines.push(msg),
        stdout: () => {},
        now: () => '2026-05-15T12:00:00.000Z',
      });
      assert.equal(result.status, 'retry-failed');
      assert.equal(result.errorType, 'non-fast-forward');
      assert.equal(result.retryCount, 2, 'increments to 2 (was 1)');

      const updated = await readRetryQueue(qPath);
      assert.equal(updated.firstAttempt, '2026-05-14T10:00:00.000Z', 'firstAttempt preserved');
      assert.equal(updated.lastAttempt, '2026-05-15T12:00:00.000Z');
      assert.equal(updated.errorType, 'non-fast-forward');
      assert.equal(updated.retryCount, 2);

      assert.equal(stderrLines.length, 1);
      assert.equal(/クラウド同期に再失敗/.test(stderrLines[0]), true);
      assert.equal(/non-fast-forward/.test(stderrLines[0]), true);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});
