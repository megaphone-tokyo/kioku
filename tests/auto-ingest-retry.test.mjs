// tests/auto-ingest-retry.test.mjs — Sprint 5 PR A5 (BLUE-AUTO-INGEST-A5-1..5)
//
// Target: hooks/auto-ingest-retry.mjs
//
// Test prefixes:
//   - BLUE-AUTO-INGEST-A5-1   classifyAutoIngestError buckets
//                             (extract / llm / fs / sha256 / unknown)
//   - BLUE-AUTO-INGEST-A5-2   maskCredentials scrubs ghp_*, github_pat_*,
//                             Bearer, embedded URL credentials, sk-ant-*
//   - BLUE-AUTO-INGEST-A5-3   queue I/O round-trip (per-source entries) +
//                             atomic write + malformed-tolerant read
//   - BLUE-AUTO-INGEST-A5-4   3-strike promotion to manual review queue +
//                             firstAttempt preserved across retries
//   - BLUE-AUTO-INGEST-A5-5   recordFailure / recordSuccess end-to-end +
//                             credential masking persisted to queue file
//
// Mirrors tests/sync-retry.test.mjs structure (Sprint 4 Phase 4 PR A4).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildAutoIngestRetryEntry,
  classifyAutoIngestError,
  clearQueueFile,
  manualReviewQueuePathFor,
  maskCredentials,
  mergeManualReview,
  partitionForPromotion,
  readAutoIngestRetryQueue,
  readManualReviewQueue,
  recordFailure,
  recordSuccess,
  removeEntry,
  retryQueuePathFor,
  upsertEntry,
  writeAutoIngestRetryQueue,
  writeManualReviewQueue,
} from '../hooks/auto-ingest-retry.mjs';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function makeVault() {
  return mkdtemp(join(tmpdir(), 'kioku-auto-ingest-vault-'));
}

// -----------------------------------------------------------------------------
// BLUE-AUTO-INGEST-A5-1: classifyAutoIngestError buckets
// -----------------------------------------------------------------------------

describe('BLUE-AUTO-INGEST-A5-1 classifyAutoIngestError', () => {
  test('extract_failed: extract-pdf.sh exit 1', () => {
    assert.equal(
      classifyAutoIngestError('extract-pdf.sh: failed (rc=1)\n'),
      'extract_failed'
    );
  });

  test('extract_failed: extract-epub.mjs failure', () => {
    assert.equal(
      classifyAutoIngestError('node extract-epub.mjs: exit 1\n'),
      'extract_failed'
    );
  });

  test('extract_failed: yauzl invalid container', () => {
    assert.equal(
      classifyAutoIngestError('yauzl: invalid central directory record\n'),
      'extract_failed'
    );
  });

  test('llm_failed: claude timeout', () => {
    assert.equal(
      classifyAutoIngestError('claude -p timed out after 600s\n'),
      'llm_failed'
    );
  });

  test('llm_failed: max-turns reached', () => {
    assert.equal(
      classifyAutoIngestError('claude: max-turns reached\n'),
      'llm_failed'
    );
  });

  test('llm_failed: anthropic error', () => {
    assert.equal(
      classifyAutoIngestError('anthropic.error: 529 Overloaded\n'),
      'llm_failed'
    );
  });

  test('llm_failed: rate limit', () => {
    assert.equal(
      classifyAutoIngestError('429 rate-limit reached\n'),
      'llm_failed'
    );
  });

  test('fs_error: ENOENT', () => {
    assert.equal(
      classifyAutoIngestError('Error: ENOENT: no such file or directory, open ...\n'),
      'fs_error'
    );
  });

  test('fs_error: EACCES', () => {
    assert.equal(
      classifyAutoIngestError('EACCES: permission denied, open ...\n'),
      'fs_error'
    );
  });

  test('fs_error: ENOSPC', () => {
    assert.equal(
      classifyAutoIngestError('ENOSPC: no space left on device\n'),
      'fs_error'
    );
  });

  test('sha256_drift: mismatch detected', () => {
    assert.equal(
      classifyAutoIngestError('source_sha256 mismatch detected for chunk\n'),
      'sha256_drift'
    );
  });

  test('sha256_drift: sidecar drift', () => {
    assert.equal(
      classifyAutoIngestError('sidecar drift between raw MD and summary\n'),
      'sha256_drift'
    );
  });

  test('unknown: empty + unrecognized', () => {
    assert.equal(classifyAutoIngestError(''), 'unknown');
    assert.equal(classifyAutoIngestError(null), 'unknown');
    assert.equal(classifyAutoIngestError('something weird happened'), 'unknown');
  });
});

