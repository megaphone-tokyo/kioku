// discoverqueries-learning.test.mjs — Sprint 5.5 PR A55 (axis B, N=32).
//
// Plan: tools/claude-brain/plan/claude/26051509_v0-10-sprint5-5-discoverqueries-learning-plan.md §「PR A55」
//
// F-number scope: per-file (NEW file = BLUE-DQ-LEARN-A55-1..5).
//
// Test 観点:
//   - BLUE-DQ-LEARN-A55-1: scanSessionLogs gracefully returns empty Map when
//                          session-logs/ is absent (no throw)
//   - BLUE-DQ-LEARN-A55-2: scanSessionLogs extracts #tag / [[wikilink]] /
//                          ATX heading from session-log markdown into Map
//   - BLUE-DQ-LEARN-A55-3: appendToUsageLog persists entries and FIFO-rotates
//                          when the serialized payload exceeds 64KB
//   - BLUE-DQ-LEARN-A55-4: discoverQueries 8th source integrates — session-log
//                          query weight (2.8) combines with static-source weight
//                          and influences TopN sort
//   - BLUE-DQ-LEARN-A55-5: regression guard — static 7 source behavior is
//                          unchanged when session-logs/ is absent (additive only)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEARNING_LIB = join(__dirname, '..', 'mcp', 'lib', 'discoverqueries-learning.mjs');
const QMD_INDEX_LIB = join(__dirname, '..', 'mcp', 'lib', 'qmd-search-index.mjs');

const {
  USAGE_LOG_FILENAME,
  USAGE_LOG_MAX_BYTES,
  OPT_OUT_FILENAME,
  isOptedOut,
  scanSessionLogs,
  appendToUsageLog,
  readUsageLog,
} = await import(LEARNING_LIB);

const { __test__: qmdTest } = await import(QMD_INDEX_LIB);

