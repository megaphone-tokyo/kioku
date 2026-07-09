// discoverqueries-learning.mjs — Sprint 5.5 PR A55: discoverQueries 8th source helper.
//
// Plan: tools/claude-brain/plan/claude/26051509_v0-10-sprint5-5-discoverqueries-learning-plan.md
// Handoff: tools/claude-brain/handoff/26051504_v0-10-sprint5-5-discoverqueries-learning-delegation.md
//
// Responsibility:
//   - Scan ${vault}/session-logs/*.md (top MAX_SCAN_FILES by mtime desc) and
//     extract user-typed query signals (tag refs / wikilinks / ATX h1-h3
//     headings) for use as Source 8 in qmd-search-index.mjs discoverQueries
//     (weight 2.8, highest among all 8 sources). Each candidate carries the
//     newest source-file mtime (`mtimeMs`) so the caller can apply recency
//     decay (v0.11 S6-7, axis F) — decay itself lives in qmd-search-index.mjs.
//   - Persist a usage log (`.kioku-discoverqueries-usage.json`) of accumulated
//     query → count entries with FIFO rotation at 64KB cap.
//
// Privacy contract (3 axis):
//   1. masking SSOT: applyMasks() from ./masking.mjs sanitizes credentials
//      AFTER pre-strip steps so any literal that survived stripping is redacted.
//   2. opt-out: ${vault}/.kioku-discoverqueries-opt-out file existence →
//      scanSessionLogs returns empty Map; appendToUsageLog is a no-op (zero
//      dynamic learning footprint on disk).
//   3. 64KB FIFO rotate: usage log JSON ≤ 64KB; oldest entries (by lastSeen
//      ASC) dropped one at a time until under cap.
//
// Local PII layer (scope-local, not in masking SSOT):
//   - Email pattern → <email>
//   - Japanese mobile phone (070/080/090, 4-4 digit pattern) → <phone>
//
// Atomic write contract (mirrors hooks/auto-ingest-retry.mjs writeQueueFile):
//   - mkdtemp + writeFile + rename so concurrent readers never observe partial JSON.
//   - Defensive read returns canonical empty `{ version, entries: [] }` on
//     missing / malformed JSON (mirrors readAutoIngestRetryQueue).
//
// Path C+β boundary: no eval / new Function / fetch family / setTimeout with
// string arg. Only node:fs/promises + node:path + masking SSOT.
//
// Library-only (no CLI entry / no isEntry block) — called from
// qmd-search-index.mjs discoverQueries Source 8.

