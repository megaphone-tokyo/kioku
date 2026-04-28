// tests/hooks/session-logger-core.test.mjs — v0.7.0 Q2 core unit + security tests
//
// Targets: hooks/session-logger-core.mjs
// Test prefixes:
//   - CORE-*                   : 基本 unit (NormalizedEvent → OutputIntent)
//   - BLUE-CORE-VAL-1..8       : adapter bypass 想定の fabricated event reject (MF4)
//   - BLUE-CORE-CONCURRENT-1   : index.lock で並列 write が整合 (SF1)
//   - BLUE-CORE-STDIN-CAP-1    : readStdin 17 MiB で null 返却 (M1 / SF5)
//   - BLUE-CORE-YAML-INJ-1     : yamlSafeValue が `\n---` boundary 偽装不可 (M3)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  AGENT_NAMES,
  EVENT_NAMES,
  MAX_STDIN_BYTES,
  buildContext,
  buildFrontmatter,
  ingestNormalizedEvent,
  readStdin,
  validateNormalizedEvent,
  yamlSafeValue,
  CoreValidationError,
} from '../../hooks/session-logger-core.mjs';

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

async function createCtx() {
  const root = await mkdtemp(join(tmpdir(), 'kioku-core-test-'));
  const sessionLogsDir = join(root, 'session-logs');
  const internalDir = join(sessionLogsDir, '.claude-brain');
  await mkdir(internalDir, { recursive: true, mode: 0o700 });
  return {
    root,
    ctx: {
      vault: root,
      sessionLogsDir,
      internalDir,
      indexPath: join(internalDir, 'index.json'),
    },
  };
}

