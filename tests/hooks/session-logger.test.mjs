// session-logger.test.mjs — hooks/session-logger.mjs のユニットテスト
//
// 実行: node --test tools/claude-brain/tests/hooks/
//
// 原則:
//   - 実 Vault を触らない (mktemp -d)
//   - ネットワークなし
//   - テスト終了時に tmpdir を確実に削除
//   - session_id は test-session-* の固定プレフィックス

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HOOK_PATH = join(__dirname, '..', '..', 'hooks', 'session-logger.mjs');

// -----------------------------------------------------------------------------
// ヘルパ
// -----------------------------------------------------------------------------

async function createVault() {
  const dir = await mkdtemp(join(tmpdir(), 'claude-brain-test-'));
  const vault = join(dir, 'vault');
  await mkdir(vault, { recursive: true });
  return { root: dir, vault };
}

function runHook(vault, payload, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [HOOK_PATH], {
      env: {
        ...process.env,
        OBSIDIAN_VAULT: vault,
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stderr }));
    child.stdin.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
    child.stdin.end();
  });
}

async function listSessionFiles(vault) {
  const dir = join(vault, 'session-logs');
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith('.md'));
  } catch {
    return [];
  }
}

async function readIndex(vault) {
  const path = join(vault, 'session-logs', '.claude-brain', 'index.json');
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function readFirstSessionFile(vault) {
  const files = await listSessionFiles(vault);
  if (files.length === 0) return '';
  return readFile(join(vault, 'session-logs', files[0]), 'utf8');
}

// -----------------------------------------------------------------------------
// Test suites
// -----------------------------------------------------------------------------

describe('session-logger: environment guards', () => {
  test('exit 0 and no write when OBSIDIAN_VAULT is unset', async () => {
    const { root } = await createVault();
    try {
      const p = { session_id: 'test-session-0001', hook_event_name: 'UserPromptSubmit', prompt: 'x' };
      const { code } = await new Promise((resolve, reject) => {
        const child = spawn('node', [HOOK_PATH], {
          env: { ...process.env, OBSIDIAN_VAULT: '' },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.on('error', reject);
        child.on('exit', (c) => resolve({ code: c }));
        child.stdin.write(JSON.stringify(p));
        child.stdin.end();
      });
      assert.equal(code, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('exit 0 and silent when stdin is not valid JSON', async () => {
    const { root, vault } = await createVault();
    try {
      const { code } = await runHook(vault, 'not-json-at-all');
      assert.equal(code, 0);
      const files = await listSessionFiles(vault);
      assert.equal(files.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('exit 0 and silent when required fields missing', async () => {
    const { root, vault } = await createVault();
    try {
      const { code } = await runHook(vault, { foo: 'bar' });
      assert.equal(code, 0);
      const files = await listSessionFiles(vault);
      assert.equal(files.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('unknown hook_event_name is silently ignored', async () => {
    const { root, vault } = await createVault();
    try {
      const { code } = await runHook(vault, {
        session_id: 'test-session-0002',
        hook_event_name: 'SessionStart',
      });
      assert.equal(code, 0);
      const files = await listSessionFiles(vault);
      assert.equal(files.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('session-logger: UserPromptSubmit', () => {
  test('creates session file with frontmatter and user section', async () => {
    const { root, vault } = await createVault();
    try {
      await runHook(vault, {
        session_id: 'test-session-0010',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp/proj',
        prompt: 'Hello, this is a test prompt',
      });
      const files = await listSessionFiles(vault);
      assert.equal(files.length, 1);
      const name = files[0];
      assert.match(name, /^\d{8}-\d{6}-test-.+\.md$/);
      assert.match(name, /Hello.*this-is-a-test-prompt/);

      const body = await readFirstSessionFile(vault);
      assert.match(body, /^---\n/);
      assert.match(body, /type: session-log/);
      assert.match(body, /session_id: test-session-0010/);
      assert.match(body, /ingested: false/);
      assert.match(body, /## User \(\d{2}:\d{2}:\d{2}\)/);
      assert.match(body, /Hello, this is a test prompt/);

      const index = await readIndex(vault);
      assert.equal(index.sessions['test-session-0010'].counters.user_prompts, 1);
      assert.equal(index.sessions['test-session-0010'].first_prompt_saved, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('filename sanitization strips path separators and control chars', async () => {
    const { root, vault } = await createVault();
    try {
      await runHook(vault, {
        session_id: 'test-session-0011',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: 'fix /foo/bar: \x00 crash "quote" \\path',
      });
      const files = await listSessionFiles(vault);
      assert.equal(files.length, 1);
      const name = files[0];
      // no slashes, backslashes, quotes, colons, or control chars
      assert.ok(!/[\/\\"<>|?*\x00-\x1f]/.test(name));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('title truncated to 50 code points preserving surrogate pairs', async () => {
    const { root, vault } = await createVault();
    try {
      const prompt = '長いタイトルのテストです'.repeat(10);
      await runHook(vault, {
        session_id: 'test-session-0012',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt,
      });
      const files = await listSessionFiles(vault);
      assert.equal(files.length, 1);
      // filename has YYYYMMDD-HHMMSS-xxxx- prefix (22 chars) + title (<=50) + .md
      // we only check that the file was created and contains UTF-8 title
      assert.match(files[0], /長いタイトル/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('ghost session: PostToolUse without prior UserPromptSubmit creates no file', async () => {
    const { root, vault } = await createVault();
    try {
      await runHook(vault, {
        session_id: 'test-session-0013',
        hook_event_name: 'PostToolUse',
        cwd: '/tmp',
        tool_name: 'Edit',
        tool_input: { file_path: '/tmp/x.js' },
      });
      let files = await listSessionFiles(vault);
      assert.equal(files.length, 0, 'no file should be created for ghost session');
      let index = await readIndex(vault);
      // ゴーストのみの状態では index.json 自体が未作成 (null) か、あっても該当 sid が無い
      assert.ok(index === null || !index.sessions || !index.sessions['test-session-0013']);

      // 同じ session_id で Stop が来ても同様
      await runHook(vault, {
        session_id: 'test-session-0013',
        hook_event_name: 'Stop',
        cwd: '/tmp',
        stop_reason: 'end_turn',
      });
      files = await listSessionFiles(vault);
      assert.equal(files.length, 0);

      // 後から UserPromptSubmit が来れば通常通りファイルが作られる
      await runHook(vault, {
        session_id: 'test-session-0013',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: 'now we have a prompt',
      });
      files = await listSessionFiles(vault);
      assert.equal(files.length, 1);
      assert.match(files[0], /now-we-have-a-prompt/);
      assert.ok(!files[0].includes('no-prompt-yet'));
      index = await readIndex(vault);
      assert.equal(index.sessions['test-session-0013'].first_prompt_saved, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('session-logger: masking', () => {
  test('masks API keys and bearer tokens in prompt', async () => {
    const { root, vault } = await createVault();
    try {
      await runHook(vault, {
        session_id: 'test-session-0020',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: 'my key is sk-ant-abcdefghijklmnopqrstuvwxyz and password=s3cret123',
      });
      const body = await readFirstSessionFile(vault);
      assert.ok(!body.includes('sk-ant-abcdefghijklmnopqrstuvwxyz'));
      assert.match(body, /sk-ant-\*\*\*/);
      assert.ok(!body.includes('s3cret123'));
      assert.match(body, /password=\*\*\*/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('masks private key blocks', async () => {
    const { root, vault } = await createVault();
    try {
      const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIBVgIBAD...\n-----END RSA PRIVATE KEY-----';
      await runHook(vault, {
        session_id: 'test-session-0021',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: `here is a key:\n${key}`,
      });
      const body = await readFirstSessionFile(vault);
      assert.ok(!body.includes('MIIBVgIBAD'));
      assert.match(body, /<PRIVATE KEY REDACTED>/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('session-logger: PostToolUse Bash blocklist', () => {
  test('blocklist-only command is skipped', async () => {
    const { root, vault } = await createVault();
    try {
      await runHook(vault, {
        session_id: 'test-session-0030',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: 'initial',
      });
      await runHook(vault, {
        session_id: 'test-session-0030',
        hook_event_name: 'PostToolUse',
        cwd: '/tmp',
        tool_name: 'Bash',
        tool_input: { command: 'ls -la | grep foo | cat' },
        tool_response: { stdout: 'skipped' },
      });
      const body = await readFirstSessionFile(vault);
      assert.ok(!body.includes('[!terminal]'));
      assert.ok(!body.includes('ls -la'));
      const index = await readIndex(vault);
      assert.equal(index.sessions['test-session-0030'].counters.bash_commands_logged, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('mixed command (one non-blocked segment) is recorded', async () => {
    const { root, vault } = await createVault();
    try {
      await runHook(vault, {
        session_id: 'test-session-0031',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: 'initial',
      });
      await runHook(vault, {
        session_id: 'test-session-0031',
        hook_event_name: 'PostToolUse',
        cwd: '/tmp',
        tool_name: 'Bash',
        tool_input: { command: 'ls && npm test' },
        tool_response: { stdout: 'all passed' },
      });
      const body = await readFirstSessionFile(vault);
      assert.match(body, /\[!terminal\]/);
      assert.match(body, /npm test/);
      assert.match(body, /all passed/);
      const index = await readIndex(vault);
      assert.equal(index.sessions['test-session-0031'].counters.bash_commands_logged, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('truncates stdout beyond 2000 chars', async () => {
    const { root, vault } = await createVault();
    try {
      await runHook(vault, {
        session_id: 'test-session-0032',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: 'init',
      });
      const big = 'X'.repeat(3000);
      await runHook(vault, {
        session_id: 'test-session-0032',
        hook_event_name: 'PostToolUse',
        cwd: '/tmp',
        tool_name: 'Bash',
        tool_input: { command: 'npm run build' },
        tool_response: { stdout: big },
      });
      const body = await readFirstSessionFile(vault);
      assert.match(body, /\(truncated\)/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('session-logger: Edit / Write / MultiEdit', () => {
  test('Edit and Write produce one-line callouts', async () => {
    const { root, vault } = await createVault();
    try {
      await runHook(vault, {
        session_id: 'test-session-0040',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: 'init',
      });
      await runHook(vault, {
        session_id: 'test-session-0040',
        hook_event_name: 'PostToolUse',
        cwd: '/tmp',
        tool_name: 'Edit',
        tool_input: { file_path: '/tmp/x.js' },
      });
      await runHook(vault, {
        session_id: 'test-session-0040',
        hook_event_name: 'PostToolUse',
        cwd: '/tmp',
        tool_name: 'Write',
        tool_input: { file_path: '/tmp/y.js' },
      });
      const body = await readFirstSessionFile(vault);
      assert.match(body, /\[!file\] Edit: \/tmp\/x\.js/);
      assert.match(body, /\[!file\] Write: \/tmp\/y\.js/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('MultiEdit includes edit count', async () => {
    const { root, vault } = await createVault();
    try {
      await runHook(vault, {
        session_id: 'test-session-0041',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: 'init',
      });
      await runHook(vault, {
        session_id: 'test-session-0041',
        hook_event_name: 'PostToolUse',
        cwd: '/tmp',
        tool_name: 'MultiEdit',
        tool_input: { file_path: '/tmp/z.js', edits: [{}, {}, {}, {}] },
      });
      const body = await readFirstSessionFile(vault);
      assert.match(body, /MultiEdit: \/tmp\/z\.js.*— 4 edits/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('session-logger: Stop handler with transcript', () => {
  test('extracts assistant text from transcript and tracks offset', async () => {
    const { root, vault } = await createVault();
    try {
      const transcript = join(root, 'transcript.jsonl');
      const lines = [
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'thinking', thinking: '...' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Hello there!' }] },
        }),
        '',
      ];
      await writeFile(transcript, lines.join('\n'), 'utf8');

      await runHook(vault, {
        session_id: 'test-session-0050',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: 'stop test',
        transcript_path: transcript,
      });
      await runHook(vault, {
        session_id: 'test-session-0050',
        hook_event_name: 'Stop',
        cwd: '/tmp',
        stop_reason: 'end_turn',
        transcript_path: transcript,
      });

      const body = await readFirstSessionFile(vault);
      assert.match(body, /## Assistant/);
      assert.match(body, /Hello there!/);

      const index = await readIndex(vault);
      const entry = index.sessions['test-session-0050'];
      assert.ok(entry.transcript_read_offset > 0);
      assert.equal(entry.counters.assistant_turns, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('second Stop only reads newly appended lines (differential)', async () => {
    const { root, vault } = await createVault();
    try {
      const transcript = join(root, 'transcript.jsonl');
      const first = JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'First reply.' }] },
      });
      await writeFile(transcript, first + '\n', 'utf8');

      await runHook(vault, {
        session_id: 'test-session-0051',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: 'diff test',
        transcript_path: transcript,
      });
      await runHook(vault, {
        session_id: 'test-session-0051',
        hook_event_name: 'Stop',
        cwd: '/tmp',
        stop_reason: 'end_turn',
        transcript_path: transcript,
      });

      const second = JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Second reply.' }] },
      });
      await appendFile(transcript, second + '\n', 'utf8');

      await runHook(vault, {
        session_id: 'test-session-0051',
        hook_event_name: 'Stop',
        cwd: '/tmp',
        stop_reason: 'end_turn',
        transcript_path: transcript,
      });

      const body = await readFirstSessionFile(vault);
      // both replies present, but first should not be duplicated
      const firstCount = (body.match(/First reply\./g) || []).length;
      const secondCount = (body.match(/Second reply\./g) || []).length;
      assert.equal(firstCount, 1);
      assert.equal(secondCount, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('transcript truncation resets offset to 0', async () => {
    const { root, vault } = await createVault();
    try {
      const transcript = join(root, 'transcript.jsonl');
      const big = JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'padding padding padding padding' }] },
      });
      await writeFile(transcript, big + '\n' + big + '\n', 'utf8');

      await runHook(vault, {
        session_id: 'test-session-0052',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: 'rotate test',
        transcript_path: transcript,
      });
      await runHook(vault, {
        session_id: 'test-session-0052',
        hook_event_name: 'Stop',
        cwd: '/tmp',
        stop_reason: 'end_turn',
        transcript_path: transcript,
      });

      // truncate (rotate)
      const tiny = JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'after rotate' }] },
      });
      await writeFile(transcript, tiny + '\n', 'utf8');

      await runHook(vault, {
        session_id: 'test-session-0052',
        hook_event_name: 'Stop',
        cwd: '/tmp',
        stop_reason: 'end_turn',
        transcript_path: transcript,
      });

      const body = await readFirstSessionFile(vault);
      assert.match(body, /after rotate/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('session-logger: SessionEnd', () => {
  test('appends session summary with counters', async () => {
    const { root, vault } = await createVault();
    try {
      await runHook(vault, {
        session_id: 'test-session-0060',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: 'a',
      });
      await runHook(vault, {
        session_id: 'test-session-0060',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: 'b',
      });
      await runHook(vault, {
        session_id: 'test-session-0060',
        hook_event_name: 'PostToolUse',
        cwd: '/tmp',
        tool_name: 'Edit',
        tool_input: { file_path: '/a.js' },
      });
      await runHook(vault, {
        session_id: 'test-session-0060',
        hook_event_name: 'SessionEnd',
        cwd: '/tmp',
        exit_reason: 'clear',
      });
      const body = await readFirstSessionFile(vault);
      assert.match(body, /## Session Summary/);
      assert.match(body, /exit_reason: clear/);
      assert.match(body, /user_prompts: 2/);
      assert.match(body, /file_edits: 1/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// R4-004: KIOKU_NO_LOG と cwd-in-vault のテスト
describe('session-logger: recursion guards', () => {
  test('KIOKU_NO_LOG=1 suppresses all output', async () => {
    const { root, vault } = await createVault();
    try {
      const p = {
        session_id: 'test-session-nolog',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'this should not be recorded',
      };
      const { code } = await runHook(vault, p, { KIOKU_NO_LOG: '1' });
      assert.strictEqual(code, 0);
      const files = await listSessionFiles(vault);
      assert.strictEqual(files.length, 0, 'no session file should be created when NO_LOG=1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('cwd inside vault suppresses logging (recursion guard)', async () => {
    const { root, vault } = await createVault();
    try {
      const p = {
        session_id: 'test-session-cwdguard',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'this should not be recorded',
      };
      const { code } = await new Promise((resolve, reject) => {
        const child = spawn('node', [HOOK_PATH], {
          env: { ...process.env, OBSIDIAN_VAULT: vault },
          cwd: vault,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.on('error', reject);
        child.on('exit', (code) => resolve({ code }));
        child.stdin.write(JSON.stringify(p));
        child.stdin.end();
      });
      assert.strictEqual(code, 0);
      const files = await listSessionFiles(vault);
      assert.strictEqual(files.length, 0, 'no session file when cwd is inside vault');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('session-logger: index corruption recovery', () => {
  test('corrupted index.json is moved aside and new one created', async () => {
    const { root, vault } = await createVault();
    try {
      const internalDir = join(vault, 'session-logs', '.claude-brain');
      await mkdir(internalDir, { recursive: true });
      await writeFile(join(internalDir, 'index.json'), 'this is not json', 'utf8');

      await runHook(vault, {
        session_id: 'test-session-0070',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: 'recover',
      });
      const index = await readIndex(vault);
      assert.ok(index);
      assert.ok(index.sessions['test-session-0070']);
      const entries = await readdir(internalDir);
      const brokenFiles = entries.filter((f) => f.startsWith('index.json.broken-'));
      assert.ok(brokenFiles.length >= 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// v0.4.0 Tier B#1 — Hook 層 re-audit findings の回帰テスト
// 参照: security-review/meeting/2026-04-21_hook-layer-reaudit.md
describe('session-logger: v0.4.0 Tier B#1 regression', () => {
  // RED-L0-01 / BLUE-L0-01: Hook 経路の maskText 適用 (INVISIBLE_CHARS + NFC)
  test('masks tokens that contain zero-width invisibles (INVISIBLE_CHARS bypass)', async () => {
    const { root, vault } = await createVault();
    try {
      // U+200B (ZWSP) を prefix 境界に挿入した API key は旧 mask() では素通りしたが、
      // maskText() は INVISIBLE_CHARS_RE で前処理するのでマッチするはず。
      const zwspKey = 'sk-ant-\u200Babcdefghijklmnopqrstuvwxyz';
      const softHyphenKey = 'ghp_\u00ADabcdefghijklmnopqrstuvwxyz';
      await runHook(vault, {
        session_id: 'test-session-b1-01',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: `zwsp=${zwspKey} soft=${softHyphenKey}`,
      });
      const body = await readFirstSessionFile(vault);
      assert.ok(!body.includes('abcdefghijklmnopqrstuvwxyz'),
        'raw 20-char suffix must not survive masking');
      assert.match(body, /sk-ant-\*\*\*/);
      assert.match(body, /ghp_\*\*\*/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // RED-L0-02: frontmatter YAML value injection
  test('buildFrontmatter neutralizes newline/--- injection in cwd', async () => {
    const { root, vault } = await createVault();
    try {
      const evilCwd = '/tmp/x\n---\ntype: injected\nrelated: ["/etc/passwd"]';
      await runHook(vault, {
        session_id: 'test-session-b1-02',
        hook_event_name: 'UserPromptSubmit',
        cwd: evilCwd,
        prompt: 'hello',
      });
      const body = await readFirstSessionFile(vault);
      // frontmatter は必ず 1 つの `---` 開始と 1 つの `---` 終端で閉じる
      const fmMatch = body.match(/^---\n([\s\S]*?)\n---\n/);
      assert.ok(fmMatch, 'frontmatter must be well-formed');
      const fm = fmMatch[1];
      // 注入された type/related キーが frontmatter に追加されていないこと
      assert.ok(!/\ntype: injected/.test(fm), 'injected `type:` key must not appear');
      assert.ok(!/\nrelated: \["\/etc\/passwd"\]/.test(fm),
        'injected `related:` key must not appear');
      // cwd は単一引用符でクオートされ、制御文字が除去された状態で残る
      assert.match(fm, /^cwd: '/m);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // BLUE-L0-02: KIOKU_NO_LOG の truthy drift 対策
  for (const truthy of ['true', 'yes', 'on', 'TRUE', 'Yes']) {
    test(`KIOKU_NO_LOG=${truthy} suppresses output (envTruthy)`, async () => {
      const { root, vault } = await createVault();
      try {
        const { code } = await runHook(vault, {
          session_id: `test-session-b1-03-${truthy.toLowerCase()}`,
          hook_event_name: 'UserPromptSubmit',
          prompt: 'should be suppressed',
        }, { KIOKU_NO_LOG: truthy });
        assert.strictEqual(code, 0);
        const files = await listSessionFiles(vault);
        assert.strictEqual(files.length, 0,
          `no session file should be created when KIOKU_NO_LOG=${truthy}`);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  test('KIOKU_NO_LOG=false or empty does NOT suppress output', async () => {
    const { root, vault } = await createVault();
    try {
      await runHook(vault, {
        session_id: 'test-session-b1-03-false',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: 'should be recorded',
      }, { KIOKU_NO_LOG: 'false' });
      const files = await listSessionFiles(vault);
      assert.strictEqual(files.length, 1,
        'falsy value must not trigger no-op (only 1/true/yes/on activate)');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
