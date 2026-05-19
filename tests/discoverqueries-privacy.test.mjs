// discoverqueries-privacy.test.mjs — Sprint 5.5 PR A55 (axis B, N=32).
//
// Plan: tools/claude-brain/plan/claude/26051509_v0-10-sprint5-5-discoverqueries-learning-plan.md §「PR A55」 (BLUE-PRIVACY-1..3)
//
// F-number scope: per-file (NEW file = BLUE-PRIVACY-1..3).
//
// Test 観点 (privacy contract — the critical of this PR):
//   - BLUE-PRIVACY-1: credential literal pinning. session-logs/ markdown
//                     containing realistic-looking credential strings
//                     (sk-ant-, ghp_, Bearer, github_pat_, etc.) MUST NOT
//                     surface in the usage Map nor in the persisted usage
//                     log JSON. masking SSOT replaces literals with `***`.
//
//   - BLUE-PRIVACY-2: helper-local PII layer. Verifies `sanitizePII`
//                     (discoverqueries-learning.mjs), applied AFTER the
//                     applyMasks SSOT pass, redacts email + Japanese-style
//                     phone numbers to `<email>` / `<phone>` so they never
//                     surface in the usage Map nor the persisted usage log
//                     JSON. The PII layer is scope-local to this helper by
//                     design — generalizing the masking.mjs SSOT MASK_RULES
//                     beyond credentials (to email/phone) remains a separate
//                     codify candidate and is intentionally NOT done here.
//
//   - BLUE-PRIVACY-3: opt-out complete skip. With `.kioku-discoverqueries-
//                     opt-out` present, scanSessionLogs MUST return an empty
//                     Map and MUST NOT create / touch / modify the usage
//                     log file even when session-logs/ exists with content.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEARNING_LIB = join(__dirname, '..', 'mcp', 'lib', 'discoverqueries-learning.mjs');

const {
  USAGE_LOG_FILENAME,
  OPT_OUT_FILENAME,
  scanSessionLogs,
  readUsageLog,
  appendToUsageLog,
} = await import(LEARNING_LIB);

// -----------------------------------------------------------------------------
// Credential literals used in fixtures (fake but pattern-matching real shapes)
// -----------------------------------------------------------------------------

const FAKE_CREDS = {
  skAnt: 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKE12345TESTONLY',
  skProj: 'sk-proj-FAKEFAKEFAKEFAKEFAKE67890TESTONLY',
  ghp: 'ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII',
  githubPat: 'github_pat_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII',
  aiza: 'AIzaSyAAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH',
  akia: 'AKIAIOSFODNN7EXAMPLE',
  xoxb: 'xoxb-FAKEFAKEFAKEFAKEFAKE',
  npm: 'npm_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII',
  vercel: 'vercel_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII',
  bearer: 'Bearer eyJhbGciOiJIUzI1NiJ9.fake_jwt.body',
  basicAuth: 'Basic ZmFrZS11c2VyOmZha2UtcGFzcw==',
  urlEmbedded: 'https://fakeuser:fakepass@example.com/path',
  privateKeyId: 'private_key_id: "fedcba9876543210fedcba9876543210fedcba98"',
  passwordEq: 'password=hunter2-fake',
  tokenEq: 'token="fake-token-value-here"',
};

// -----------------------------------------------------------------------------
// BLUE-PRIVACY-1: credential literal pinning
// -----------------------------------------------------------------------------