describe('discoverqueries-learning', () => {
  // ───────────────────────────────────────────────────────────────────────────
  // BLUE-DQ-LEARN-A55-1: graceful empty when session-logs/ absent
  // ───────────────────────────────────────────────────────────────────────────

  test('BLUE-DQ-LEARN-A55-1: scanSessionLogs returns empty Map when session-logs/ absent', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'kioku-dq-learn-a55-1-'));
    const vault = join(ws, 'vault');
    try {
      await mkdir(vault, { recursive: true });
      // No session-logs/ subdir — graceful skip expected
      const result = await scanSessionLogs(vault);
      assert.ok(result instanceof Map, 'must return a Map');
      assert.equal(result.size, 0, 'absent session-logs/ must yield empty Map');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // BLUE-DQ-LEARN-A55-2: extraction (#tag / [[wikilink]] / heading)
  // ───────────────────────────────────────────────────────────────────────────

  test('BLUE-DQ-LEARN-A55-2: scanSessionLogs extracts tags, wikilinks, headings', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'kioku-dq-learn-a55-2-'));
    const vault = join(ws, 'vault');
    try {
      const sessionLogsDir = join(vault, 'session-logs');
      await mkdir(sessionLogsDir, { recursive: true });
      await writeFile(
        join(sessionLogsDir, '20260515-100000-aaaa-test-prompt.md'),
        [
          '---',
          'type: session-log',
          'session_id: aaaa-1111',
          '---',
          '',
          '## User',
          '',
          '#hot-cache の design について [[visualizer]] を見直したい',
          '',
          '## Assistant',
          '',
          '# Hot Cache Design Review',
          '',
          'Discussion of [[doctor]] and #wiki-rotting concerns.',
          '',
          '## Implementation Notes',
          '',
          'See related #wiki-rotting tag.',
          '',
        ].join('\n'),
      );

      const usage = await scanSessionLogs(vault);
      assert.ok(usage instanceof Map);
      assert.ok(usage.size > 0, 'must extract at least one query');

      // Tags (lowercased)
      assert.ok(usage.has('hot-cache'), `expected #hot-cache, got: ${Array.from(usage.keys()).join(', ')}`);
      assert.equal(usage.get('wiki-rotting'), 2, '#wiki-rotting must appear twice');

      // Wikilinks (lowercased)
      assert.ok(usage.has('visualizer'), 'expected [[visualizer]]');
      assert.ok(usage.has('doctor'), 'expected [[doctor]]');

      // ATX headings (lowercased, length-filtered)
      assert.ok(
        usage.has('hot cache design review'),
        `expected h1 heading, got keys: ${Array.from(usage.keys()).join(', ')}`,
      );
      assert.ok(usage.has('implementation notes'), 'expected h2 heading');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // BLUE-DQ-LEARN-A55-3: appendToUsageLog + 64KB FIFO rotation
  // ───────────────────────────────────────────────────────────────────────────

  test('BLUE-DQ-LEARN-A55-3: appendToUsageLog persists + FIFO rotates at 64KB', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'kioku-dq-learn-a55-3-'));
    const vault = join(ws, 'vault');
    try {
      await mkdir(vault, { recursive: true });

      // First append — small payload, fits well under 64KB. Schema is per-query:
      // each map entry produces a `{query, count, firstSeen, lastSeen}` entry.
      const small = new Map([['hot-cache', 3], ['doctor', 2]]);
      await appendToUsageLog(vault, small);

      const usageLogPath = join(vault, USAGE_LOG_FILENAME);
      assert.ok(existsSync(usageLogPath), `usage log file must exist at ${usageLogPath}`);

      const after1 = await readUsageLog(vault);
      assert.ok(after1 && Array.isArray(after1.entries), 'usage log must parse');
      assert.equal(after1.entries.length, 2, 'first append produces 2 per-query entries (hot-cache + doctor)');
      assert.equal(after1.version, 1, 'schema version pinned');
      // entry shape
      const e0 = after1.entries.find((e) => e.query === 'hot-cache');
      assert.ok(e0, 'hot-cache entry must exist');
      assert.equal(e0.count, 3);
      assert.match(e0.firstSeen, /^\d{4}-\d{2}-\d{2}T/);
      assert.match(e0.lastSeen, /^\d{4}-\d{2}-\d{2}T/);

      // Second append — adds visualizer, total 3 per-query entries
      await new Promise((res) => setTimeout(res, 5));
      const small2 = new Map([['visualizer', 1]]);
      await appendToUsageLog(vault, small2);
      const after2 = await readUsageLog(vault);
      assert.equal(after2.entries.length, 3, 'second append → 3 unique queries (hot-cache + doctor + visualizer)');

      // Now force FIFO rotation: append many fresh entries, each touch updates
      // lastSeen so older "first batch" entries (hot-cache / doctor) become
      // candidates for drop. Inject 200 unique keys ~10KB each * multiple rounds.
      for (let round = 0; round < 10; round++) {
        const bigQueries = new Map();
        for (let i = 0; i < 200; i++) {
          bigQueries.set(`round${round}-query-with-a-fairly-long-key-name-${i}`, i + 1);
        }
        await new Promise((res) => setTimeout(res, 5));
        await appendToUsageLog(vault, bigQueries);
      }

      const afterRotate = await readUsageLog(vault);
      assert.ok(afterRotate && Array.isArray(afterRotate.entries));

      // Capacity invariant: serialized payload must be <= 64KB
      const onDisk = await readFile(usageLogPath, 'utf8');
      assert.ok(
        Buffer.byteLength(onDisk, 'utf8') <= USAGE_LOG_MAX_BYTES,
        `on-disk size ${Buffer.byteLength(onDisk, 'utf8')} must be <= 64KB (${USAGE_LOG_MAX_BYTES})`,
      );

      // FIFO evidence: oldest entries (the first `small` append: 'hot-cache'
      // and 'doctor') should have been dropped because they have the oldest
      // lastSeen timestamps. We verify by checking the per-query keys.
      const queryNames = afterRotate.entries.map((e) => e.query);
      assert.ok(
        !queryNames.includes('hot-cache'),
        `FIFO rotation must drop oldest entries; expected 'hot-cache' (oldest lastSeen) absent, got first 5: ${queryNames.slice(0, 5).join(', ')}`,
      );
      assert.ok(
        !queryNames.includes('doctor'),
        `FIFO rotation must drop oldest entries; expected 'doctor' (oldest lastSeen) absent`,
      );

      // At least one entry must remain (the "always keep latest" guarantee)
      assert.ok(afterRotate.entries.length >= 1, 'at least 1 entry must remain after rotation');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // BLUE-DQ-LEARN-A55-4: 8th source integrates into discoverQueries TopN
  // ───────────────────────────────────────────────────────────────────────────

  test('BLUE-DQ-LEARN-A55-4: discoverQueries 8th source promotes session-log queries', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'kioku-dq-learn-a55-4-'));
    const vault = join(ws, 'vault');
    try {
      // Static sources: minimal — only log.md with a low-count tag so that
      // session-log query (weight 2.8 * 3 occurrences = 8.4) can clearly
      // out-rank it.
      await mkdir(join(vault, 'wiki'), { recursive: true });
      await writeFile(
        join(vault, 'wiki', 'log.md'),
        '# Log\n\n- 2026-05-15 #static-tag mention\n',
      );

      // session-logs/: a single file mentioning a unique query 3 times.
      // It will be tagged + heading'd to bias source 8 weight.
      const sessionLogsDir = join(vault, 'session-logs');
      await mkdir(sessionLogsDir, { recursive: true });
      await writeFile(
        join(sessionLogsDir, '20260515-110000-bbbb-test.md'),
        [
          '## User',
          '',
          '#session-only-query is mentioned',
          '',
          '## Assistant',
          '',
          '# session-only-query Heading',
          '',
          'Talking about #session-only-query repeatedly.',
          '',
        ].join('\n'),
      );

      const queries = await qmdTest.discoverQueries(vault, 10);
      assert.ok(Array.isArray(queries));
      assert.ok(queries.length > 0, 'must produce queries');

      // 'session-only-query' should appear (proves 8th source integration).
      // It does NOT have to be #1 in absolute terms, only that it's present
      // and that 'static-tag' (weight 3 from log.md) is also there: we want
      // additive integration, not replacement.
      assert.ok(
        queries.includes('session-only-query'),
        `session-log derived query missing in TopN, got: ${queries.join(', ')}`,
      );
      assert.ok(
        queries.includes('static-tag'),
        `static log.md tag still must appear (additive contract), got: ${queries.join(', ')}`,
      );
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // BLUE-DQ-LEARN-A55-5: regression — static 7 source behavior unchanged
  // ───────────────────────────────────────────────────────────────────────────

  test('BLUE-DQ-LEARN-A55-5: discoverQueries unchanged for vaults with no session-logs/', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'kioku-dq-learn-a55-5-'));
    const vault = join(ws, 'vault');
    try {
      // Minimal static-only vault — replicate the BLUE-QMD-INDEX-3 fixture
      // shape (log.md with tag).
      await mkdir(join(vault, 'wiki'), { recursive: true });
      await writeFile(
        join(vault, 'wiki', 'log.md'),
        [
          '# Log',
          '',
          '- 2026-05-14 #regression-marker noted',
          '- 2026-05-13 #regression-marker again',
          '- 2026-05-12 #other-tag',
          '',
        ].join('\n'),
      );
      // No session-logs/ at all

      const queries = await qmdTest.discoverQueries(vault, 10);
      // Static behavior preserved: 'regression-marker' (count 2, weight 3 * 2 = 6)
      // outranks 'other-tag' (count 1, weight 3 * 1 = 3).
      assert.ok(Array.isArray(queries));
      assert.ok(queries.length >= 2, `expected >= 2 queries, got: ${queries.join(', ')}`);
      const idxMarker = queries.indexOf('regression-marker');
      const idxOther = queries.indexOf('other-tag');
      assert.ok(idxMarker >= 0, `regression-marker missing in: ${queries.join(', ')}`);
      assert.ok(idxOther >= 0, `other-tag missing in: ${queries.join(', ')}`);
      assert.ok(
        idxMarker < idxOther,
        `regression-marker (count 2) must rank above other-tag (count 1), got order: ${queries.join(', ')}`,
      );

      // Additionally: usage log file must NOT have been created (no
      // session-logs/ scanned → no persistence).
      const usageLogPath = join(vault, USAGE_LOG_FILENAME);
      assert.ok(
        !existsSync(usageLogPath),
        'usage log must not be created when session-logs/ absent',
      );
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Auxiliary: isOptedOut + readUsageLog defensive paths
  // ───────────────────────────────────────────────────────────────────────────

  test('isOptedOut returns false for absent opt-out file', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'kioku-dq-learn-aux-1-'));
    try {
      const result = await isOptedOut(ws);
      assert.equal(result, false);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test('isOptedOut returns true when opt-out file exists', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'kioku-dq-learn-aux-2-'));
    try {
      await writeFile(join(ws, OPT_OUT_FILENAME), '');
      const result = await isOptedOut(ws);
      assert.equal(result, true);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test('isOptedOut returns false for invalid vault argument', async () => {
    assert.equal(await isOptedOut(''), false);
    assert.equal(await isOptedOut(null), false);
    assert.equal(await isOptedOut(undefined), false);
  });

  test('readUsageLog returns canonical empty shape for absent file', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'kioku-dq-learn-aux-3-'));
    try {
      const result = await readUsageLog(ws);
      assert.ok(result && typeof result === 'object', 'must return object, not null');
      assert.equal(result.version, 1);
      assert.ok(Array.isArray(result.entries));
      assert.equal(result.entries.length, 0);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test('readUsageLog returns canonical empty shape for malformed JSON', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'kioku-dq-learn-aux-4-'));
    try {
      await writeFile(join(ws, USAGE_LOG_FILENAME), 'not valid json {{{');
      const result = await readUsageLog(ws);
      assert.ok(result && typeof result === 'object', 'must return object, not null');
      assert.equal(result.version, 1);
      assert.ok(Array.isArray(result.entries));
      assert.equal(result.entries.length, 0);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test('appendToUsageLog is no-op for empty Map', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'kioku-dq-learn-aux-5-'));
    try {
      await appendToUsageLog(ws, new Map());
      assert.ok(!existsSync(join(ws, USAGE_LOG_FILENAME)));
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test('scanSessionLogs returns Map only — caller is responsible for persistence', async () => {
    // Library-clean contract: scanSessionLogs returns Map<query,count>; the
    // caller (e.g., qmd-search-index.mjs Source 8) decides whether to call
    // appendToUsageLog. This separation enables read-only scans (e.g., doctor
    // diagnostics) without side effects on the usage log file.
    const ws = await mkdtemp(join(tmpdir(), 'kioku-dq-learn-aux-6-'));
    const vault = join(ws, 'vault');
    try {
      await mkdir(join(vault, 'session-logs'), { recursive: true });
      await writeFile(
        join(vault, 'session-logs', 'persist-test.md'),
        '## User\n\n#persist-tag mention\n',
      );
      const usage = await scanSessionLogs(vault);
      assert.ok(usage instanceof Map);
      assert.ok(usage.has('persist-tag'), 'scan must extract the tag');
      // scanSessionLogs alone does NOT auto-persist; appendToUsageLog is
      // the dedicated persistence entry-point.
      assert.ok(
        !existsSync(join(vault, USAGE_LOG_FILENAME)),
        'scanSessionLogs is read-only by contract; no persistence side-effect',
      );

      // Caller-driven persistence path: appendToUsageLog after scan
      await appendToUsageLog(vault, usage);
      assert.ok(existsSync(join(vault, USAGE_LOG_FILENAME)), 'appendToUsageLog persists');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

});

// ─── Direct test of extractFromContent via learning module __test__ ───
const { __test__ } = await import(LEARNING_LIB);

describe('discoverqueries-learning internal helpers', () => {
  test('pre-strip + extractQuerySignals strips frontmatter, fenced code, quote lines', () => {
    const { extractQuerySignals, stripFrontmatter, stripCodeBlocks, stripCalloutBlocks } = __test__;
    const content = [
      '---',
      'type: session-log',
      'session_id: zzzz',
      '---',
      '',
      '## Heading One',
      '',
      '#real-tag mentioned',
      '',
      '```bash',
      '#fake-tag-in-code',
      '[[fake-link-in-code]]',
      '# Fake Heading In Code',
      '```',
      '',
      '> #fake-tag-in-quote should be stripped',
      '> [[fake-link-in-quote]]',
      '',
      '[[real-link]]',
      '',
    ].join('\n');

    // mirror production pipeline: strip → extract
    const stripped = stripCalloutBlocks(stripCodeBlocks(stripFrontmatter(content)));
    const target = extractQuerySignals(stripped);

    // Real content should be picked up
    assert.ok(target.has('real-tag'), `expected real-tag, got: ${Array.from(target.keys()).join(', ')}`);
    assert.ok(target.has('real-link'), 'expected real-link');
    assert.ok(target.has('heading one'), 'expected heading-one');

    // Content stripped by filters MUST NOT appear
    assert.ok(!target.has('fake-tag-in-code'), 'fenced code block must be stripped');
    assert.ok(!target.has('fake-link-in-code'), 'fenced code block wikilink must be stripped');
    assert.ok(!target.has('fake heading in code'), 'fenced code block heading must be stripped');
    assert.ok(!target.has('fake-tag-in-quote'), 'quote line must be stripped');
    assert.ok(!target.has('fake-link-in-quote'), 'quote line wikilink must be stripped');
  });

  test('extractQuerySignals length-filters headings (2..80 chars)', () => {
    const { extractQuerySignals } = __test__;
    const content = [
      '# A',                                                    // length 1 — should be skipped
      `# ${'x'.repeat(81)}`,                                    // length 81 — should be skipped
      '# Valid Heading',                                        // valid
      '',
    ].join('\n');
    const target = extractQuerySignals(content);
    assert.ok(target.has('valid heading'));
    assert.ok(!target.has('a'));
    assert.ok(!target.has('x'.repeat(81)));
  });
});
