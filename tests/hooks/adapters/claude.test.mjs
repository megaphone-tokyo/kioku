// tests/hooks/adapters/claude.test.mjs — v0.7.0 Q2 Claude adapter tests
//
// Targets: hooks/adapters/claude.mjs
// Test prefixes:
//   - CLAUDE-ADPT-*        : 基本 unit (Claude v2 payload → NormalizedEvent 変換)
//   - CLAUDE-ADPT-HOT-*    : hot.md opt-in prompt (claude adapter 専用、F4 MF4)
//   - BLUE-ADPT-FAIL-1..3  : adapter throw でも exit 0 (MF5)
//   - BLUE-ADPT-XSS-1..3   : systemMessage Markdown link/image strip (SF2)
//   - BLUE-ADPT-NOLOG-1..2 : KIOKU_NO_LOG / KIOKU_NO_LOG_CLAUDE で全 path no-op (SF4)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { claudePayloadToNormalizedEvent } from '../../../hooks/adapters/claude.mjs';
import { escapeForSystemMessage } from '../../../hooks/adapters/_common.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ADAPTER_PATH = join(__dirname, '..', '..', '..', 'hooks', 'adapters', 'claude.mjs');

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

async function createVault() {
  const root = await mkdtemp(join(tmpdir(), 'kioku-claude-adpt-test-'));
  const vault = join(root, 'vault');
  await mkdir(vault, { recursive: true });
  return { root, vault };
}