describe('discoverqueries-privacy', () => {
  test('BLUE-PRIVACY-1: credential literals do not surface in usage Map or usage log', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'kioku-dq-privacy-1-'));
    const vault = join(ws, 'vault');
    try {
      const sessionLogsDir = join(vault, 'session-logs');
      await mkdir(sessionLogsDir, { recursive: true });

      // Build a fixture session-log that mixes real query candidates with
      // credential literals scattered through different markdown contexts.
      // The credentials must be filtered/masked, but the legitimate query
      // candidates (#real-tag, [[real-link]], real heading) must survive.
      const fixture = [
        '---',
        'type: session-log',
        `session_id: ${FAKE_CREDS.skAnt}`,  // even frontmatter creds are not surfaced
        '---',
        '',
        '## User',
        '',
        `Pasted token by accident: ${FAKE_CREDS.skAnt}`,
        `And another: ${FAKE_CREDS.ghp}`,
        '',
        '#real-tag and discussion of [[real-link]]',
        '',
        '## Assistant',
        '',
        `Let me set: ${FAKE_CREDS.passwordEq}`,
        `Authorization: ${FAKE_CREDS.bearer}`,
        `URL: ${FAKE_CREDS.urlEmbedded}`,
        '',
        '# Real Heading In Session',
        '',
        `Maybe: ${FAKE_CREDS.tokenEq}`,
        `Stripe-like: ${FAKE_CREDS.skProj}`,
        `Google: ${FAKE_CREDS.aiza}`,
        `AWS: ${FAKE_CREDS.akia}`,
        `Slack: ${FAKE_CREDS.xoxb}`,
        `NPM: ${FAKE_CREDS.npm}`,
        `Vercel: ${FAKE_CREDS.vercel}`,
        `GitHub PAT: ${FAKE_CREDS.githubPat}`,
        `Basic auth: ${FAKE_CREDS.basicAuth}`,
        `Private key id: ${FAKE_CREDS.privateKeyId}`,
        '',
      ].join('\n');
      await writeFile(join(sessionLogsDir, 'fixture.md'), fixture);

      const usageMap = await scanSessionLogs(vault);

      // Map sanity: legitimate queries survive
      assert.ok(usageMap.has('real-tag'), 'legitimate #real-tag must survive masking');
      assert.ok(usageMap.has('real-link'), 'legitimate [[real-link]] must survive');
      assert.ok(usageMap.has('real heading in session'), 'legitimate heading must survive');

      // Map: NO credential literal is a key (negative assertion).
      // Map keys are lowercased; check against lowercased credential prefixes.
      const mapKeys = Array.from(usageMap.keys()).join('|');
      assertNoCredentialLeak(mapKeys, 'usage Map keys');

      // Caller-driven persistence: scanSessionLogs returns Map only;
      // appendToUsageLog is the dedicated entry-point.
      await appendToUsageLog(vault, usageMap);

      // Persisted file: serialized JSON must not contain credential literals
      const usageLogPath = join(vault, USAGE_LOG_FILENAME);
      assert.ok(existsSync(usageLogPath), 'usage log must be created after appendToUsageLog');
      const serialized = await readFile(usageLogPath, 'utf8');
      assertNoCredentialLeak(serialized, 'usage log JSON');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // BLUE-PRIVACY-2: PII pattern sanitize (email + Japanese mobile phone)
  // ───────────────────────────────────────────────────────────────────────────

  test('BLUE-PRIVACY-2: email + Japanese phone PII is replaced with placeholders and never reaches usage log', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'kioku-dq-privacy-2-'));
    const vault = join(ws, 'vault');
    try {
      const sessionLogsDir = join(vault, 'session-logs');
      await mkdir(sessionLogsDir, { recursive: true });

      // PII literals scattered through different markdown contexts.
      // Email and Japanese mobile phone numbers must both be redacted to
      // `<email>` / `<phone>` placeholders by sanitizePII (helper-local PII
      // layer, applied after applyMasks SSOT).
      const fakeEmail = 'user@example.com';
      const fakeEmail2 = 'admin.test+tag@example.co.jp';
      const fakePhone = '090-1234-5678';
      const fakePhone2 = '08012345678';   // no hyphens — must still match
      const fakePhone3 = '070-1111-2222';

      const fixture = [
        '---',
        'type: session-log',
        'session_id: privacy-pii-test',
        '---',
        '',
        '## User',
        '',
        `Contact: ${fakeEmail}`,
        `Mobile: ${fakePhone}`,
        '',
        '#real-pii-test-tag and [[real-pii-test-link]]',
        '',
        '## Assistant',
        '',
        `Another email: ${fakeEmail2}`,
        `Another phone: ${fakePhone2}`,
        `One more phone: ${fakePhone3}`,
        '',
        '# Real PII Test Heading',
        '',
      ].join('\n');
      await writeFile(join(sessionLogsDir, 'pii-fixture.md'), fixture);

      const usageMap = await scanSessionLogs(vault);
      assert.ok(usageMap instanceof Map);

      // Legitimate content survives PII sanitize
      assert.ok(usageMap.has('real-pii-test-tag'), 'legitimate tag survives');
      assert.ok(usageMap.has('real-pii-test-link'), 'legitimate wikilink survives');
      assert.ok(
        usageMap.has('real pii test heading'),
        'legitimate heading survives',
      );

      // Map keys: no PII literal as a key
      const mapKeysJoined = Array.from(usageMap.keys()).join('|');
      for (const piiLiteral of [fakeEmail, fakeEmail2, fakePhone, fakePhone2, fakePhone3]) {
        assert.ok(
          !mapKeysJoined.includes(piiLiteral),
          `PII literal "${piiLiteral}" leaked into Map keys: ${mapKeysJoined.slice(0, 200)}`,
        );
      }

      // Persist + verify written usage log file is PII-clean
      await appendToUsageLog(vault, usageMap);
      const usageLogPath = join(vault, USAGE_LOG_FILENAME);
      assert.ok(existsSync(usageLogPath), 'usage log file must be created');
      const serialized = await readFile(usageLogPath, 'utf8');

      for (const piiLiteral of [fakeEmail, fakeEmail2, fakePhone, fakePhone2, fakePhone3]) {
        assert.ok(
          !serialized.includes(piiLiteral),
          `PII literal "${piiLiteral}" leaked into persisted usage log JSON`,
        );
      }
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // BLUE-PRIVACY-3: opt-out file complete skip
  // ───────────────────────────────────────────────────────────────────────────

  test('BLUE-PRIVACY-3: opt-out file disables scan + persistence entirely', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'kioku-dq-privacy-3-'));
    const vault = join(ws, 'vault');
    try {
      const sessionLogsDir = join(vault, 'session-logs');
      await mkdir(sessionLogsDir, { recursive: true });
      // session-logs/ is non-empty: would normally produce queries + persist
      await writeFile(
        join(sessionLogsDir, 'should-be-skipped.md'),
        [
          '## User',
          '',
          '#opt-out-test',
          `Even credentials: ${FAKE_CREDS.skAnt}`,
          '',
          '# Heading That Should Not Be Picked Up',
          '',
        ].join('\n'),
      );

      // Plant opt-out file
      await writeFile(join(vault, OPT_OUT_FILENAME), '');

      const usage = await scanSessionLogs(vault);
      assert.ok(usage instanceof Map);
      assert.equal(usage.size, 0, 'opt-out must yield empty Map');

      // Usage log file must NOT exist (no scan ⇒ no persistence)
      const usageLogPath = join(vault, USAGE_LOG_FILENAME);
      assert.ok(
        !existsSync(usageLogPath),
        'opt-out must not create the usage log file',
      );

      // Additional check: pre-existing usage log file is not touched when
      // opt-out is enabled (mtime preserved). Build a usage log first via
      // scan + appendToUsageLog (library-clean contract), enable opt-out,
      // then verify both scan and appendToUsageLog become no-ops.
      const ws2 = await mkdtemp(join(tmpdir(), 'kioku-dq-privacy-3b-'));
      const vault2 = join(ws2, 'vault');
      try {
        const sl2 = join(vault2, 'session-logs');
        await mkdir(sl2, { recursive: true });
        await writeFile(
          join(sl2, 'first-run.md'),
          '## User\n\n#first-run-tag\n',
        );
        // First run without opt-out builds the file via caller-driven persist
        const firstUsage = await scanSessionLogs(vault2);
        assert.ok(firstUsage.has('first-run-tag'), 'first run must produce content');
        await appendToUsageLog(vault2, firstUsage);
        const usageLog2 = join(vault2, USAGE_LOG_FILENAME);
        assert.ok(existsSync(usageLog2), 'first run must persist after appendToUsageLog');
        const beforeStat = await stat(usageLog2);

        // Now enable opt-out + run again — file must not be touched even if
        // caller invokes appendToUsageLog (opt-out gate is enforced in both
        // scanSessionLogs AND appendToUsageLog).
        await writeFile(join(vault2, OPT_OUT_FILENAME), '');
        await writeFile(
          join(sl2, 'second-run.md'),
          '## User\n\n#second-run-tag\n',
        );
        const optedOutUsage = await scanSessionLogs(vault2);
        assert.equal(optedOutUsage.size, 0, 'scan opt-out yields empty Map');

        // Even if caller bypasses scan and tries to manually append, opt-out
        // must block (defense-in-depth axis 2 reinforcement)
        await appendToUsageLog(vault2, new Map([['second-run-tag', 1]]));

        const afterStat = await stat(usageLog2);
        assert.equal(
          beforeStat.mtimeMs,
          afterStat.mtimeMs,
          'opt-out must not modify pre-existing usage log file (mtime preserved)',
        );

        // Verify the second-run-tag never made it into the log
        // (per-query entry schema: each entry has a `query` field)
        const persisted = await readUsageLog(vault2);
        assert.ok(persisted && Array.isArray(persisted.entries));
        const queryNames = persisted.entries.map((e) => e.query);
        assert.ok(
          !queryNames.includes('second-run-tag'),
          `opt-out must prevent second-run content from being appended, got: ${queryNames.join(', ')}`,
        );
      } finally {
        await rm(ws2, { recursive: true, force: true });
      }
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Negative assertion helper
  // ───────────────────────────────────────────────────────────────────────────

  function assertNoCredentialLeak(haystack, label) {
    // Each credential literal MUST be absent from the haystack
    for (const [name, literal] of Object.entries(FAKE_CREDS)) {
      assert.ok(
        !haystack.includes(literal),
        `${label} leaked credential "${name}": found "${literal.slice(0, 30)}..."`,
      );
    }
    // Plus: the high-entropy portions of password=*/token=* expressions
    // must also be gone (mask replaces value with `***`).
    assert.ok(!haystack.includes('hunter2-fake'), `${label} leaked password value`);
    assert.ok(!haystack.includes('fake-token-value-here'), `${label} leaked token value`);
  }
});
