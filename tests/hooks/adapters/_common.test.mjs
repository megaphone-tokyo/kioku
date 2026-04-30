// tests/hooks/adapters/_common.test.mjs — v0.7.1 hardening unit tests
//
// Targets: hooks/adapters/_common.mjs
// Test prefixes:
//   - BLUE-COMMON-LISTENER-IDEMPOTENT-* : §38 fix (process listener gate idempotent)
//   - BLUE-COMMON-TRANSCRIPT-ROOT-*     : §36 fix (assertTranscriptInRoot allowlist)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensureCrashListenersIdempotent,
  assertTranscriptInRoot,
  TranscriptPathError,
} from '../../../hooks/adapters/_common.mjs';

// -----------------------------------------------------------------------------
// BLUE-COMMON-LISTENER-IDEMPOTENT (§38)
// -----------------------------------------------------------------------------

describe('_common: BLUE-COMMON-LISTENER-IDEMPOTENT process listener gate', () => {
  test('BLUE-COMMON-LISTENER-IDEMPOTENT-1: 5 calls add at most 1 listener', () => {
    const beforeUR = process.listenerCount('unhandledRejection');
    const beforeUE = process.listenerCount('uncaughtException');
    for (let i = 0; i < 5; i++) ensureCrashListenersIdempotent();
    const deltaUR = process.listenerCount('unhandledRejection') - beforeUR;
    const deltaUE = process.listenerCount('uncaughtException') - beforeUE;
    assert.ok(
      deltaUR <= 1,
      `unhandledRejection delta=${deltaUR}, expected <= 1 (gate must prevent accumulation)`,
    );
    assert.ok(
      deltaUE <= 1,
      `uncaughtException delta=${deltaUE}, expected <= 1 (gate must prevent accumulation)`,
    );
  });

  test('BLUE-COMMON-LISTENER-IDEMPOTENT-2: subsequent calls add 0 listeners', () => {
    // Ensure gate is locked first (prior test may already have done this)
    ensureCrashListenersIdempotent();
    const baselineUR = process.listenerCount('unhandledRejection');
    const baselineUE = process.listenerCount('uncaughtException');
    for (let i = 0; i < 10; i++) ensureCrashListenersIdempotent();
    assert.equal(
      process.listenerCount('unhandledRejection'),
      baselineUR,
      'subsequent calls must not register additional unhandledRejection listeners',
    );
    assert.equal(
      process.listenerCount('uncaughtException'),
      baselineUE,
      'subsequent calls must not register additional uncaughtException listeners',
    );
  });
});

// -----------------------------------------------------------------------------
// BLUE-COMMON-TRANSCRIPT-ROOT (§36)
// -----------------------------------------------------------------------------

async function withFakeHome(fn) {
  const tmp = await mkdtemp(join(tmpdir(), 'kioku-tx-root-'));
  const originalHome = process.env.HOME;
  try {
    process.env.HOME = tmp;
    await fn(tmp);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(tmp, { recursive: true, force: true });
  }
}