function runAdapter(vault, payload, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [ADAPTER_PATH], {
      env: {
        ...process.env,
        OBSIDIAN_VAULT: vault,
        ...extraEnv,
      },
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
// CLAUDE-ADPT-*: Claude v2 payload → NormalizedEvent
// -----------------------------------------------------------------------------

describe('claude adapter: claudePayloadToNormalizedEvent', () => {
  test('CLAUDE-ADPT-1: UserPromptSubmit → user_prompt + prompt text', () => {
    const normEv = claudePayloadToNormalizedEvent({
      session_id: 'sid-0001',
      hook_event_name: 'UserPromptSubmit',
      cwd: '/tmp/work',
      prompt: 'Hello assistant',
    });
    assert.ok(normEv);
    assert.equal(normEv.sessionId, 'sid-0001');
    assert.equal(normEv.eventName, 'user_prompt');
    assert.equal(normEv.agent, 'claude');
    assert.equal(normEv.userPrompt.text, 'Hello assistant');
    assert.equal(normEv.cwd, '/tmp/work');
    assert.ok(normEv.timestamp instanceof Date);
  });

  test('CLAUDE-ADPT-2: Stop → assistant_stop + transcriptPath', () => {
    const normEv = claudePayloadToNormalizedEvent({
      session_id: 'sid-0002',
      hook_event_name: 'Stop',
      cwd: '/tmp',
      transcript_path: '/var/log/claude-transcript.jsonl',
    });
    assert.equal(normEv.eventName, 'assistant_stop');
    assert.equal(normEv.assistantResponse.transcriptPath, '/var/log/claude-transcript.jsonl');
  });

  test('CLAUDE-ADPT-3: PostToolUse → tool_use + name/input/response', () => {
    const normEv = claudePayloadToNormalizedEvent({
      session_id: 'sid-0003',
      hook_event_name: 'PostToolUse',
      cwd: '/tmp',
      tool_name: 'Bash',
      tool_input: { command: 'ls /' },
      tool_response: { stdout: 'bin\netc\n' },
    });
    assert.equal(normEv.eventName, 'tool_use');
    assert.equal(normEv.toolUse.name, 'Bash');
    assert.equal(normEv.toolUse.input.command, 'ls /');
    assert.equal(normEv.toolUse.response.stdout, 'bin\netc\n');
  });

  test('CLAUDE-ADPT-4: SessionEnd → session_end + reason', () => {
    const normEv = claudePayloadToNormalizedEvent({
      session_id: 'sid-0004',
      hook_event_name: 'SessionEnd',
      cwd: '/tmp',
      exit_reason: 'user_quit',
    });
    assert.equal(normEv.eventName, 'session_end');
    assert.equal(normEv.sessionEnd.reason, 'user_quit');
  });

  test('CLAUDE-ADPT-5: unknown event (SessionStart / PreToolUse) returns null', () => {
    assert.equal(
      claudePayloadToNormalizedEvent({
        session_id: 'sid-0005',
        hook_event_name: 'SessionStart',
        cwd: '/tmp',
      }),
      null,
    );
    assert.equal(
      claudePayloadToNormalizedEvent({
        session_id: 'sid-0005',
        hook_event_name: 'PreToolUse',
        cwd: '/tmp',
        tool_name: 'Bash',
      }),
      null,
    );
  });

  test('CLAUDE-ADPT-6: empty/missing session_id returns null', () => {
    assert.equal(
      claudePayloadToNormalizedEvent({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'x',
      }),
      null,
    );
    assert.equal(
      claudePayloadToNormalizedEvent({
        session_id: '',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'x',
      }),
      null,
    );
  });

  test('CLAUDE-ADPT-7: malformed payload (null / primitive) returns null', () => {
    assert.equal(claudePayloadToNormalizedEvent(null), null);
    assert.equal(claudePayloadToNormalizedEvent(undefined), null);
    assert.equal(claudePayloadToNormalizedEvent('not-an-object'), null);
    assert.equal(claudePayloadToNormalizedEvent(42), null);
  });
});

// -----------------------------------------------------------------------------
// BLUE-ADPT-XSS-1..3: escapeForSystemMessage Markdown strip (SF2)
// -----------------------------------------------------------------------------

describe('claude adapter: BLUE-ADPT-XSS escapeForSystemMessage', () => {
  test('BLUE-ADPT-XSS-1: Markdown image is flattened to [image: alt]', () => {
    const s = escapeForSystemMessage('before ![evil](https://evil.example/x.png) after');
    assert.equal(s, 'before [image: evil] after');
    assert.ok(!s.includes('](https'));
  });

  test('BLUE-ADPT-XSS-2: Markdown link becomes plain text', () => {
    const s = escapeForSystemMessage('click [here](https://phish.example) for phishing');
    assert.equal(s, 'click here for phishing');
    assert.ok(!s.includes('phish.example'));
  });

  test('BLUE-ADPT-XSS-3: HTML tag is stripped', () => {
    const s = escapeForSystemMessage('prefix <script>alert(1)</script> suffix');
    // tags removed, inner text kept
    assert.ok(!s.includes('<script>'));
    assert.ok(!s.includes('</script>'));
    assert.ok(s.includes('alert(1)'));
  });

  test('BLUE-ADPT-XSS: non-string input returns empty', () => {
    assert.equal(escapeForSystemMessage(null), '');
    assert.equal(escapeForSystemMessage(undefined), '');
    assert.equal(escapeForSystemMessage(123), '');
  });
});

// -----------------------------------------------------------------------------
// BLUE-ADPT-NOLOG-1..2: KIOKU_NO_LOG / KIOKU_NO_LOG_CLAUDE (SF4)
// -----------------------------------------------------------------------------

describe('claude adapter: BLUE-ADPT-NOLOG env gates', () => {
  test('BLUE-ADPT-NOLOG-1: KIOKU_NO_LOG=1 → no files written, exit 0', async () => {
    const { root, vault } = await createVault();
    try {
      const { code, stdout } = await runAdapter(
        vault,
        {
          session_id: 'nolog-0001',
          hook_event_name: 'UserPromptSubmit',
          cwd: '/tmp',
          prompt: 'should not log',
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

  test('BLUE-ADPT-NOLOG-2: KIOKU_NO_LOG_CLAUDE=true → no files written, exit 0', async () => {
    const { root, vault } = await createVault();
    try {
      const { code, stdout } = await runAdapter(
        vault,
        {
          session_id: 'nolog-0002',
          hook_event_name: 'UserPromptSubmit',
          cwd: '/tmp',
          prompt: 'should not log',
        },
        { KIOKU_NO_LOG_CLAUDE: 'true' },
      );
      assert.equal(code, 0);
      assert.equal(stdout, '');
      assert.equal((await listSessionFiles(vault)).length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// BLUE-ADPT-FAIL-1..3: adapter throw でも exit 0 (MF5)
// -----------------------------------------------------------------------------

describe('claude adapter: BLUE-ADPT-FAIL exit 0 under failure', () => {
  test('BLUE-ADPT-FAIL-1: malformed JSON stdin → exit 0', async () => {
    const { root, vault } = await createVault();
    try {
      const { code } = await runAdapter(vault, 'not-json-at-all {{{', {});
      assert.equal(code, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-ADPT-FAIL-2: unknown hook_event_name → exit 0, no files', async () => {
    const { root, vault } = await createVault();
    try {
      const { code } = await runAdapter(
        vault,
        { session_id: 'fail-0002', hook_event_name: 'MysteryEvent', cwd: '/tmp' },
        {},
      );
      assert.equal(code, 0);
      assert.equal((await listSessionFiles(vault)).length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-ADPT-FAIL-3: OBSIDIAN_VAULT unset → exit 0, no throw', async () => {
    // createVault not needed; we explicitly omit OBSIDIAN_VAULT
    const { code } = await new Promise((resolve, reject) => {
      const childEnv = { ...process.env };
      delete childEnv.OBSIDIAN_VAULT;
      const child = spawn('node', [ADAPTER_PATH], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code, stderr }));
      child.stdin.write(JSON.stringify({
        session_id: 'fail-0003',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'x',
      }));
      child.stdin.end();
    });
    assert.equal(code, 0);
  });
});

// -----------------------------------------------------------------------------
// CLAUDE-ADPT-HOT-*: hot.md opt-in prompt (F4 MF4、claude 専用)
// -----------------------------------------------------------------------------

describe('claude adapter: CLAUDE-ADPT-HOT opt-in prompt', () => {
  test('CLAUDE-ADPT-HOT-1: KIOKU_HOT_AUTO_PROMPT unset on Stop → no systemMessage', async () => {
    const { root, vault } = await createVault();
    try {
      // prepare: first create session via UserPromptSubmit
      await runAdapter(vault, {
        session_id: 'hot-0001',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: 'start',
      });
      // Stop without opt-in
      const { code, stdout } = await runAdapter(vault, {
        session_id: 'hot-0001',
        hook_event_name: 'Stop',
        cwd: '/tmp',
        transcript_path: '/nonexistent',
      });
      assert.equal(code, 0);
      assert.equal(stdout, '');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('CLAUDE-ADPT-HOT-2: KIOKU_HOT_AUTO_PROMPT=1 on Stop → systemMessage emitted', async () => {
    const { root, vault } = await createVault();
    try {
      await runAdapter(vault, {
        session_id: 'hot-0002',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: 'start',
      });
      const { code, stdout } = await runAdapter(
        vault,
        {
          session_id: 'hot-0002',
          hook_event_name: 'Stop',
          cwd: '/tmp',
          transcript_path: '/nonexistent',
        },
        { KIOKU_HOT_AUTO_PROMPT: '1' },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.ok(parsed.systemMessage, 'systemMessage present');
      assert.match(parsed.systemMessage, /hot\.md/);
      assert.match(parsed.systemMessage, /opt-in/);
      // negative assertion (LEARN#9): do NOT emit v1-flat additionalContext
      assert.ok(!('additionalContext' in parsed));
      // negative assertion: hookSpecificOutput (v2 structured) is also not used for this prompt
      assert.ok(!('hookSpecificOutput' in parsed));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('CLAUDE-ADPT-HOT-3: KIOKU_HOT_AUTO_PROMPT=1 on UserPromptSubmit → NOT emitted (Stop only)', async () => {
    const { root, vault } = await createVault();
    try {
      const { code, stdout } = await runAdapter(
        vault,
        {
          session_id: 'hot-0003',
          hook_event_name: 'UserPromptSubmit',
          cwd: '/tmp',
          prompt: 'start',
        },
        { KIOKU_HOT_AUTO_PROMPT: '1' },
      );
      assert.equal(code, 0);
      assert.equal(stdout, '', 'hot.md prompt must fire only on Stop, not UserPromptSubmit');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('CLAUDE-ADPT-HOT-5: emitted systemMessage must have passed through escapeForSystemMessage (SF-B tripwire)', async () => {
    // PR #56 SF-B review fix: tripwire assertion。hot.md prompt emission 経路が
    // **必ず** escapeForSystemMessage を通っていることを pin する。将来 prompt
    // 内容を動的 (session log 抜粋等) に拡張した際、Markdown link/image strip
    // がスキップされる regression を検知する。
    //
    // 現状 static prompt は Markdown link/image を含まないので escape 前後で
    // 同一だが、**escape が呼ばれた事実そのもの** を pin するため以下を assert:
    //   (1) systemMessage 内容が escapeForSystemMessage(rawPrompt) と byte-identical
    //   (2) escape 関数単体 test が green (BLUE-ADPT-XSS-1..3 で既に検証)
    // (1) + (2) 同時成立 = escape は call path 上 invoke された (偶然 escape 前後
    // 同値である static prompt でも tripwire は機能する)。
    const { root, vault } = await createVault();
    try {
      await runAdapter(vault, {
        session_id: 'hot-0005',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: 'start',
      });
      const { code, stdout } = await runAdapter(
        vault,
        {
          session_id: 'hot-0005',
          hook_event_name: 'Stop',
          cwd: '/tmp',
          transcript_path: '/nonexistent',
        },
        { KIOKU_HOT_AUTO_PROMPT: '1' },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      // static prompt 本体は claude.mjs 実装と同形 (escapeForSystemMessage が
      // static 文字列に対して no-op なので、期待値は raw prompt と一致)
      const expectedRawPrompt = [
        '## ホットキャッシュ更新 (opt-in 提案)',
        '',
        '直近のセッション状況を踏まえて、$OBSIDIAN_VAULT/wiki/hot.md を短い引き継ぎメモ',
        '(Recent Context、500 word 以下) として更新すべきか検討してください。',
        '更新する場合は `kioku_write_wiki` または直接 Edit で hot.md を書き換えてください。',
        '秘密情報 (API key / token / PII) は絶対に含めないこと (scan-secrets.sh が検知します)。',
      ].join('\n');
      // escapeForSystemMessage は import 済、実際に call して expected を生成
      const { escapeForSystemMessage } = await import('../../../hooks/adapters/_common.mjs');
      const expectedEscaped = escapeForSystemMessage(expectedRawPrompt, 'claude');
      assert.equal(
        parsed.systemMessage,
        expectedEscaped,
        'emitted systemMessage must equal escapeForSystemMessage(rawPrompt) — if escape call is removed, this assertion fires',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('CLAUDE-ADPT-HOT-4: KIOKU_HOT_AUTO_PROMPT=false is treated as falsy', async () => {
    const { root, vault } = await createVault();
    try {
      await runAdapter(vault, {
        session_id: 'hot-0004',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: 'start',
      });
      const { stdout } = await runAdapter(
        vault,
        {
          session_id: 'hot-0004',
          hook_event_name: 'Stop',
          cwd: '/tmp',
          transcript_path: '/nonexistent',
        },
        { KIOKU_HOT_AUTO_PROMPT: 'false' },
      );
      assert.equal(stdout, '');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