import { existsSync } from 'node:fs';
import {
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { applyMasks } from './masking.mjs';

// -----------------------------------------------------------------------------
// Public constants (privacy contract knobs + schema)
// -----------------------------------------------------------------------------

export const USAGE_LOG_FILENAME = '.kioku-discoverqueries-usage.json';
export const USAGE_LOG_MAX_BYTES = 64 * 1024; // 64KB capacity bound
export const OPT_OUT_FILENAME = '.kioku-discoverqueries-opt-out';
export const SCHEMA_VERSION = 1;

// -----------------------------------------------------------------------------
// Internal constants (mirrors qmd-search-index.mjs budgets)
// -----------------------------------------------------------------------------

// session-logs/ scan cap: recency-biased, mirrors MAX_SCAN_FILES = 30 in
// qmd-search-index.mjs (Source 3 / wiki dir scan).
const MAX_SCAN_FILES = 30;

// Per-file byte budget: large session-logs (long Claude turns) capped at 256KB
// head-only read to bound CPU/memory.
const MAX_SESSION_LOG_BYTES_PER_FILE = 256 * 1024;

// Heading length filter (mirrors qmd-search-index.mjs Source 3).
const MIN_HEADING_LEN = 2;
const MAX_HEADING_LEN = 80;

// -----------------------------------------------------------------------------
// Regex (ASCII only — LEARN#13 invisible unicode prohibition satisfied)
//
// TAG_RE / WIKILINK_RE / HEADING_RE MUST mirror qmd-search-index.mjs so the
// Source 8 query keys align with Source 1-7 keys (Map dedupe works correctly).
// -----------------------------------------------------------------------------

const TAG_RE = /(?:^|[^\w])#([a-z][a-z0-9-]{1,30})/gi;
const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g;
const HEADING_RE = /^#{1,3}\s+(.+?)\s*$/gm;

// Frontmatter: opening `---\n` ... closing `\n---\n` at file head only.
// Trailing `\n?` accommodates files where frontmatter is the only content.
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;

// Fenced code block: both ``` ... ``` and ~~~ ... ~~~ styles.
// Non-greedy so consecutive blocks are stripped independently. Each fence's
// opener (with optional language tag) and closer are captured by the pattern.
const FENCED_CODE_RE = /(?:^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\1[ \t]*(?=\n|$)/g;

// Obsidian callout block: contiguous run of lines starting with `>` (with
// optional leading whitespace). Strips both `> [!type]` Obsidian callouts and
// plain `>` blockquotes (typically copied terminal output / tool stdout that
// should not feed query signals).
const CALLOUT_BLOCK_RE = /(?:^|\n)((?:[ \t]*>[^\n]*\n?)+)/g;

// Local PII regex.
//
// Email: simplified ASCII-only RFC-5322 friendly. Avoids catastrophic regex
// backtracking by being non-recursive.
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// Japanese mobile phone: leading 070 / 080 / 090, then 4 digits, then 4 digits,
// with optional hyphens between groups. `\b` boundaries reduce false positives.
const JP_PHONE_RE = /\b0[789]0-?\d{4}-?\d{4}\b/g;

// -----------------------------------------------------------------------------
// Pre-strip helpers (exposed for unit tests via __test__)
// -----------------------------------------------------------------------------

/**
 * Strip the leading YAML frontmatter block (between the first `---\n` and the
 * matching `\n---\n`). Content after the frontmatter is returned verbatim.
 * If no frontmatter is detected, input is returned unchanged.
 */
function stripFrontmatter(text) {
  if (typeof text !== 'string') return '';
  return text.replace(FRONTMATTER_RE, '');
}

/**
 * Strip fenced code blocks (``` ... ``` and ~~~ ... ~~~). Fences and their body
 * content are both removed. Inline code (`` `x` ``) is NOT stripped — inline
 * tokens can legitimately be tag refs or wikilinks worth indexing.
 */
function stripCodeBlocks(text) {
  if (typeof text !== 'string') return '';
  return text.replace(FENCED_CODE_RE, '\n');
}

/**
 * Strip Obsidian callout blocks AND plain blockquotes (any contiguous run of
 * `> ...` lines). Both `> [!type]` Obsidian-style callouts and standalone `>`
 * quotes are removed — the latter typically contain copied terminal stdout
 * that should not feed query signals.
 */
function stripCalloutBlocks(text) {
  if (typeof text !== 'string') return '';
  return text.replace(CALLOUT_BLOCK_RE, '\n');
}

/**
 * Apply local PII redaction (email + Japanese mobile phone) AFTER masking SSOT.
 * Matches are replaced with `<email>` / `<phone>` placeholders so downstream
 * query extraction cannot derive PII strings as query keys.
 */
function sanitizePII(text) {
  if (typeof text !== 'string') return '';
  return text.replace(EMAIL_RE, '<email>').replace(JP_PHONE_RE, '<phone>');
}

/**
 * Extract query signals from sanitized content. Returns Map<string, number>
 * keyed by lowercased query candidate with occurrence count as value.
 *
 * Signals:
 *   - Tag refs:     #word-with-hyphen (TAG_RE)
 *   - Wikilinks:    [[name]] / [[name|alias]] (WIKILINK_RE)
 *   - ATX headings: # / ## / ### (HEADING_RE), length-filtered 2..80
 *
 * All keys lowercased + length-filtered to mirror qmd-search-index.mjs
 * Source 1-7 contract.
 */
function extractQuerySignals(content) {
  const out = new Map();
  if (typeof content !== 'string' || content.length === 0) return out;

  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(content)) !== null) {
    const tag = m[1].toLowerCase();
    if (tag.length < MIN_HEADING_LEN || tag.length > MAX_HEADING_LEN) continue;
    out.set(tag, (out.get(tag) ?? 0) + 1);
  }

  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(content)) !== null) {
    const name = m[1].trim().toLowerCase();
    // Intentional hardening (stricter than qmd-search-index.mjs Source 2,
    // which accepts any non-empty wikilink): session-logs are user-generated
    // and noisier than wiki/index.md, and Source 8 carries the highest weight
    // (2.8). Applying the same 2..80 length filter as headings suppresses
    // 1-char / >80-char wikilink noise from being amplified into TopN.
    if (!name || name.length < MIN_HEADING_LEN || name.length > MAX_HEADING_LEN) continue;
    out.set(name, (out.get(name) ?? 0) + 1);
  }

  HEADING_RE.lastIndex = 0;
  while ((m = HEADING_RE.exec(content)) !== null) {
    const heading = m[1].trim().toLowerCase();
    if (heading.length < MIN_HEADING_LEN || heading.length > MAX_HEADING_LEN) continue;
    out.set(heading, (out.get(heading) ?? 0) + 1);
  }

  return out;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Compute the usage log path for a given vault.
 */
