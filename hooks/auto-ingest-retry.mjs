#!/usr/bin/env node
// hooks/auto-ingest-retry.mjs — Auto-ingest pipeline retry queue (Sprint 5 PR A5).
//
// Mirrors hooks/sync-vault.mjs (Sprint 4 Phase 4 PR A4) but adapted for the
// auto-ingest pipeline. Where sync-vault.mjs tracks a single push failure
// (atomic batch op), auto-ingest fails per-raw-source so the queue holds an
// array of entries keyed by `rawSource`.
//
// Failure points wired by scripts/auto-ingest.sh:
//   - extract pre-step (PDF / EPUB / DOCX / URL): per-source failures
//   - claude -p invocation: a single batch failure recorded against
//     `<llm-batch>` placeholder (LLM operates on all unprocessed sources)
//
// Queue lifecycle:
//   - First failure for a rawSource     → entry added with retryCount=0
//   - Subsequent failures for same key  → retryCount incremented
//   - retryCount >= MAX_RETRY_COUNT (3) → entry promoted to manual review queue
//   - Successful processing             → entry removed from retry queue
//
// Files in $OBSIDIAN_VAULT:
//   - .kioku-auto-ingest-retry.json          retry queue (subject to retry)
//   - .kioku-auto-ingest-manual-review.json  exhausted entries (human action)
//
// Security contract (mirrors sync-vault.mjs):
//   - Every stderr string passes through maskText() (scripts/lib/masking.mjs
//     SSOT) before being persisted to disk or printed to user.
//   - Never reads process.env.* token literals; only error type + masked
//     message + raw-source path are persisted.
//   - Atomic writes (tmp file + rename) so a partial JSON cannot be observed
//     by a concurrent reader (doctor.sh, next cron tick).
//   - Reads tolerate malformed JSON (treat queue as absent).

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

const RETRY_QUEUE_FILENAME = '.kioku-auto-ingest-retry.json';
const MANUAL_REVIEW_FILENAME = '.kioku-auto-ingest-manual-review.json';
const MAX_STDERR_EXCERPT = 512;
const MAX_RETRY_COUNT = 3;
const SCHEMA_VERSION = 1;

// -----------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// -----------------------------------------------------------------------------

/**
 * Classify an auto-ingest stderr into one of five bucket strings. Order is
 * conservative: only stderr patterns confidently mapping to a single bucket.
 */
export function classifyAutoIngestError(stderr) {
  if (typeof stderr !== 'string' || stderr.length === 0) return 'unknown';
  if (
    /sha256.*mismatch/i.test(stderr) ||
    /sidecar.*drift/i.test(stderr) ||
    /source_sha256.*differ/i.test(stderr)
  ) {
    return 'sha256_drift';
  }
  if (
    /extract-(pdf|epub|docx|url|html)\.(sh|mjs).*(failed|exit\s+1|rc=[1-9])/i.test(stderr) ||
    /poppler.*missing/i.test(stderr) ||
    /yauzl.*invalid/i.test(stderr) ||
    /mammoth.*failed/i.test(stderr) ||
    /readability.*null/i.test(stderr)
  ) {
    return 'extract_failed';
  }
  if (
    /\bclaude\b.*(timeout|timed out)/i.test(stderr) ||
    /anthropic.*error/i.test(stderr) ||
    /\bllm\b.*(failed|error)/i.test(stderr) ||
    /max-turns.*reached/i.test(stderr) ||
    /\bcontext.*(too\s+long|exceeded)/i.test(stderr) ||
    /rate.?limit/i.test(stderr) ||
    /api[_\-]?error/i.test(stderr)
  ) {
    return 'llm_failed';
  }
  if (
    /\bENOENT\b/.test(stderr) ||
    /\bEACCES\b/.test(stderr) ||
    /\bENOSPC\b/.test(stderr) ||
    /\bEEXIST\b/.test(stderr) ||
    /\bEISDIR\b/.test(stderr) ||
    /no\s+such\s+file\s+or\s+directory/i.test(stderr) ||
    /permission\s+denied/i.test(stderr) ||
    /no\s+space\s+left\s+on\s+device/i.test(stderr)
  ) {
    return 'fs_error';
  }
  return 'unknown';
}