// -----------------------------------------------------------------------------
// BLUE-AUTO-INGEST-A5-2: maskCredentials (delegates to maskText SSOT)
// -----------------------------------------------------------------------------

describe('BLUE-AUTO-INGEST-A5-2 maskCredentials', () => {
  test('masks ghp_ classic token', () => {
    const input = 'extract-pdf.sh failed: https://ghp_ABCDEFGHIJ1234567890abcdefg@github.com/org/repo.git';
    const masked = maskCredentials(input);
    assert.equal(masked.includes('ghp_ABCDEFGHIJ1234567890'), false);
    assert.equal(masked.includes('ghp_***'), true);
  });

  test('masks github_pat_ fine-grained token', () => {
    const input = 'remote: github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz fail';
    const masked = maskCredentials(input);
    assert.equal(/github_pat_11ABCDEFG0abcdefghijklm/.test(masked), false);
    assert.equal(masked.includes('github_pat_***'), true);
  });

  test('masks sk-ant Anthropic token', () => {
    const input = 'anthropic.error: invalid token sk-ant-abcdefghij1234567890ABC';
    const masked = maskCredentials(input);
    assert.equal(masked.includes('sk-ant-abcdefghij1234567890'), false);
    assert.equal(masked.includes('sk-ant-***'), true);
  });

  test('masks Bearer header', () => {
    const input = 'Authorization: Bearer abc.DEF.GHIjklmnop123';
    const masked = maskCredentials(input);
    assert.equal(masked.includes('abc.DEF.GHIjklmnop123'), false);
    assert.equal(masked.includes('Bearer ***'), true);
  });

  test('masks embedded URL credentials', () => {
    const input = 'fatal: https://user:s3cret@github.com/repo.git';
    const masked = maskCredentials(input);
    assert.equal(masked.includes('user:s3cret'), false);
    assert.equal(masked.includes('://***:***@'), true);
  });

  test('non-string input returns empty string', () => {
    assert.equal(maskCredentials(null), '');
    assert.equal(maskCredentials(undefined), '');
    assert.equal(maskCredentials(42), '');
  });

  test('plain text passes through', () => {
    const input = 'extract-pdf.sh: failed';
    assert.equal(maskCredentials(input), input);
  });
});

// -----------------------------------------------------------------------------
// BLUE-AUTO-INGEST-A5-3: queue I/O round-trip + per-source array shape
// -----------------------------------------------------------------------------