export function usageLogPathFor(vault) {
  return join(vault, USAGE_LOG_FILENAME);
}

/**
 * Compute the opt-out marker path for a given vault.
 */
export function optOutPathFor(vault) {
  return join(vault, OPT_OUT_FILENAME);
}

/**
 * True iff `${vault}/.kioku-discoverqueries-opt-out` exists. This is the
 * privacy hard gate — when true, `scanSessionLogs` returns an empty Map and
 * `appendToUsageLog` is a no-op (no file is created or modified).
 *
 * @param {string} vault
 * @returns {Promise<boolean>}
 */
export async function isOptedOut(vault) {
  if (typeof vault !== 'string' || vault.length === 0) return false;
  return existsSync(optOutPathFor(vault));
}

/**
 * Scan `${vault}/session-logs/*.md` (top MAX_SCAN_FILES by mtime descending),
 * apply pre-strip + masking + PII sanitize, then extract query signals.
 * Returns Map<string, { count, mtimeMs }> of query → aggregate count across
 * scanned files + newest source-file mtime (ms epoch) among the files the
 * query was seen in. `mtimeMs` is the recency anchor for the caller-side
 * exponential decay (qmd-search-index.mjs Source 8, v0.11 S6-7 axis F) —
 * it is a scan-time ranking signal only and is never persisted.
 *
 * Privacy contract:
 *   1. opt-out hard gate (early return empty Map)
 *   2. pre-strip: frontmatter → code blocks → callout blocks
 *   3. applyMasks (credential SSOT redaction)
 *   4. sanitizePII (email / 日本式 phone)
 *
 * Graceful skip cases (return empty Map, no throw):
 *   - opted out
 *   - session-logs/ does not exist or is unreadable
 *
 * @param {string} vault
 * @param {object} [options] - reserved for future scan options (currently ignored); scan is always pure/read-only
 * @returns {Promise<Map<string, { count: number, mtimeMs: number }>>}
 */
