// tests/hooks/adapters/codex.test.mjs — v0.7.0 Q2 Codex adapter tests
//
// Targets: hooks/adapters/codex.mjs
// Test prefixes:
//   - CODEX-ADPT-*        : Codex v2 payload → NormalizedEvent
//   - BLUE-ADPT-NOLOG-CODEX-1..2 : KIOKU_NO_LOG / KIOKU_NO_LOG_CODEX (SF4)
//   - BLUE-ADPT-FAIL-CODEX-1..3  : malformed input → exit 0 (MF5) + hot.md 非 emit

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { codexPayloadToNormalizedEvent } from '../../../hooks/adapters/codex.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ADAPTER_PATH = join(__dirname, '..', '..', '..', 'hooks', 'adapters', 'codex.mjs');

async function createVault() {
  const root = await mkdtemp(join(tmpdir(), 'kioku-codex-adpt-test-'));
  const vault = join(root, 'vault');
  await mkdir(vault, { recursive: true });
  return { root, vault };
}

function runAdapter(vault, payload, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [ADAPTER_PATH], {
      env: { ...process.env, OBSIDIAN_VAULT: vault, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
    child.stdin.end();
  });
}

async function listSessionFiles(vault) {
  try {
    const files = await readdir(join(vault, 'session-logs'));
    return files.filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
}

// -----------------------------------------------------------------------------
// CODEX-ADPT-*: payload → NormalizedEvent
// -----------------------------------------------------------------------------

describe('codex adapter: codexPayloadToNormalizedEvent', () => {
  test('CODEX-ADPT-1: UserPromptSubmit → user_prompt', () => {
    const normEv = codexPayloadToNormalizedEvent({
      session_id: 'codex-0001',
      transcript_path: '/var/codex/t.jsonl',
      cwd: '/home/user/proj',
      hook_event_name: 'UserPromptSubmit',
      model: 'gpt-5-codex',
      turn_id: 't1',
      prompt: 'Draft the migration script',
    });
    assert.ok(normEv);
    assert.equal(normEv.sessionId, 'codex-0001');
    assert.equal(normEv.eventName, 'user_prompt');
    assert.equal(normEv.agent, 'codex');
    assert.equal(normEv.userPrompt.text, 'Draft the migration script');
  });

  test('CODEX-ADPT-2: Stop → assistant_stop (inline last_assistant_message preferred)', () => {
    const normEv = codexPayloadToNormalizedEvent({
      session_id: 'codex-0002',
      hook_event_name: 'Stop',
      cwd: '/tmp',
      turn_id: 't1',
      stop_hook_active: false,
      last_assistant_message: 'Here is the migration.',
    });
    assert.equal(normEv.eventName, 'assistant_stop');
    assert.equal(normEv.assistantResponse.text, 'Here is the migration.');
  });

  test('CODEX-ADPT-3: Stop with null last_assistant_message but transcript_path', () => {
    const normEv = codexPayloadToNormalizedEvent({
      session_id: 'codex-0003',
      hook_event_name: 'Stop',
      cwd: '/tmp',
      transcript_path: '/var/codex/t.jsonl',
      last_assistant_message: null,
      stop_hook_active: false,
    });
    assert.equal(normEv.eventName, 'assistant_stop');
    assert.equal(normEv.assistantResponse.text, undefined);
    assert.equal(normEv.assistantResponse.transcriptPath, '/var/codex/t.jsonl');
  });

  test('CODEX-ADPT-4: PostToolUse (Bash) → tool_use (name=Bash、直通)', () => {
    const normEv = codexPayloadToNormalizedEvent({
      session_id: 'codex-0004',
      hook_event_name: 'PostToolUse',
      cwd: '/tmp',
      turn_id: 't1',
      tool_name: 'Bash',
      tool_use_id: 'tu-1',
      tool_input: { command: 'git log -5' },
      tool_response: '5 commits listed',
    });
    assert.equal(normEv.eventName, 'tool_use');
    assert.equal(normEv.toolUse.name, 'Bash');
    assert.equal(normEv.toolUse.input.command, 'git log -5');
  });

  test('CODEX-ADPT-5: SessionStart / PreToolUse / PermissionRequest / SessionEnd all return null (scope 外 or N/A)', () => {
    assert.equal(
      codexPayloadToNormalizedEvent({
        session_id: 'x',
        hook_event_name: 'SessionStart',
        source: 'startup',
      }),
      null,
    );
    assert.equal(
      codexPayloadToNormalizedEvent({
        session_id: 'x',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
      }),
      null,
    );
    assert.equal(
      codexPayloadToNormalizedEvent({
        session_id: 'x',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
      }),
      null,
    );
    // SessionEnd は Codex に event 無いが、念のため EVENT_MAP に入れていないことを確認
    assert.equal(
      codexPayloadToNormalizedEvent({
        session_id: 'x',
        hook_event_name: 'SessionEnd',
      }),
      null,
    );
  });

  test('CODEX-ADPT-6: empty / malformed inputs return null', () => {
    assert.equal(codexPayloadToNormalizedEvent(null), null);
    assert.equal(codexPayloadToNormalizedEvent({}), null);
    assert.equal(
      codexPayloadToNormalizedEvent({
        session_id: '',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'x',
      }),
      null,
    );
  });

  test('BLUE-ADPT-CODEX-SPOOF-1: non-Bash tool_name (Edit/Write/run_shell_command) → null 返却', () => {
    // PR #56 SF-C review fix: Codex 側の fabricated payload が 'Edit' / 'Write' /
    // 'MultiEdit' / Gemini snake_case 等で tool_name を詐称しても、Codex 仕様は
    // Bash only intercept なので adapter が reject する。
    for (const spoofName of ['Edit', 'Write', 'MultiEdit', 'run_shell_command', 'replace', 'write_file', 'read_file', '']) {
      const normEv = codexPayloadToNormalizedEvent({
        session_id: `codex-spoof-${spoofName || 'empty'}`,
        hook_event_name: 'PostToolUse',
        cwd: '/tmp',
        tool_name: spoofName,
        tool_input: {},
        tool_response: '',
      });
      assert.equal(
        normEv,
        null,
        `Codex adapter must reject non-Bash tool name: ${JSON.stringify(spoofName)}`,
      );
    }
  });

  test('BLUE-ADPT-CODEX-SPOOF-1: tool_name 非文字列 (number / null / undefined) も reject', () => {
    for (const invalid of [42, null, undefined, { x: 'Bash' }, ['Bash']]) {
      assert.equal(
        codexPayloadToNormalizedEvent({
          session_id: 'x',
          hook_event_name: 'PostToolUse',
          cwd: '/tmp',
          tool_name: invalid,
        }),
        null,
      );
    }
  });

  test('CODEX-ADPT-7: Codex adapter does NOT emit session_end (Codex has no such event)', () => {
    // Positive contract: adapter returning null for SessionEnd confirms that Codex flow
    // never reaches core's handleSessionEnd. install-hooks-codex.sh emulates via Stop hook + git-sync shell.
    const result = codexPayloadToNormalizedEvent({
      session_id: 'codex-0007',
      hook_event_name: 'SessionEnd',
      cwd: '/tmp',
      exit_reason: 'user_quit',
    });
    assert.equal(result, null, 'Codex adapter must reject SessionEnd (Codex has no SessionEnd)');
  });
});

// -----------------------------------------------------------------------------
// BLUE-ADPT-NOLOG-CODEX-1..2 (SF4)
// -----------------------------------------------------------------------------

describe('codex adapter: NOLOG env gates', () => {
  test('BLUE-ADPT-NOLOG-CODEX-1: KIOKU_NO_LOG=1 → no files', async () => {
    const { root, vault } = await createVault();
    try {
      const { code } = await runAdapter(
        vault,
        {
          session_id: 'nolog-c-1',
          hook_event_name: 'UserPromptSubmit',
          cwd: '/tmp',
          prompt: 'x',
        },
        { KIOKU_NO_LOG: '1' },
      );
      assert.equal(code, 0);
      assert.equal((await listSessionFiles(vault)).length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-ADPT-NOLOG-CODEX-2: KIOKU_NO_LOG_CODEX=yes → no files', async () => {
    const { root, vault } = await createVault();
    try {
      const { code } = await runAdapter(
        vault,
        {
          session_id: 'nolog-c-2',
          hook_event_name: 'UserPromptSubmit',
          cwd: '/tmp',
          prompt: 'x',
        },
        { KIOKU_NO_LOG_CODEX: 'yes' },
      );
      assert.equal(code, 0);
      assert.equal((await listSessionFiles(vault)).length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// BLUE-ADPT-FAIL-CODEX-1..3 (MF5 + hot.md 非 emit)
// -----------------------------------------------------------------------------

describe('codex adapter: exit 0 under failure + hot.md isolation', () => {
  test('BLUE-ADPT-FAIL-CODEX-1: malformed JSON → exit 0', async () => {
    const { root, vault } = await createVault();
    try {
      const { code } = await runAdapter(vault, 'not-json {{{');
      assert.equal(code, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-ADPT-FAIL-CODEX-2: unknown hook_event_name → exit 0, no files', async () => {
    const { root, vault } = await createVault();
    try {
      const { code } = await runAdapter(vault, {
        session_id: 'fail-c-2',
        hook_event_name: 'MysteryEvent',
      });
      assert.equal(code, 0);
      assert.equal((await listSessionFiles(vault)).length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-ADPT-FAIL-CODEX-3: hot.md opt-in NEVER fires from Codex adapter (claude-only, MF4)', async () => {
    const { root, vault } = await createVault();
    try {
      await runAdapter(vault, {
        session_id: 'fail-c-3',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: 'setup',
      });
      const { code, stdout } = await runAdapter(
        vault,
        {
          session_id: 'fail-c-3',
          hook_event_name: 'Stop',
          cwd: '/tmp',
          last_assistant_message: 'ok',
          stop_hook_active: false,
        },
        { KIOKU_HOT_AUTO_PROMPT: '1' },
      );
      assert.equal(code, 0);
      assert.equal(stdout, '', 'codex adapter must not emit hot.md systemMessage (claude-only, MF4)');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// E2E: per-turn Stop pattern (Codex has no SessionEnd)
// -----------------------------------------------------------------------------

describe('codex adapter: per-turn Stop pattern (SessionEnd gap workaround)', () => {
  test('CODEX-ADPT-E2E-1: UserPromptSubmit + PostToolUse(Bash) + Stop writes log, NO Session Summary (Codex)', async () => {
    const { root, vault } = await createVault();
    try {
      const sessionId = 'codex-e2e-0001';

      const r1 = await runAdapter(vault, {
        session_id: sessionId,
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: 'Run git status.',
      });
      assert.equal(r1.code, 0);

      const r2 = await runAdapter(vault, {
        session_id: sessionId,
        hook_event_name: 'PostToolUse',
        cwd: '/tmp',
        turn_id: 't1',
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
        tool_response: 'clean',
      });
      assert.equal(r2.code, 0);

      const r3 = await runAdapter(vault, {
        session_id: sessionId,
        hook_event_name: 'Stop',
        cwd: '/tmp',
        turn_id: 't1',
        last_assistant_message: 'Done, branch is clean.',
        stop_hook_active: false,
      });
      assert.equal(r3.code, 0);

      const files = await listSessionFiles(vault);
      assert.equal(files.length, 1);
      const content = await readFile(join(vault, 'session-logs', files[0]), 'utf8');
      assert.match(content, /## User /);
      assert.match(content, /Run git status\./);
      assert.match(content, /\[!terminal\]- Bash /);
      assert.match(content, />\s*git status/);
      assert.match(content, /## Assistant /);
      assert.match(content, /Done, branch is clean\./);

      // Codex adapter は session_end を emit しないため Session Summary は出ない
      assert.doesNotMatch(content, /## Session Summary/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