function makeNormEv(overrides = {}) {
  return {
    sessionId: 'test-core-0001',
    eventName: 'user_prompt',
    agent: 'claude',
    timestamp: new Date('2026-04-24T10:00:00.000Z'),
    userPrompt: { text: 'Hello, core.' },
    cwd: '/tmp',
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// CORE-1..N: 基本 unit
// -----------------------------------------------------------------------------

describe('session-logger-core: CORE-basic', () => {
  test('CORE-1: EVENT_NAMES / AGENT_NAMES closed enum', () => {
    assert.equal(EVENT_NAMES.size, 6);
    assert.equal(AGENT_NAMES.size, 3);
    assert.ok(EVENT_NAMES.has('user_prompt'));
    assert.ok(EVENT_NAMES.has('assistant_stop'));
    assert.ok(EVENT_NAMES.has('tool_use'));
    assert.ok(EVENT_NAMES.has('session_start'));
    assert.ok(EVENT_NAMES.has('session_end'));
    assert.ok(EVENT_NAMES.has('post_compact'));
    assert.ok(AGENT_NAMES.has('claude'));
    assert.ok(AGENT_NAMES.has('gemini'));
    assert.ok(AGENT_NAMES.has('codex'));
  });

  test('CORE-2: yamlSafeValue basic passthrough', () => {
    assert.equal(yamlSafeValue('hello'), 'hello');
    assert.equal(yamlSafeValue(null), '');
    assert.equal(yamlSafeValue(undefined), '');
  });

  test('CORE-3: yamlSafeValue quotes colon-bearing strings', () => {
    assert.equal(yamlSafeValue('foo: bar'), "'foo: bar'");
    assert.equal(yamlSafeValue("it's"), "'it''s'");
  });

  test('CORE-4: ingestNormalizedEvent happy path creates session file', async () => {
    const { root, ctx } = await createCtx();
    try {
      const intent = await ingestNormalizedEvent(makeNormEv(), ctx);
      assert.deepEqual(intent, { type: 'none' });

      const files = (await readdir(ctx.sessionLogsDir)).filter((f) => f.endsWith('.md'));
      assert.equal(files.length, 1);
      const content = await readFile(join(ctx.sessionLogsDir, files[0]), 'utf8');
      assert.match(content, /type: session-log/);
      assert.match(content, /session_id: test-core-0001/);
      assert.match(content, /## User /);
      assert.match(content, /Hello, core\./);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// BLUE-CORE-VAL-1..8: adapter bypass reject (MF4)
// -----------------------------------------------------------------------------

describe('session-logger-core: BLUE-CORE-VAL adapter bypass rejection', () => {
  test('BLUE-CORE-VAL-1: non-object normEv rejected', () => {
    assert.throws(() => validateNormalizedEvent(null), /BLUE-CORE-VAL-1/);
    assert.throws(() => validateNormalizedEvent(undefined), /BLUE-CORE-VAL-1/);
    assert.throws(() => validateNormalizedEvent('str'), /BLUE-CORE-VAL-1/);
  });

  test('BLUE-CORE-VAL-2: sessionId empty / non-ASCII rejected', () => {
    assert.throws(() => validateNormalizedEvent(makeNormEv({ sessionId: '' })), /BLUE-CORE-VAL-2/);
    assert.throws(() => validateNormalizedEvent(makeNormEv({ sessionId: 'abc/def' })), /BLUE-CORE-VAL-2/);
    assert.throws(() => validateNormalizedEvent(makeNormEv({ sessionId: 'abc..def' })), /BLUE-CORE-VAL-2/);
    assert.throws(() => validateNormalizedEvent(makeNormEv({ sessionId: 'abc\n---' })), /BLUE-CORE-VAL-2/);
    assert.throws(() => validateNormalizedEvent(makeNormEv({ sessionId: 'セッション' })), /BLUE-CORE-VAL-2/);
  });

  test('BLUE-CORE-VAL-3: sessionId over 256 chars rejected', () => {
    const longId = 'a'.repeat(257);
    assert.throws(() => validateNormalizedEvent(makeNormEv({ sessionId: longId })), /BLUE-CORE-VAL-3/);
  });

  test('BLUE-CORE-VAL-4: unknown eventName rejected', () => {
    assert.throws(() => validateNormalizedEvent(makeNormEv({ eventName: 'DROP_TABLE' })), /BLUE-CORE-VAL-4/);
    assert.throws(() => validateNormalizedEvent(makeNormEv({ eventName: 'UserPromptSubmit' })), /BLUE-CORE-VAL-4/);
  });

  test('BLUE-CORE-VAL-5: unknown agent rejected', () => {
    assert.throws(() => validateNormalizedEvent(makeNormEv({ agent: 'openai' })), /BLUE-CORE-VAL-5/);
    assert.throws(() => validateNormalizedEvent(makeNormEv({ agent: '' })), /BLUE-CORE-VAL-5/);
  });

  test('BLUE-CORE-VAL-6: timestamp must be a valid Date', () => {
    assert.throws(() => validateNormalizedEvent(makeNormEv({ timestamp: 'now' })), /BLUE-CORE-VAL-6/);
    assert.throws(() => validateNormalizedEvent(makeNormEv({ timestamp: Date.now() })), /BLUE-CORE-VAL-6/);
    assert.throws(() => validateNormalizedEvent(makeNormEv({ timestamp: new Date('invalid') })), /BLUE-CORE-VAL-6/);
  });

  test('BLUE-CORE-VAL-7: userPrompt.text non-string rejected', () => {
    assert.throws(() => validateNormalizedEvent(makeNormEv({ userPrompt: {} })), /BLUE-CORE-VAL-7/);
    assert.throws(() => validateNormalizedEvent(makeNormEv({ userPrompt: { text: 123 } })), /BLUE-CORE-VAL-7/);
    assert.throws(() => validateNormalizedEvent(makeNormEv({ userPrompt: null })), /BLUE-CORE-VAL-7/);
  });

  test('BLUE-CORE-VAL-8: toolUse.name empty / cwd non-string rejected', () => {
    assert.throws(
      () => validateNormalizedEvent(makeNormEv({ eventName: 'tool_use', userPrompt: undefined, toolUse: { name: '' } })),
      /BLUE-CORE-VAL-8/,
    );
    assert.throws(
      () => validateNormalizedEvent(makeNormEv({ eventName: 'tool_use', userPrompt: undefined, toolUse: null })),
      /BLUE-CORE-VAL-8/,
    );
    assert.throws(() => validateNormalizedEvent(makeNormEv({ cwd: 42 })), /BLUE-CORE-VAL-8/);
  });

  test('BLUE-CORE-VAL: valid happy path does not throw', () => {
    // sanity
    validateNormalizedEvent(makeNormEv());
    validateNormalizedEvent(makeNormEv({ eventName: 'session_start', userPrompt: undefined }));
    validateNormalizedEvent(
      makeNormEv({
        eventName: 'tool_use',
        userPrompt: undefined,
        toolUse: { name: 'Bash', input: { command: 'echo hi' } },
      }),
    );
  });

  test('BLUE-CORE-VAL: ingestNormalizedEvent throws CoreValidationError on fabricated event', async () => {
    const { root, ctx } = await createCtx();
    try {
      await assert.rejects(
        () => ingestNormalizedEvent({ sessionId: '', eventName: 'hack', agent: 'mallory' }, ctx),
        (err) => err instanceof CoreValidationError,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// BLUE-CORE-YAML-INJ-1 (M3): frontmatter boundary 偽装不可
// -----------------------------------------------------------------------------

describe('session-logger-core: BLUE-CORE-YAML-INJ frontmatter safety', () => {
  test('BLUE-CORE-YAML-INJ-1: buildFrontmatter quotes sessionId with newline+---', () => {
    // sessionId validator が止めるはずだが buildFrontmatter 自体も defense-in-depth
    const normEv = makeNormEv({ sessionId: 'sid\n---\ninjected: true' });
    const fm = buildFrontmatter(normEv, {
      iso: '2026-04-24T10:00:00+09:00',
      compactDate: '20260424',
      compactTime: '100000',
      clock: '10:00:00',
    });
    // Expected: sessionId is single-quoted, newline eliminated (yamlSafeValue strips \n)
    // The result MUST NOT contain a new frontmatter delimiter mid-block
    const beforeClosingDelim = fm.slice(0, fm.indexOf('\n---\n'));
    assert.ok(!beforeClosingDelim.includes('\n---'));
    // Ensure the malicious sessionId is neutralized (quoted scalar)
    assert.match(fm, /session_id: '.*injected.*'/);
  });

  test('BLUE-CORE-YAML-INJ-1: buildFrontmatter neutralizes cwd with --- injection', () => {
    const normEv = makeNormEv({ cwd: '/tmp\n---\nhostname: attacker' });
    const fm = buildFrontmatter(normEv, {
      iso: '2026-04-24T10:00:00+09:00',
      compactDate: '20260424',
      compactTime: '100000',
      clock: '10:00:00',
    });
    // Legitimate frontmatter has exactly 1 occurrence of `\n---\n` (the closing fence).
    // Any injection attempt via cwd would appear as an additional occurrence.
    const delimCount = fm.split('\n---\n').length - 1;
    assert.equal(delimCount, 1, 'exactly one closing delim (no extra injected ---)');
    // cwd is quoted as single-quoted scalar; the malicious content is flattened (newlines stripped)
    assert.match(fm, /cwd: '[^\n]*attacker[^\n]*'/);
    // The trailing `---\n` should still exist at the end as the closing fence
    assert.match(fm, /---\n$/);
  });
});

// -----------------------------------------------------------------------------
// BLUE-CORE-STDIN-CAP-1 (M1 / SF5): readStdin 16 MiB cap
// -----------------------------------------------------------------------------

describe('session-logger-core: BLUE-CORE-STDIN-CAP readStdin overflow', () => {
  test('BLUE-CORE-STDIN-CAP-1: 17 MiB stdin returns null (early return)', async () => {
    // redirect process.stdin to a mock stream
    const origStdin = process.stdin;
    const mock = Readable.from((async function* () {
      const chunk = Buffer.alloc(1024 * 1024, 0x7a); // 1 MiB of 'z'
      for (let i = 0; i < 17; i++) yield chunk; // total 17 MiB > 16 MiB cap
    })());
    // Force isTTY to false so readStdin proceeds
    mock.isTTY = false;
    Object.defineProperty(process, 'stdin', { value: mock, configurable: true });
    try {
      const result = await readStdin(MAX_STDIN_BYTES);
      assert.equal(result, null);
    } finally {
      Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true });
    }
  });

  test('BLUE-CORE-STDIN-CAP: small stdin returns content string', async () => {
    const origStdin = process.stdin;
    const mock = Readable.from([Buffer.from('{"hello":"world"}')]);
    mock.isTTY = false;
    Object.defineProperty(process, 'stdin', { value: mock, configurable: true });
    try {
      const result = await readStdin();
      assert.equal(result, '{"hello":"world"}');
    } finally {
      Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true });
    }
  });
});

// -----------------------------------------------------------------------------
// BLUE-CORE-CONCURRENT-1 (SF1): index.lock 並列書込整合
// -----------------------------------------------------------------------------

describe('session-logger-core: BLUE-CORE-CONCURRENT index.lock', () => {
  test('BLUE-CORE-CONCURRENT-1: 10 並列 UserPrompt で各 session 1 file + counters 正確', async () => {
    const { root, ctx } = await createCtx();
    try {
      const concurrency = 10;
      const events = Array.from({ length: concurrency }, (_, i) => ({
        sessionId: `concurrent-${String(i).padStart(4, '0')}`,
        eventName: 'user_prompt',
        agent: 'claude',
        timestamp: new Date(Date.now() + i),
        userPrompt: { text: `prompt ${i}` },
        cwd: '/tmp',
      }));

      await Promise.all(events.map((e) => ingestNormalizedEvent(e, ctx)));

      // 全 session に 1 file ずつ
      const files = (await readdir(ctx.sessionLogsDir)).filter((f) => f.endsWith('.md'));
      assert.equal(files.length, concurrency);

      // index.json が整合: 各 session 1 エントリ、各 counters.user_prompts === 1
      const indexRaw = await readFile(ctx.indexPath, 'utf8');
      const index = JSON.parse(indexRaw);
      assert.equal(Object.keys(index.sessions).length, concurrency);
      for (const e of events) {
        const entry = index.sessions[e.sessionId];
        assert.ok(entry, `session ${e.sessionId} missing`);
        assert.equal(entry.counters.user_prompts, 1);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-CORE-CONCURRENT-1: 20 並列 event (single session) で counters 20 に到達', async () => {
    const { root, ctx } = await createCtx();
    try {
      const sessionId = 'concurrent-single';
      // 最初の 1 件で session を establish
      await ingestNormalizedEvent(
        {
          sessionId,
          eventName: 'user_prompt',
          agent: 'claude',
          timestamp: new Date(),
          userPrompt: { text: 'first' },
          cwd: '/tmp',
        },
        ctx,
      );
      // その後 20 件並列 (同 session)
      const events = Array.from({ length: 20 }, (_, i) => ({
        sessionId,
        eventName: 'user_prompt',
        agent: 'claude',
        timestamp: new Date(Date.now() + i + 1),
        userPrompt: { text: `follow-up ${i}` },
        cwd: '/tmp',
      }));
      await Promise.all(events.map((e) => ingestNormalizedEvent(e, ctx)));

      const indexRaw = await readFile(ctx.indexPath, 'utf8');
      const index = JSON.parse(indexRaw);
      assert.equal(index.sessions[sessionId].counters.user_prompts, 21);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// CORE ghost session behavior (MF1 core 移植 + 既存 test の mirror)
// -----------------------------------------------------------------------------

describe('session-logger-core: ghost session guard', () => {
  test('CORE-GHOST-1: tool_use arrives first → no file created, index untouched', async () => {
    const { root, ctx } = await createCtx();
    try {
      const intent = await ingestNormalizedEvent(
        {
          sessionId: 'ghost-0001',
          eventName: 'tool_use',
          agent: 'claude',
          timestamp: new Date(),
          toolUse: { name: 'Edit', input: { file_path: '/tmp/x' } },
          cwd: '/tmp',
        },
        ctx,
      );
      assert.deepEqual(intent, { type: 'none' });
      const files = (await readdir(ctx.sessionLogsDir)).filter((f) => f.endsWith('.md'));
      assert.equal(files.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('CORE-GHOST-2: assistant_stop arrives first → no file created', async () => {
    const { root, ctx } = await createCtx();
    try {
      await ingestNormalizedEvent(
        {
          sessionId: 'ghost-0002',
          eventName: 'assistant_stop',
          agent: 'claude',
          timestamp: new Date(),
          assistantResponse: { transcriptPath: '/nonexistent' },
          cwd: '/tmp',
        },
        ctx,
      );
      const files = (await readdir(ctx.sessionLogsDir)).filter((f) => f.endsWith('.md'));
      assert.equal(files.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// BLUE-CORE-CWD-VAULT-*: §43 self-recursion guard agent-aware (v0.7.0 fix)
// 2026-04-27 RYU Codex 実機 verify で発見、Claude のみ guard 発火、非 Claude は
// vault 内 cwd でも log 取れる挙動を pin
// -----------------------------------------------------------------------------

describe('session-logger-core: BLUE-CORE-CWD-VAULT self-recursion guard agent-aware', () => {
  test('BLUE-CORE-CWD-VAULT-CLAUDE-1: agent="claude" + cwd in vault → null (guard 発火)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kioku-cwd-vault-claude-'));
    const sessionLogsDir = join(root, 'session-logs');
    const internalDir = join(sessionLogsDir, '.claude-brain');
    await mkdir(internalDir, { recursive: true, mode: 0o700 });
    const originalCwd = process.cwd();
    const originalVault = process.env.OBSIDIAN_VAULT;
    try {
      process.env.OBSIDIAN_VAULT = root;
      process.chdir(root); // cwd = vault root
      const ctx = await buildContext({ agent: 'claude' });
      assert.equal(ctx, null, 'Claude agent + cwd in vault は guard で null 返却 (auto-ingest re-entrance 防止)');
    } finally {
      process.chdir(originalCwd);
      if (originalVault === undefined) {
        delete process.env.OBSIDIAN_VAULT;
      } else {
        process.env.OBSIDIAN_VAULT = originalVault;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-CORE-CWD-VAULT-CLAUDE-2: agent="claude" + cwd in vault subdir → null (guard 発火)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kioku-cwd-vault-claude-sub-'));
    const sessionLogsDir = join(root, 'session-logs');
    const internalDir = join(sessionLogsDir, '.claude-brain');
    const subDir = join(root, 'wiki');
    await mkdir(internalDir, { recursive: true, mode: 0o700 });
    await mkdir(subDir, { recursive: true });
    const originalCwd = process.cwd();
    const originalVault = process.env.OBSIDIAN_VAULT;
    try {
      process.env.OBSIDIAN_VAULT = root;
      process.chdir(subDir); // cwd = vault/wiki/
      const ctx = await buildContext({ agent: 'claude' });
      assert.equal(ctx, null, 'Claude agent + cwd vault subdir も guard 発火');
    } finally {
      process.chdir(originalCwd);
      if (originalVault === undefined) {
        delete process.env.OBSIDIAN_VAULT;
      } else {
        process.env.OBSIDIAN_VAULT = originalVault;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-CORE-CWD-VAULT-GEMINI-1: agent="gemini" + cwd in vault → ctx 返却 (guard skip)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kioku-cwd-vault-gemini-'));
    const sessionLogsDir = join(root, 'session-logs');
    const internalDir = join(sessionLogsDir, '.claude-brain');
    await mkdir(internalDir, { recursive: true, mode: 0o700 });
    const originalCwd = process.cwd();
    const originalVault = process.env.OBSIDIAN_VAULT;
    try {
      process.env.OBSIDIAN_VAULT = root;
      process.chdir(root); // cwd = vault root
      const ctx = await buildContext({ agent: 'gemini' });
      assert.ok(ctx, 'Gemini agent は cwd in vault でも guard 通過、ctx 返却');
      assert.equal(ctx.vault, root);
    } finally {
      process.chdir(originalCwd);
      if (originalVault === undefined) {
        delete process.env.OBSIDIAN_VAULT;
      } else {
        process.env.OBSIDIAN_VAULT = originalVault;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-CORE-CWD-VAULT-CODEX-1: agent="codex" + cwd in vault → ctx 返却 (guard skip)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kioku-cwd-vault-codex-'));
    const sessionLogsDir = join(root, 'session-logs');
    const internalDir = join(sessionLogsDir, '.claude-brain');
    await mkdir(internalDir, { recursive: true, mode: 0o700 });
    const originalCwd = process.cwd();
    const originalVault = process.env.OBSIDIAN_VAULT;
    try {
      process.env.OBSIDIAN_VAULT = root;
      process.chdir(root); // cwd = vault root
      const ctx = await buildContext({ agent: 'codex' });
      assert.ok(ctx, 'Codex agent は cwd in vault でも guard 通過、ctx 返却');
      assert.equal(ctx.vault, root);
    } finally {
      process.chdir(originalCwd);
      if (originalVault === undefined) {
        delete process.env.OBSIDIAN_VAULT;
      } else {
        process.env.OBSIDIAN_VAULT = originalVault;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-CORE-CWD-VAULT-DEFAULT-1: agent 未指定 (default claude) + cwd in vault → null (back-compat)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kioku-cwd-vault-default-'));
    const sessionLogsDir = join(root, 'session-logs');
    const internalDir = join(sessionLogsDir, '.claude-brain');
    await mkdir(internalDir, { recursive: true, mode: 0o700 });
    const originalCwd = process.cwd();
    const originalVault = process.env.OBSIDIAN_VAULT;
    try {
      process.env.OBSIDIAN_VAULT = root;
      process.chdir(root);
      const ctx = await buildContext(); // agent 未指定、default 'claude'
      assert.equal(ctx, null, 'agent 未指定時の default は claude → guard 発火 (back-compat、未来の adapter 追加で fail-safe)');
    } finally {
      process.chdir(originalCwd);
      if (originalVault === undefined) {
        delete process.env.OBSIDIAN_VAULT;
      } else {
        process.env.OBSIDIAN_VAULT = originalVault;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-CORE-CWD-VAULT-OUTSIDE-1: agent="claude" + cwd OUTSIDE vault → ctx 返却 (guard 通過)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kioku-cwd-vault-outside-'));
    const sessionLogsDir = join(root, 'session-logs');
    const internalDir = join(sessionLogsDir, '.claude-brain');
    await mkdir(internalDir, { recursive: true, mode: 0o700 });
    const originalVault = process.env.OBSIDIAN_VAULT;
    try {
      process.env.OBSIDIAN_VAULT = root;
      // cwd は test runner の cwd (vault 外、tmpdir / repo root 等)
      const ctx = await buildContext({ agent: 'claude' });
      assert.ok(ctx, 'Claude agent でも cwd が vault 外なら ctx 返却');
      assert.equal(ctx.vault, root);
    } finally {
      if (originalVault === undefined) {
        delete process.env.OBSIDIAN_VAULT;
      } else {
        process.env.OBSIDIAN_VAULT = originalVault;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