export async function scanSessionLogs(vault, options = {}) {
  void options; // reserved
  const out = new Map();
  if (typeof vault !== 'string' || vault.length === 0) return out;
  if (await isOptedOut(vault)) return out;

  const sessionLogsDir = join(vault, 'session-logs');
  let dirents;
  try {
    dirents = await readdir(sessionLogsDir, { withFileTypes: true });
  } catch {
    return out; // session-logs/ absent or unreadable — graceful skip
  }

  // Collect (path, mtimeMs) for .md entries so we can sort by recency (newest first).
  const candidates = [];
  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith('.md')) continue;
    const full = join(sessionLogsDir, dirent.name);
    try {
      const s = await stat(full);
      candidates.push({ path: full, mtimeMs: s.mtimeMs || 0 });
    } catch {
      // file disappeared between readdir + stat — skip
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const selected = candidates.slice(0, MAX_SCAN_FILES);

  for (const c of selected) {
    let raw;
    try {
      raw = await readFile(c.path, 'utf8');
    } catch {
      continue; // tolerate per-file read failures
    }
    if (typeof raw !== 'string' || raw.length === 0) continue;
    // Head-only read for DoS surface bound on pathological huge files.
    if (raw.length > MAX_SESSION_LOG_BYTES_PER_FILE) {
      raw = raw.slice(0, MAX_SESSION_LOG_BYTES_PER_FILE);
    }
    // Pre-strip → mask → PII sanitize → extract.
    const stripped = stripCalloutBlocks(stripCodeBlocks(stripFrontmatter(raw)));
    const masked = applyMasks(stripped);
    const sanitized = sanitizePII(masked);
    const signals = extractQuerySignals(sanitized);
    for (const [k, v] of signals.entries()) {
      const prev = out.get(k);
      if (prev) {
        prev.count += v;
        // Keep the NEWEST mtime across source files (recency anchor).
        // `selected` is already mtime-desc, but max() keeps this robust
        // against future ordering changes.
        if (c.mtimeMs > prev.mtimeMs) prev.mtimeMs = c.mtimeMs;
      } else {
        out.set(k, { count: v, mtimeMs: c.mtimeMs });
      }
    }
  }

  return out;
}

/**
 * Read the usage log. Returns canonical empty shape on missing / malformed JSON
 * (defensive: a corrupt log must not block precompute). Mirrors the contract
 * of `readAutoIngestRetryQueue` in hooks/auto-ingest-retry.mjs.
 *
 * Entry shape: `{ query: string, count: number, firstSeen: ISO, lastSeen: ISO }`
 *
 * @param {string} vault
 * @returns {Promise<{ version: number, entries: Array<{query: string, count: number, firstSeen: string, lastSeen: string}> }>}
 */
export async function readUsageLog(vault) {
  const empty = { version: SCHEMA_VERSION, entries: [] };
  if (typeof vault !== 'string' || vault.length === 0) return empty;
  const filePath = usageLogPathFor(vault);
  if (!existsSync(filePath)) return empty;
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return empty;
    if (!Array.isArray(parsed.entries)) return empty;
    return {
      version: Number.isFinite(parsed.version) ? parsed.version : SCHEMA_VERSION,
      entries: parsed.entries.filter(
        (e) =>
          e &&
          typeof e === 'object' &&
          typeof e.query === 'string' &&
          Number.isFinite(e.count)
      ),
    };
  } catch {
    return empty;
  }
}

/**
 * Append incoming queries to the usage log. Map values may be plain finite
 * numbers (legacy Map<string, number>) OR `{ count }` objects as returned by
 * `scanSessionLogs` (v0.11 S6-7 shape) — only the count increment is
 * persisted; `mtimeMs` is a scan-time ranking signal and is intentionally NOT
 * written (usage log JSON schema + 64KB FIFO contract unchanged). Existing
 * entries have their `count` incremented and `lastSeen` updated; new entries
 * are created with `firstSeen = lastSeen = now`. The serialized result is
 * checked against USAGE_LOG_MAX_BYTES; oldest entries (by `lastSeen` ASC) are
 * dropped one at a time until under cap. Written atomically (mkdtemp + rename)
 * so concurrent readers never observe partial JSON.
 *
 * Opt-out: if `.kioku-discoverqueries-opt-out` exists, this is a no-op (the
 * usage log file is neither created nor modified).
 *
 * @param {string} vault
 * @param {Map<string, number | { count: number, mtimeMs?: number }>} queries
 * @returns {Promise<void>}
 */
