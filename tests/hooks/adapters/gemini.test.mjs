// tests/hooks/adapters/gemini.test.mjs — v0.7.0 Q2 Gemini adapter tests
//
// Targets: hooks/adapters/gemini.mjs
// Test prefixes:
//   - GEMINI-ADPT-*        : Gemini v2 payload → NormalizedEvent conversion
//   - BLUE-ADPT-NOLOG-GEMINI-1..2 : KIOKU_NO_LOG / KIOKU_NO_LOG_GEMINI (SF4)
//   - BLUE-ADPT-FAIL-GEMINI-1..3  : malformed input → exit 0 (MF5)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { geminiPayloadToNormalizedEvent } from '../../../hooks/adapters/gemini.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ADAPTER_PATH = join(__dirname, '..', '..', '..', 'hooks', 'adapters', 'gemini.mjs');

async function createVault() {
  const root = await mkdtemp(join(tmpdir(), 'kioku-gemini-adpt-test-'));
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
// GEMINI-ADPT-*: payload → NormalizedEvent
// -----------------------------------------------------------------------------

describe('gemini adapter: geminiPayloadToNormalizedEvent', () => {
  test('GEMINI-ADPT-1: BeforeAgent → user_prompt', () => {
    const normEv = geminiPayloadToNormalizedEvent({
      session_id: 'gemini-0001',
      transcript_path: '/var/gemini/transcript.json',
      cwd: '/home/user/proj',
      hook_event_name: 'BeforeAgent',
      timestamp: '2026-04-24T10:00:00Z',
      prompt: 'Explain the auth flow',
    });
    assert.ok(normEv);
    assert.equal(normEv.sessionId, 'gemini-0001');
    assert.equal(normEv.eventName, 'user_prompt');
    assert.equal(normEv.agent, 'gemini');
    assert.equal(normEv.userPrompt.text, 'Explain the auth flow');
    assert.equal(normEv.cwd, '/home/user/proj');
    assert.ok(normEv.timestamp instanceof Date);
  });

  test('GEMINI-ADPT-2: AfterAgent → assistant_stop (inline prompt_response preferred)', () => {
    const normEv = geminiPayloadToNormalizedEvent({
      session_id: 'gemini-0002',
      hook_event_name: 'AfterAgent',
      cwd: '/tmp',
      prompt: 'explain X',
      prompt_response: 'Here is X.',
      stop_hook_active: false,
    });
    assert.equal(normEv.eventName, 'assistant_stop');
    assert.equal(normEv.assistantResponse.text, 'Here is X.');
    // transcriptPath 未提供なら undefined
    assert.equal(normEv.assistantResponse.transcriptPath, undefined);
  });

  test('GEMINI-ADPT-3: AfterAgent with transcript_path fallback (no inline text)', () => {
    const normEv = geminiPayloadToNormalizedEvent({
      session_id: 'gemini-0003',
      hook_event_name: 'AfterAgent',
      cwd: '/tmp',
      prompt: 'q',
      transcript_path: '/var/gemini/transcript.json',
    });
    assert.equal(normEv.eventName, 'assistant_stop');
    assert.equal(normEv.assistantResponse.transcriptPath, '/var/gemini/transcript.json');
    // text が inline 提供されなければ undefined
    assert.equal(normEv.assistantResponse.text, undefined);
  });

  test('GEMINI-ADPT-4: AfterTool → tool_use with snake_case → canonical remap (Bash)', () => {
    const normEv = geminiPayloadToNormalizedEvent({
      session_id: 'gemini-0004',
      hook_event_name: 'AfterTool',
      cwd: '/tmp',
      tool_name: 'run_shell_command',
      tool_input: { command: 'git status' },
      tool_response: { llmContent: 'nothing to commit' },
    });
    assert.equal(normEv.eventName, 'tool_use');
    assert.equal(normEv.toolUse.name, 'Bash');
    assert.equal(normEv.toolUse.input.command, 'git status');
  });

  test('GEMINI-ADPT-5: AfterTool replace → Edit', () => {
    const normEv = geminiPayloadToNormalizedEvent({
      session_id: 'gemini-0005',
      hook_event_name: 'AfterTool',
      cwd: '/tmp',
      tool_name: 'replace',
      tool_input: { file_path: '/tmp/x.ts' },
      tool_response: {},
    });
    assert.equal(normEv.toolUse.name, 'Edit');
  });

  test('GEMINI-ADPT-6: AfterTool write_file → Write', () => {
    const normEv = geminiPayloadToNormalizedEvent({
      session_id: 'gemini-0006',
      hook_event_name: 'AfterTool',
      cwd: '/tmp',
      tool_name: 'write_file',
      tool_input: { file_path: '/tmp/y.ts' },
      tool_response: {},
    });
    assert.equal(normEv.toolUse.name, 'Write');
  });

  test('GEMINI-ADPT-7: AfterTool unknown tool (read_file) is rejected (SF-C, null return)', () => {
    // PR #56 SF-C review fix: 未知 Gemini tool (read_file / glob / grep / ls 等
    // session log 対象外) は **null 返却** で event 自体を reject する。以前は
    // pass-through で core が silent drop する logic だったが、canonical 名
    // passthrough の spoof 攻撃面を遮断するため adapter で明示 reject に変更。
    const normEv = geminiPayloadToNormalizedEvent({
      session_id: 'gemini-0007',
      hook_event_name: 'AfterTool',
      cwd: '/tmp',
      tool_name: 'read_file',
      tool_input: { file_path: '/tmp/z' },
      tool_response: {},
    });
    assert.equal(normEv, null, 'unknown Gemini tool name must reject the event (SF-C spoof defense)');
  });

  test('BLUE-ADPT-GEMINI-SPOOF-1: canonical 名 (Bash/Edit/Write) fabrication → null 返却', () => {
    // PR #56 SF-C review fix: Gemini 側の fabricated payload が canonical 名で
    // tool_name を詐称しても adapter が reject することを pinning。
    for (const spoofName of ['Bash', 'Edit', 'Write', 'MultiEdit']) {
      const normEv = geminiPayloadToNormalizedEvent({
        session_id: `gemini-spoof-${spoofName}`,
        hook_event_name: 'AfterTool',
        cwd: '/tmp',
        tool_name: spoofName,
        tool_input: { command: 'rm -rf /' },
        tool_response: {},
      });
      assert.equal(
        normEv,
        null,
        `Gemini adapter must reject canonical-name spoof: ${spoofName}`,
      );
    }
  });

  test('BLUE-ADPT-GEMINI-SPOOF-1: tool_name 非文字列 (number / object) も reject', () => {
    assert.equal(
      geminiPayloadToNormalizedEvent({
        session_id: 'x',
        hook_event_name: 'AfterTool',
        cwd: '/tmp',
        tool_name: 42,
      }),
      null,
    );
    assert.equal(
      geminiPayloadToNormalizedEvent({
        session_id: 'x',
        hook_event_name: 'AfterTool',
        cwd: '/tmp',
        tool_name: { name: 'Bash' },
      }),
      null,
    );
    assert.equal(
      geminiPayloadToNormalizedEvent({
        session_id: 'x',
        hook_event_name: 'AfterTool',
        cwd: '/tmp',
        tool_name: '',
      }),
      null,
    );
  });

  test('GEMINI-ADPT-8: SessionEnd → session_end + reason', () => {
    const normEv = geminiPayloadToNormalizedEvent({
      session_id: 'gemini-0008',
      hook_event_name: 'SessionEnd',
      cwd: '/tmp',
      reason: 'exit',
    });
    assert.equal(normEv.eventName, 'session_end');
    assert.equal(normEv.sessionEnd.reason, 'exit');
  });

  test('GEMINI-ADPT-9: unknown / out-of-scope events return null', () => {
    assert.equal(
      geminiPayloadToNormalizedEvent({
        session_id: 'x',
        hook_event_name: 'SessionStart',
        cwd: '/tmp',
      }),
      null,
    );
    assert.equal(
      geminiPayloadToNormalizedEvent({
        session_id: 'x',
        hook_event_name: 'PreCompress',
        cwd: '/tmp',
      }),
      null,
    );
    assert.equal(
      geminiPayloadToNormalizedEvent({
        session_id: 'x',
        hook_event_name: 'BeforeTool',
        cwd: '/tmp',
        tool_name: 'run_shell_command',
      }),
      null,
    );
    assert.equal(
      geminiPayloadToNormalizedEvent({
        session_id: 'x',
        hook_event_name: 'Notification',
      }),
      null,
    );
  });

  test('GEMINI-ADPT-10: empty / malformed session_id or payload returns null', () => {
    assert.equal(geminiPayloadToNormalizedEvent(null), null);
    assert.equal(geminiPayloadToNormalizedEvent({}), null);
    assert.equal(geminiPayloadToNormalizedEvent('string'), null);
    assert.equal(
      geminiPayloadToNormalizedEvent({
        session_id: '',
        hook_event_name: 'BeforeAgent',
        prompt: 'x',
      }),
      null,
    );
  });
});

// -----------------------------------------------------------------------------
// BLUE-ADPT-NOLOG-GEMINI-1..2: env gate (SF4)
// -----------------------------------------------------------------------------

describe('gemini adapter: NOLOG env gates', () => {
  test('BLUE-ADPT-NOLOG-GEMINI-1: KIOKU_NO_LOG=1 → no files, exit 0', async () => {
    const { root, vault } = await createVault();
    try {
      const { code, stdout } = await runAdapter(
        vault,
        {
          session_id: 'nolog-g-0001',
          hook_event_name: 'BeforeAgent',
          cwd: '/tmp',
          prompt: 'no-log',
        },
        { KIOKU_NO_LOG: '1' },
      );
      assert.equal(code, 0);
      assert.equal(stdout, '');
      assert.equal((await listSessionFiles(vault)).length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-ADPT-NOLOG-GEMINI-2: KIOKU_NO_LOG_GEMINI=true → no files, exit 0', async () => {
    const { root, vault } = await createVault();
    try {
      const { code } = await runAdapter(
        vault,
        {
          session_id: 'nolog-g-0002',
          hook_event_name: 'BeforeAgent',
          cwd: '/tmp',
          prompt: 'no-log',
        },
        { KIOKU_NO_LOG_GEMINI: 'true' },
      );
      assert.equal(code, 0);
      assert.equal((await listSessionFiles(vault)).length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// BLUE-ADPT-FAIL-GEMINI-1..3: malformed / error → exit 0 (MF5)
// -----------------------------------------------------------------------------

describe('gemini adapter: exit 0 under failure', () => {
  test('BLUE-ADPT-FAIL-GEMINI-1: malformed JSON → exit 0', async () => {
    const { root, vault } = await createVault();
    try {
      const { code } = await runAdapter(vault, 'not-json', {});
      assert.equal(code, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-ADPT-FAIL-GEMINI-2: unknown hook_event_name → exit 0, no files', async () => {
    const { root, vault } = await createVault();
    try {
      const { code } = await runAdapter(
        vault,
        { session_id: 'fail-g-2', hook_event_name: 'Unknown', cwd: '/tmp' },
        {},
      );
      assert.equal(code, 0);
      assert.equal((await listSessionFiles(vault)).length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-ADPT-FAIL-GEMINI-3: hot.md opt-in NEVER fires from Gemini adapter', async () => {
    // hot.md opt-in prompt is Claude-only (MF4). Even if KIOKU_HOT_AUTO_PROMPT=1, Gemini
    // must NOT emit the systemMessage.
    const { root, vault } = await createVault();
    try {
      // 先に user_prompt で session を確立
      await runAdapter(vault, {
        session_id: 'fail-g-3',
        hook_event_name: 'BeforeAgent',
        cwd: '/tmp',
        prompt: 'hi',
      });
      // AfterAgent で hot prompt が emit されないこと
      const { code, stdout } = await runAdapter(
        vault,
        {
          session_id: 'fail-g-3',
          hook_event_name: 'AfterAgent',
          cwd: '/tmp',
          prompt: 'hi',
          prompt_response: 'bye',
        },
        { KIOKU_HOT_AUTO_PROMPT: '1' },
      );
      assert.equal(code, 0);
      assert.equal(stdout, '', 'gemini adapter must not emit hot.md systemMessage (claude-only, MF4)');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// E2E: Gemini session full round-trip
// -----------------------------------------------------------------------------

describe('gemini adapter: end-to-end session log', () => {
  test('GEMINI-ADPT-E2E-1: BeforeAgent + AfterAgent + AfterTool + SessionEnd writes full log', async () => {
    const { root, vault } = await createVault();
    try {
      const sessionId = 'gemini-e2e-0001';

      const r1 = await runAdapter(vault, {
        session_id: sessionId,
        hook_event_name: 'BeforeAgent',
        cwd: '/tmp/proj',
        prompt: 'Check git status',
      });
      assert.equal(r1.code, 0);

      const r2 = await runAdapter(vault, {
        session_id: sessionId,
        hook_event_name: 'AfterAgent',
        cwd: '/tmp/proj',
        prompt: 'Check git status',
        prompt_response: 'Running git status now.',
      });
      assert.equal(r2.code, 0);

      const r3 = await runAdapter(vault, {
        session_id: sessionId,
        hook_event_name: 'AfterTool',
        cwd: '/tmp/proj',
        tool_name: 'run_shell_command',
        tool_input: { command: 'git status' },
        tool_response: { llmContent: 'clean' },
      });
      assert.equal(r3.code, 0);

      const r4 = await runAdapter(vault, {
        session_id: sessionId,
        hook_event_name: 'SessionEnd',
        cwd: '/tmp/proj',
        reason: 'exit',
      });
      assert.equal(r4.code, 0);

      const files = (await listSessionFiles(vault));
      assert.equal(files.length, 1);
      const content = await readFile(join(vault, 'session-logs', files[0]), 'utf8');

      assert.match(content, /type: session-log/);
      assert.match(content, new RegExp(`session_id: ${sessionId}`));
      assert.match(content, /## User /);
      assert.match(content, /Check git status/);
      assert.match(content, /## Assistant /);
      assert.match(content, /Running git status now\./);
      assert.match(content, /\[!terminal\]- Bash /);
      assert.match(content, />\s*git status/);
      assert.match(content, /## Session Summary /);
      assert.match(content, /exit_reason: exit/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