/**
 * Mask credential-like substrings before they leak into the retry queue file
 * or user-visible stderr. Thin wrapper over maskText so call sites read
 * intentionally ("we are masking for credential safety").
 */
export function maskCredentials(text) {
  if (typeof text !== 'string') return '';
  return maskText(text);
}

/**
 * Compute the retry queue path for a given vault.
 */
export function retryQueuePathFor(vaultPath) {
  return join(vaultPath, RETRY_QUEUE_FILENAME);
}

/**
 * Compute the manual review queue path for a given vault.
 */
export function manualReviewQueuePathFor(vaultPath) {
  return join(vaultPath, MANUAL_REVIEW_FILENAME);
}

/**
 * Atomically write a queue file. Writes to a tmp file in the parent directory
 * of the target, then renames into place — rename is atomic on the same
 * filesystem so concurrent readers never observe partial JSON.
 */
export async function writeQueueFile(queuePath, queue) {
  const parent = dirname(queuePath);
  const tmpDir = await mkdtemp(join(parent, '.kioku-auto-ingest-tmp-'));
  const tmpFile = join(tmpDir, 'queue.json');
  try {
    await writeFile(tmpFile, JSON.stringify(queue, null, 2) + '\n', 'utf8');
    await rename(tmpFile, queuePath);
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
 * Read and parse a queue file. Returns null if the file is missing or
 * malformed (defensive: a corrupt queue must not block the pipeline).
 * Always returns the canonical shape `{ version, entries: [...] }` when valid;
 * legacy single-entry shape is migrated transparently.
 */
export async function readQueueFile(queuePath) {
  if (!existsSync(queuePath)) return null;
  try {
    const raw = await readFile(queuePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (Array.isArray(parsed.entries)) {
      return {
        version: Number.isFinite(parsed.version) ? parsed.version : SCHEMA_VERSION,
        entries: parsed.entries,
      };
    }
    return { version: SCHEMA_VERSION, entries: [] };
  } catch {
    return null;
  }
}

/**
 * Remove a queue file. Idempotent — missing file is not an error.
 */
export async function clearQueueFile(queuePath) {
  try {
    await unlink(queuePath);
  } catch (e) {
    if (e && e.code === 'ENOENT') return;
    /* best-effort; queue is auxiliary state */
  }
}

/**
 * Read the retry queue. Convenience over readQueueFile that always returns the
 * canonical empty-queue shape when nothing is present (callers prefer
 * `.entries.length === 0` over null-checks for the common path).
 */
export async function readAutoIngestRetryQueue(vaultPath) {
  const queue = await readQueueFile(retryQueuePathFor(vaultPath));
  return queue || { version: SCHEMA_VERSION, entries: [] };
}

/**
 * Read the manual review queue. Same canonical-empty contract as the retry
 * queue read.
 */
export async function readManualReviewQueue(vaultPath) {
  const queue = await readQueueFile(manualReviewQueuePathFor(vaultPath));
  return queue || { version: SCHEMA_VERSION, entries: [] };
}

/**
 * Write the retry queue. If `entries` is empty, the queue file is removed
 * (no point keeping an empty queue around for doctor.sh to misreport).
 */
export async function writeAutoIngestRetryQueue(vaultPath, queue) {
  const queuePath = retryQueuePathFor(vaultPath);
  if (!queue || !Array.isArray(queue.entries) || queue.entries.length === 0) {
    await clearQueueFile(queuePath);
    return;
  }
  await writeQueueFile(queuePath, {
    version: SCHEMA_VERSION,
    entries: queue.entries,
  });
}

/**
 * Append an entry to the manual review queue. Existing review queue is loaded,
 * the entry is appended (or replaces an existing entry with the same
 * rawSource), and the queue is written back atomically.
 */
export async function writeManualReviewQueue(vaultPath, queue) {
  const queuePath = manualReviewQueuePathFor(vaultPath);
  if (!queue || !Array.isArray(queue.entries) || queue.entries.length === 0) {
    await clearQueueFile(queuePath);
    return;
  }
  await writeQueueFile(queuePath, {
    version: SCHEMA_VERSION,
    entries: queue.entries,
  });
}

/**
 * Build a queue entry for a single failure. Centralizes the masking +
 * truncation contract so callers cannot forget to mask. `previous` lets
 * callers preserve `firstAttempt` and increment `retryCount` when updating an
 * existing entry.
 */
export function buildAutoIngestRetryEntry({ rawSource, errorType, stderr, previous, now }) {
  const clock = typeof now === 'function' ? now : () => new Date().toISOString();
  const ts = clock();
  const message = maskCredentials(stderr || '').slice(0, MAX_STDERR_EXCERPT);
  if (previous && typeof previous === 'object') {
    return {
      rawSource,
      errorType,
      message,
      firstAttempt: previous.firstAttempt || ts,
      lastAttempt: ts,
      retryCount: Number.isFinite(previous.retryCount) ? previous.retryCount + 1 : 1,
    };
  }
  return {
    rawSource,
    errorType,
    message,
    firstAttempt: ts,
    lastAttempt: ts,
    retryCount: 0,
  };
}

/**
 * Add or update an entry in the retry queue. If the same rawSource already
 * has an entry, build the next entry with `previous` (preserves
 * firstAttempt + increments retryCount). Returns the updated queue (does not
 * write — caller writes after deciding promote-to-manual-review).
 */
export function upsertEntry(queue, { rawSource, errorType, stderr, now }) {
  const entries = Array.isArray(queue && queue.entries) ? [...queue.entries] : [];
  const idx = entries.findIndex((e) => e && e.rawSource === rawSource);
  const previous = idx >= 0 ? entries[idx] : null;
  const next = buildAutoIngestRetryEntry({ rawSource, errorType, stderr, previous, now });
  if (idx >= 0) {
    entries[idx] = next;
  } else {
    entries.push(next);
  }
  return { version: SCHEMA_VERSION, entries };
}

/**
 * Remove an entry by rawSource. Returns the updated queue. Missing entry is
 * a no-op (returns queue unchanged).
 */
export function removeEntry(queue, rawSource) {
  const entries = Array.isArray(queue && queue.entries) ? queue.entries : [];
  const next = entries.filter((e) => !e || e.rawSource !== rawSource);
  return { version: SCHEMA_VERSION, entries: next };
}

/**
 * Split the retry queue into `keep` (entries still under threshold) and
 * `promote` (entries that have hit MAX_RETRY_COUNT and should be moved to
 * the manual review queue). Threshold comparison is `>=` so that the third
 * retry failure (retryCount=3) triggers promotion.
 */
export function partitionForPromotion(queue, threshold = MAX_RETRY_COUNT) {
  const entries = Array.isArray(queue && queue.entries) ? queue.entries : [];
  const keep = [];
  const promote = [];
  for (const e of entries) {
    if (!e) continue;
    if (Number.isFinite(e.retryCount) && e.retryCount >= threshold) {
      promote.push(e);
    } else {
      keep.push(e);
    }
  }
  return {
    keep: { version: SCHEMA_VERSION, entries: keep },
    promote,
  };
}

/**
 * Merge new manual review entries into the existing manual review queue,
 * keyed by rawSource (last-write-wins on duplicate keys). Used after
 * partitionForPromotion to persist the promoted entries.
 */
export function mergeManualReview(existing, addEntries) {
  const baseEntries = Array.isArray(existing && existing.entries) ? existing.entries : [];
  const map = new Map();
  for (const e of baseEntries) {
    if (e && typeof e.rawSource === 'string') map.set(e.rawSource, e);
  }
  for (const e of addEntries || []) {
    if (e && typeof e.rawSource === 'string') map.set(e.rawSource, e);
  }
  return { version: SCHEMA_VERSION, entries: Array.from(map.values()) };
}

// -----------------------------------------------------------------------------
// High-level orchestration (used by CLI + auto-ingest.sh)
// -----------------------------------------------------------------------------

/**
 * Record a failure for a rawSource. Loads the retry queue, upserts the entry,
 * promotes any entries that hit the retry threshold to the manual review
 * queue, and persists both. Returns a summary describing the result.
 */
export async function recordFailure({
  vaultPath,
  rawSource,
  errorType,
  stderr,
  now,
}) {
  const retryQueue = await readAutoIngestRetryQueue(vaultPath);
  const upserted = upsertEntry(retryQueue, { rawSource, errorType, stderr, now });
  const { keep, promote } = partitionForPromotion(upserted);
  if (promote.length > 0) {
    const existingManual = await readManualReviewQueue(vaultPath);
    const mergedManual = mergeManualReview(existingManual, promote);
    await writeManualReviewQueue(vaultPath, mergedManual);
  }
  await writeAutoIngestRetryQueue(vaultPath, keep);
  const recorded = upserted.entries.find((e) => e.rawSource === rawSource);
  return {
    status: promote.some((p) => p.rawSource === rawSource) ? 'promoted' : 'queued',
    errorType,
    retryCount: recorded ? recorded.retryCount : 0,
    promotedCount: promote.length,
  };
}

/**
 * Record a success for a rawSource. If the rawSource was previously in the
 * retry queue, remove it. Manual review queue is left untouched (a manual
 * review entry implies a human needs to inspect; cron should not silently
 * clear it on next-tick success).
 */
export async function recordSuccess({ vaultPath, rawSource }) {
  const retryQueue = await readAutoIngestRetryQueue(vaultPath);
  const before = retryQueue.entries.length;
  const next = removeEntry(retryQueue, rawSource);
  await writeAutoIngestRetryQueue(vaultPath, next);
  return { status: before === next.entries.length ? 'noop' : 'cleared' };
}

// -----------------------------------------------------------------------------
// CLI entry (LEARN#14 isEntry pattern — never fires during test import)
// -----------------------------------------------------------------------------

function isEntry() {
  return Boolean(
    process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) {
        // Defensive cap: refuse to buffer arbitrarily large stderr from a
        // misbehaving extract script. Anything beyond 64KB is truncated.
        data = data.slice(0, 64 * 1024);
      }
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main() {
  const mode = process.argv[2];
  const vaultPath = process.env.OBSIDIAN_VAULT;
  if (!vaultPath) {
    process.stderr.write('auto-ingest-retry: OBSIDIAN_VAULT not set\n');
    process.exit(0);
  }
  if (!existsSync(vaultPath)) {
    process.stderr.write(`auto-ingest-retry: OBSIDIAN_VAULT not found: ${vaultPath}\n`);
    process.exit(0);
  }
  try {
    if (mode === '--enqueue') {
      const rawSource = process.argv[3];
      const errorTypeArg = process.argv[4];
      if (!rawSource) {
        process.stderr.write('auto-ingest-retry: --enqueue requires <rawSource>\n');
        process.exit(0);
      }
      const stderrText = await readStdin();
      const errorType =
        errorTypeArg && errorTypeArg !== 'auto'
          ? errorTypeArg
          : classifyAutoIngestError(stderrText);
      const result = await recordFailure({
        vaultPath,
        rawSource,
        errorType,
        stderr: stderrText,
      });
      process.stdout.write(JSON.stringify(result) + '\n');
    } else if (mode === '--remove') {
      const rawSource = process.argv[3];
      if (!rawSource) {
        process.stderr.write('auto-ingest-retry: --remove requires <rawSource>\n');
        process.exit(0);
      }
      const result = await recordSuccess({ vaultPath, rawSource });
      process.stdout.write(JSON.stringify(result) + '\n');
    } else if (mode === '--read') {
      const retry = await readAutoIngestRetryQueue(vaultPath);
      const manual = await readManualReviewQueue(vaultPath);
      process.stdout.write(
        JSON.stringify({ retry, manualReview: manual }, null, 2) + '\n'
      );
    } else {
      process.stderr.write(
        'auto-ingest-retry: unknown mode (use --enqueue|--remove|--read)\n'
      );
    }
  } catch (e) {
    try {
      process.stderr.write(
        `auto-ingest-retry: unexpected error (${maskCredentials(String((e && e.message) || e))})\n`
      );
    } catch {
      /* suppress secondary failures */
    }
  }
}

if (isEntry()) {
  main();
}