export async function appendToUsageLog(vault, queries) {
  if (typeof vault !== 'string' || vault.length === 0) return;
  if (!queries || typeof queries.entries !== 'function') return;
  if (await isOptedOut(vault)) return;

  // Empty input → nothing to write.
  let hasInput = false;
  for (const _ of queries.entries()) {
    void _;
    hasInput = true;
    break;
  }
  if (!hasInput) return;

  const filePath = usageLogPathFor(vault);
  const existing = await readUsageLog(vault);

  // Index existing entries by query for O(1) merge.
  const idx = new Map();
  for (const e of existing.entries) {
    if (e && typeof e.query === 'string') {
      idx.set(e.query, {
        query: e.query,
        count: Number.isFinite(e.count) ? e.count : 0,
        firstSeen: typeof e.firstSeen === 'string' ? e.firstSeen : '',
        lastSeen: typeof e.lastSeen === 'string' ? e.lastSeen : '',
      });
    }
  }

  const now = new Date().toISOString();
  for (const [query, incRaw] of queries.entries()) {
    if (typeof query !== 'string' || query.length === 0) continue;
    // Normalize: accept plain finite numbers (legacy shape) and
    // { count, mtimeMs } objects (scanSessionLogs v0.11 S6-7 shape) so the
    // documented scan → append chain keeps working across the shape change.
    const inc =
      typeof incRaw === 'number'
        ? incRaw
        : incRaw && typeof incRaw === 'object' && Number.isFinite(incRaw.count)
          ? incRaw.count
          : NaN;
    if (!Number.isFinite(inc) || inc <= 0) continue;
    const prev = idx.get(query);
    if (prev) {
      prev.count = (Number.isFinite(prev.count) ? prev.count : 0) + inc;
      prev.lastSeen = now;
      if (!prev.firstSeen) prev.firstSeen = now;
    } else {
      idx.set(query, { query, count: inc, firstSeen: now, lastSeen: now });
    }
  }

  // FIFO rotation: drop oldest entry (smallest lastSeen) one at a time until
  // serialized payload fits the 64KB budget. Sort by lastSeen ASC ONCE up
  // front — shift() preserves the sorted order so re-sorting inside the loop
  // is unnecessary (avoids O(n² log n)).
  let entries = Array.from(idx.values());
  entries.sort((a, b) => {
    const al = typeof a.lastSeen === 'string' ? a.lastSeen : '';
    const bl = typeof b.lastSeen === 'string' ? b.lastSeen : '';
    return al < bl ? -1 : al > bl ? 1 : 0;
  });
  let payload = JSON.stringify({ version: SCHEMA_VERSION, entries }, null, 2) + '\n';
  while (Buffer.byteLength(payload, 'utf8') > USAGE_LOG_MAX_BYTES && entries.length > 0) {
    entries.shift();
    payload = JSON.stringify({ version: SCHEMA_VERSION, entries }, null, 2) + '\n';
  }

  // Atomic write: tmp file in parent dir + rename. Mirrors writeQueueFile
  // contract in hooks/auto-ingest-retry.mjs.
  const parent = dirname(filePath);
  const tmpDir = await mkdtemp(join(parent, '.kioku-dq-usage-tmp-'));
  const tmpFile = join(tmpDir, 'usage.json');
  try {
    await writeFile(tmpFile, payload, 'utf8');
    await rename(tmpFile, filePath);
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

// -----------------------------------------------------------------------------
// Internal helpers exposed for unit tests only.
// Production callers must use the named exports above.
// -----------------------------------------------------------------------------

export const __test__ = Object.freeze({
  stripFrontmatter,
  stripCodeBlocks,
  stripCalloutBlocks,
  sanitizePII,
  extractQuerySignals,
  MAX_SCAN_FILES,
  TAG_RE,
  WIKILINK_RE,
  HEADING_RE,
  EMAIL_RE,
  JP_PHONE_RE,
});