describe('_common: BLUE-COMMON-TRANSCRIPT-ROOT assertTranscriptInRoot', () => {
  test('BLUE-COMMON-TRANSCRIPT-ROOT-CLAUDE-PASS: claude path inside ~/.claude/projects passes', async () => {
    await withFakeHome(async (home) => {
      const dir = join(home, '.claude', 'projects');
      await mkdir(dir, { recursive: true });
      const safe = join(dir, 'session-abcdef.jsonl');
      await writeFile(safe, '{}');
      const resolved = await assertTranscriptInRoot('claude', safe);
      // resolved は realpath 経由なので macOS の /var → /private/var resolution を考慮し
      // 入力 path の realpath と一致すること、かつ safe root subpath であることを assert。
      const expected = await realpath(safe);
      assert.equal(resolved, expected);
      const safeRoot = await realpath(dir);
      assert.ok(
        resolved === safeRoot || resolved.startsWith(safeRoot + '/'),
        `resolved=${resolved} must be inside ${safeRoot}`,
      );
    });
  });

  test('BLUE-COMMON-TRANSCRIPT-ROOT-CLAUDE-OUTSIDE: claude path outside throws OUTSIDE_SAFE_ROOTS', async () => {
    await withFakeHome(async (home) => {
      // file exists but is outside ~/.claude/projects
      const dir = join(home, '.claude', 'projects');
      await mkdir(dir, { recursive: true });
      const outside = join(home, 'other-place.jsonl');
      await writeFile(outside, '{}');
      await assert.rejects(
        () => assertTranscriptInRoot('claude', outside),
        (err) => err instanceof TranscriptPathError && err.code === 'OUTSIDE_SAFE_ROOTS',
        'claude transcript outside ~/.claude/projects must throw',
      );
    });
  });

  test('BLUE-COMMON-TRANSCRIPT-ROOT-GEMINI-OUTSIDE: gemini path outside throws OUTSIDE_SAFE_ROOTS', async () => {
    await withFakeHome(async (home) => {
      const safeDir = join(home, '.gemini', 'chats');
      await mkdir(safeDir, { recursive: true });
      const outside = join(home, 'evil.json');
      await writeFile(outside, '{}');
      await assert.rejects(
        () => assertTranscriptInRoot('gemini', outside),
        (err) => err instanceof TranscriptPathError && err.code === 'OUTSIDE_SAFE_ROOTS',
        'gemini transcript outside safe roots must throw',
      );
    });
  });

  test('BLUE-COMMON-TRANSCRIPT-ROOT-CODEX-OUTSIDE: codex path outside throws OUTSIDE_SAFE_ROOTS', async () => {
    await withFakeHome(async (home) => {
      const safeDir = join(home, '.codex', 'sessions');
      await mkdir(safeDir, { recursive: true });
      const outside = join(home, 'attack.jsonl');
      await writeFile(outside, '{}');
      await assert.rejects(
        () => assertTranscriptInRoot('codex', outside),
        (err) => err instanceof TranscriptPathError && err.code === 'OUTSIDE_SAFE_ROOTS',
        'codex transcript outside ~/.codex/sessions must throw',
      );
    });
  });

  test('BLUE-COMMON-TRANSCRIPT-ROOT-SYMLINK-ESCAPE: symlink inside safe root pointing outside throws', async () => {
    await withFakeHome(async (home) => {
      const safeDir = join(home, '.claude', 'projects');
      await mkdir(safeDir, { recursive: true });
      const evilTarget = join(home, 'outside-target.jsonl');
      await writeFile(evilTarget, 'pwned');
      const escapeLink = join(safeDir, 'escape.jsonl');
      await symlink(evilTarget, escapeLink);
      await assert.rejects(
        () => assertTranscriptInRoot('claude', escapeLink),
        (err) => err instanceof TranscriptPathError && err.code === 'OUTSIDE_SAFE_ROOTS',
        'symlink in safe root pointing outside must throw (realpath resolves before prefix check)',
      );
    });
  });

  test('BLUE-COMMON-TRANSCRIPT-ROOT-NONSTRING: non-string path throws PATH_NOT_STRING', async () => {
    await assert.rejects(
      () => assertTranscriptInRoot('claude', null),
      (err) => err instanceof TranscriptPathError && err.code === 'PATH_NOT_STRING',
    );
    await assert.rejects(
      () => assertTranscriptInRoot('claude', ''),
      (err) => err instanceof TranscriptPathError && err.code === 'PATH_NOT_STRING',
    );
  });

  test('BLUE-COMMON-TRANSCRIPT-ROOT-UNKNOWN-AGENT: unknown agent throws UNKNOWN_AGENT', async () => {
    await withFakeHome(async (home) => {
      const f = join(home, 'x.jsonl');
      await writeFile(f, '{}');
      await assert.rejects(
        () => assertTranscriptInRoot('openai', f),
        (err) => err instanceof TranscriptPathError && err.code === 'UNKNOWN_AGENT',
      );
    });
  });

  test('BLUE-COMMON-TRANSCRIPT-ROOT-MISSING-FILE: realpath failure throws REALPATH_FAILED', async () => {
    await withFakeHome(async (home) => {
      const missing = join(home, '.claude', 'projects', 'no-such-file.jsonl');
      await assert.rejects(
        () => assertTranscriptInRoot('claude', missing),
        (err) => err instanceof TranscriptPathError && /^REALPATH_FAILED/.test(err.code),
      );
    });
  });
});