describe('BLUE-AUTO-INGEST-A5-3 queue I/O', () => {
  test('write then read returns the same entries', async () => {
    const vault = await makeVault();
    try {
      const queue = {
        version: 1,
        entries: [
          buildAutoIngestRetryEntry({
            rawSource: 'raw-sources/articles/a.pdf',
            errorType: 'extract_failed',
            stderr: 'extract-pdf.sh: rc=1',
            now: () => '2026-05-17T10:00:00.000Z',
          }),
          buildAutoIngestRetryEntry({
            rawSource: 'raw-sources/books/b.epub',
            errorType: 'extract_failed',
            stderr: 'yauzl: invalid',
            now: () => '2026-05-17T10:01:00.000Z',
          }),
        ],
      };
      await writeAutoIngestRetryQueue(vault, queue);
      assert.equal(existsSync(retryQueuePathFor(vault)), true);
      const round = await readAutoIngestRetryQueue(vault);
      assert.equal(round.entries.length, 2);
      assert.equal(round.entries[0].rawSource, 'raw-sources/articles/a.pdf');
      assert.equal(round.entries[0].retryCount, 0);
      assert.equal(round.entries[1].rawSource, 'raw-sources/books/b.epub');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('subsequent buildAutoIngestRetryEntry preserves firstAttempt + increments retryCount', () => {
    const previous = buildAutoIngestRetryEntry({
      rawSource: 'raw-sources/foo.pdf',
      errorType: 'extract_failed',
      stderr: 'first',
      now: () => '2026-05-17T10:00:00.000Z',
    });
    const next = buildAutoIngestRetryEntry({
      rawSource: 'raw-sources/foo.pdf',
      errorType: 'extract_failed',
      stderr: 'second',
      previous,
      now: () => '2026-05-17T11:00:00.000Z',
    });
    assert.equal(next.firstAttempt, '2026-05-17T10:00:00.000Z');
    assert.equal(next.lastAttempt, '2026-05-17T11:00:00.000Z');
    assert.equal(next.retryCount, 1);
  });

  test('upsertEntry replaces existing entry for same rawSource (not appended)', () => {
    const initial = upsertEntry(
      { entries: [] },
      {
        rawSource: 'raw-sources/foo.pdf',
        errorType: 'extract_failed',
        stderr: 'first',
        now: () => '2026-05-17T10:00:00.000Z',
      }
    );
    assert.equal(initial.entries.length, 1);
    const updated = upsertEntry(initial, {
      rawSource: 'raw-sources/foo.pdf',
      errorType: 'extract_failed',
      stderr: 'second',
      now: () => '2026-05-17T11:00:00.000Z',
    });
    assert.equal(updated.entries.length, 1, 'no duplicate entries for same rawSource');
    assert.equal(updated.entries[0].retryCount, 1);
    assert.equal(updated.entries[0].firstAttempt, '2026-05-17T10:00:00.000Z');
  });

  test('upsertEntry appends entries with different rawSource', () => {
    const queue = upsertEntry(
      upsertEntry(
        { entries: [] },
        { rawSource: 'a.pdf', errorType: 'extract_failed', stderr: '' }
      ),
      { rawSource: 'b.pdf', errorType: 'llm_failed', stderr: '' }
    );
    assert.equal(queue.entries.length, 2);
    const sources = queue.entries.map((e) => e.rawSource).sort();
    assert.deepEqual(sources, ['a.pdf', 'b.pdf']);
  });

  test('removeEntry strips matching rawSource (no-op when absent)', () => {
    const initial = upsertEntry(
      { entries: [] },
      { rawSource: 'a.pdf', errorType: 'extract_failed', stderr: '' }
    );
    const after = removeEntry(initial, 'a.pdf');
    assert.equal(after.entries.length, 0);
    const noop = removeEntry(initial, 'nonexistent.pdf');
    assert.equal(noop.entries.length, 1);
  });

  test('readAutoIngestRetryQueue tolerates malformed JSON', async () => {
    const vault = await makeVault();
    try {
      await writeFile(retryQueuePathFor(vault), '{ not valid json', 'utf8');
      const round = await readAutoIngestRetryQueue(vault);
      assert.deepEqual(round, { version: 1, entries: [] });
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('readAutoIngestRetryQueue returns empty queue for missing file', async () => {
    const vault = await makeVault();
    try {
      const round = await readAutoIngestRetryQueue(vault);
      assert.deepEqual(round, { version: 1, entries: [] });
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('writeAutoIngestRetryQueue removes file when entries empty', async () => {
    const vault = await makeVault();
    try {
      await writeAutoIngestRetryQueue(vault, {
        entries: [
          buildAutoIngestRetryEntry({
            rawSource: 'a.pdf',
            errorType: 'extract_failed',
            stderr: 'x',
            now: () => '2026-05-17T10:00:00.000Z',
          }),
        ],
      });
      assert.equal(existsSync(retryQueuePathFor(vault)), true);
      await writeAutoIngestRetryQueue(vault, { entries: [] });
      assert.equal(existsSync(retryQueuePathFor(vault)), false, 'empty queue removes file');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('clearQueueFile is idempotent', async () => {
    const vault = await makeVault();
    try {
      const path = retryQueuePathFor(vault);
      await clearQueueFile(path); // missing file: no throw
      await writeAutoIngestRetryQueue(vault, {
        entries: [
          buildAutoIngestRetryEntry({
            rawSource: 'a.pdf',
            errorType: 'extract_failed',
            stderr: '',
            now: () => '2026-05-17T10:00:00.000Z',
          }),
        ],
      });
      assert.equal(existsSync(path), true);
      await clearQueueFile(path);
      assert.equal(existsSync(path), false);
      await clearQueueFile(path); // second time: still no throw
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// BLUE-AUTO-INGEST-A5-4: 3-strike promotion to manual review queue
// -----------------------------------------------------------------------------

describe('BLUE-AUTO-INGEST-A5-4 manual review promotion', () => {
  test('partitionForPromotion holds entries below threshold', () => {
    const queue = {
      entries: [
        { rawSource: 'a.pdf', errorType: 'extract_failed', retryCount: 0 },
        { rawSource: 'b.pdf', errorType: 'extract_failed', retryCount: 1 },
        { rawSource: 'c.pdf', errorType: 'extract_failed', retryCount: 2 },
      ],
    };
    const { keep, promote } = partitionForPromotion(queue);
    assert.equal(keep.entries.length, 3);
    assert.equal(promote.length, 0);
  });

  test('partitionForPromotion promotes retryCount >= threshold', () => {
    const queue = {
      entries: [
        { rawSource: 'a.pdf', errorType: 'extract_failed', retryCount: 2 },
        { rawSource: 'b.pdf', errorType: 'llm_failed', retryCount: 3 },
        { rawSource: 'c.pdf', errorType: 'fs_error', retryCount: 5 },
      ],
    };
    const { keep, promote } = partitionForPromotion(queue);
    assert.equal(keep.entries.length, 1);
    assert.equal(keep.entries[0].rawSource, 'a.pdf');
    assert.equal(promote.length, 2);
    assert.deepEqual(
      promote.map((e) => e.rawSource).sort(),
      ['b.pdf', 'c.pdf']
    );
  });

  test('mergeManualReview last-write-wins on duplicate rawSource', () => {
    const existing = {
      entries: [{ rawSource: 'a.pdf', errorType: 'extract_failed', retryCount: 3 }],
    };
    const adds = [
      { rawSource: 'a.pdf', errorType: 'llm_failed', retryCount: 5 },
      { rawSource: 'b.pdf', errorType: 'fs_error', retryCount: 3 },
    ];
    const merged = mergeManualReview(existing, adds);
    assert.equal(merged.entries.length, 2);
    const a = merged.entries.find((e) => e.rawSource === 'a.pdf');
    assert.equal(a.errorType, 'llm_failed', 'last-write-wins');
    assert.equal(a.retryCount, 5);
  });

  test('end-to-end: 4 failures for same rawSource → moved to manual review on 4th', async () => {
    const vault = await makeVault();
    try {
      const rawSource = 'raw-sources/articles/foo.pdf';

      // Failure 1: retryCount=0, in retry queue
      let result = await recordFailure({
        vaultPath: vault,
        rawSource,
        errorType: 'extract_failed',
        stderr: 'extract-pdf.sh: rc=1',
        now: () => '2026-05-17T10:00:00.000Z',
      });
      assert.equal(result.status, 'queued');
      assert.equal(result.retryCount, 0);
      let retry = await readAutoIngestRetryQueue(vault);
      assert.equal(retry.entries.length, 1);
      let manual = await readManualReviewQueue(vault);
      assert.equal(manual.entries.length, 0);

      // Failure 2: retryCount=1
      result = await recordFailure({
        vaultPath: vault,
        rawSource,
        errorType: 'extract_failed',
        stderr: 'extract-pdf.sh: rc=1',
        now: () => '2026-05-17T11:00:00.000Z',
      });
      assert.equal(result.status, 'queued');
      assert.equal(result.retryCount, 1);

      // Failure 3: retryCount=2
      result = await recordFailure({
        vaultPath: vault,
        rawSource,
        errorType: 'extract_failed',
        stderr: 'extract-pdf.sh: rc=1',
        now: () => '2026-05-17T12:00:00.000Z',
      });
      assert.equal(result.status, 'queued');
      assert.equal(result.retryCount, 2);
      retry = await readAutoIngestRetryQueue(vault);
      assert.equal(retry.entries.length, 1, 'still in retry queue at retryCount=2');

      // Failure 4: retryCount would become 3 → promote to manual review
      result = await recordFailure({
        vaultPath: vault,
        rawSource,
        errorType: 'extract_failed',
        stderr: 'extract-pdf.sh: rc=1',
        now: () => '2026-05-17T13:00:00.000Z',
      });
      assert.equal(result.status, 'promoted');
      assert.equal(result.retryCount, 3);
      assert.equal(result.promotedCount, 1);

      retry = await readAutoIngestRetryQueue(vault);
      assert.equal(retry.entries.length, 0, 'retry queue cleared after promotion');
      manual = await readManualReviewQueue(vault);
      assert.equal(manual.entries.length, 1, 'manual review queue contains promoted entry');
      assert.equal(manual.entries[0].rawSource, rawSource);
      assert.equal(manual.entries[0].retryCount, 3);
      assert.equal(manual.entries[0].firstAttempt, '2026-05-17T10:00:00.000Z');
      assert.equal(manual.entries[0].lastAttempt, '2026-05-17T13:00:00.000Z');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('different rawSources tracked independently', async () => {
    const vault = await makeVault();
    try {
      await recordFailure({
        vaultPath: vault,
        rawSource: 'a.pdf',
        errorType: 'extract_failed',
        stderr: '',
        now: () => '2026-05-17T10:00:00.000Z',
      });
      await recordFailure({
        vaultPath: vault,
        rawSource: 'b.pdf',
        errorType: 'llm_failed',
        stderr: '',
        now: () => '2026-05-17T10:01:00.000Z',
      });
      const queue = await readAutoIngestRetryQueue(vault);
      assert.equal(queue.entries.length, 2);
      const sources = queue.entries.map((e) => e.rawSource).sort();
      assert.deepEqual(sources, ['a.pdf', 'b.pdf']);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// BLUE-AUTO-INGEST-A5-5: recordFailure / recordSuccess + masking persistence
// -----------------------------------------------------------------------------

describe('BLUE-AUTO-INGEST-A5-5 recordFailure / recordSuccess', () => {
  test('recordSuccess removes entry from retry queue', async () => {
    const vault = await makeVault();
    try {
      await recordFailure({
        vaultPath: vault,
        rawSource: 'a.pdf',
        errorType: 'extract_failed',
        stderr: 'rc=1',
        now: () => '2026-05-17T10:00:00.000Z',
      });
      assert.equal(existsSync(retryQueuePathFor(vault)), true);
      const result = await recordSuccess({ vaultPath: vault, rawSource: 'a.pdf' });
      assert.equal(result.status, 'cleared');
      assert.equal(existsSync(retryQueuePathFor(vault)), false, 'queue file removed when last entry cleared');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('recordSuccess on absent rawSource is no-op', async () => {
    const vault = await makeVault();
    try {
      const result = await recordSuccess({ vaultPath: vault, rawSource: 'never-failed.pdf' });
      assert.equal(result.status, 'noop');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('recordSuccess preserves manual review queue (does not auto-clear human-pending entries)', async () => {
    const vault = await makeVault();
    try {
      // Force promotion to manual review by 4 failures
      const rawSource = 'raw-sources/articles/foo.pdf';
      for (let i = 0; i < 4; i += 1) {
        await recordFailure({
          vaultPath: vault,
          rawSource,
          errorType: 'extract_failed',
          stderr: 'rc=1',
          now: () => `2026-05-17T1${i}:00:00.000Z`,
        });
      }
      const manualBefore = await readManualReviewQueue(vault);
      assert.equal(manualBefore.entries.length, 1);

      // recordSuccess should remove from retry queue (already absent) but
      // leave manual review intact for human inspection
      await recordSuccess({ vaultPath: vault, rawSource });
      const manualAfter = await readManualReviewQueue(vault);
      assert.equal(manualAfter.entries.length, 1, 'manual review queue retained after success');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('serialized retry queue file never includes raw token literal', async () => {
    const vault = await makeVault();
    try {
      await recordFailure({
        vaultPath: vault,
        rawSource: 'raw-sources/articles/foo.pdf',
        errorType: 'extract_failed',
        stderr: 'fatal: https://ghp_VeryRealLookingToken1234567890abcdef@github.com fail',
        now: () => '2026-05-17T10:00:00.000Z',
      });
      const raw = await readFile(retryQueuePathFor(vault), 'utf8');
      assert.equal(
        raw.includes('ghp_VeryRealLookingToken1234567890'),
        false,
        'token literal must never appear in serialized queue file'
      );
      assert.equal(raw.includes('ghp_***'), true, 'masked replacement present');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('serialized retry queue file masks Bearer token', async () => {
    const vault = await makeVault();
    try {
      await recordFailure({
        vaultPath: vault,
        rawSource: 'raw-sources/articles/bar.pdf',
        errorType: 'llm_failed',
        stderr: 'anthropic 401: Authorization: Bearer abc.DEF.GHIjkl987654321',
        now: () => '2026-05-17T10:00:00.000Z',
      });
      const raw = await readFile(retryQueuePathFor(vault), 'utf8');
      assert.equal(raw.includes('abc.DEF.GHIjkl987654321'), false);
      assert.equal(raw.includes('Bearer ***'), true);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('manual review queue file also has credentials masked', async () => {
    const vault = await makeVault();
    try {
      const rawSource = 'raw-sources/articles/foo.pdf';
      // 4 failures to force promotion
      for (let i = 0; i < 4; i += 1) {
        await recordFailure({
          vaultPath: vault,
          rawSource,
          errorType: 'extract_failed',
          stderr: `rc=1 https://ghp_LeakedTokenAttempt${i}1234567890abcdef@github.com fail`,
          now: () => `2026-05-17T1${i}:00:00.000Z`,
        });
      }
      const manualPath = manualReviewQueuePathFor(vault);
      assert.equal(existsSync(manualPath), true);
      const raw = await readFile(manualPath, 'utf8');
      assert.equal(/ghp_LeakedTokenAttempt\d/.test(raw), false);
      assert.equal(raw.includes('ghp_***'), true);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test('recordFailure truncates very long stderr to MAX_STDERR_EXCERPT (512)', async () => {
    const vault = await makeVault();
    try {
      const longStderr = 'a'.repeat(2000);
      await recordFailure({
        vaultPath: vault,
        rawSource: 'a.pdf',
        errorType: 'extract_failed',
        stderr: longStderr,
        now: () => '2026-05-17T10:00:00.000Z',
      });
      const queue = await readAutoIngestRetryQueue(vault);
      assert.equal(queue.entries[0].message.length, 512);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});
