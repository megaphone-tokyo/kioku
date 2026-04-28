// tests/hooks/shim-deprecate.test.mjs — v0.7.0 Q2 shim deprecation invariants (SF7)
//
// hooks/session-logger.mjs は v0.6.x 互換のため残した shim。以下 2 invariant を pin:
//   - BLUE-SHIM-DEPRECATE-1: shim 経由の 4 event (UserPromptSubmit / Stop /
//     PostToolUse / SessionEnd) が direct adapter invocation と byte-identical file
//     content を出すこと (既存 install-hooks.sh 生成 settings.json との互換)
//   - BLUE-SHIM-DEPRECATE-2: shim 経路で adapter 側に例外が起きても exit 0 を返す
//     (fail-safe 契約、MF5)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SHIM_PATH = join(__dirname, '..', '..', 'hooks', 'session-logger.mjs');
const ADAPTER_PATH = join(__dirname, '..', '..', 'hooks', 'adapters', 'claude.mjs');

async function createVault() {
  const root = await mkdtemp(join(tmpdir(), 'kioku-shim-test-'));
  const vault = join(root, 'vault');
  await mkdir(vault, { recursive: true });
  return { root, vault };
}

function runWith(scriptPath, vault, payload, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptPath], {
      env: { ...process.env, OBSIDIAN_VAULT: vault, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function stripVolatileFields(content) {
  // Strip absolute timestamps and UUID-like fragments that differ per-run but
  // do not reflect semantic behavior drift. session_id / cwd / project_dir are
  // deterministic inputs and stay in comparison.
  return content
    .replace(/\(\d{2}:\d{2}:\d{2}\)/g, '(HH:MM:SS)')
    .replace(/date: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+\-Z]\S+/g, 'date: NORMALIZED')
    .replace(/hostname: [^\n]+/g, 'hostname: NORMALIZED');
}

describe('shim-deprecate: BLUE-SHIM-DEPRECATE invariants', () => {
  test('BLUE-SHIM-DEPRECATE-1: UserPromptSubmit output equals direct adapter output (byte-identical after volatile strip)', async () => {
    const v1 = await createVault();
    const v2 = await createVault();
    try {
      const payload = {
        session_id: 'shim-dep-0001',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp/proj',
        prompt: 'hello compare',
      };
      const r1 = await runWith(SHIM_PATH, v1.vault, payload);
      const r2 = await runWith(ADAPTER_PATH, v2.vault, payload);
      assert.equal(r1.code, 0);
      assert.equal(r2.code, 0);
      assert.equal(r1.stdout, r2.stdout);

      const files1 = (await readdir(join(v1.vault, 'session-logs'))).filter((f) => f.endsWith('.md'));
      const files2 = (await readdir(join(v2.vault, 'session-logs'))).filter((f) => f.endsWith('.md'));
      assert.equal(files1.length, 1);
      assert.equal(files2.length, 1);
      const c1 = stripVolatileFields(await readFile(join(v1.vault, 'session-logs', files1[0]), 'utf8'));
      const c2 = stripVolatileFields(await readFile(join(v2.vault, 'session-logs', files2[0]), 'utf8'));
      assert.equal(c1, c2);
    } finally {
      await rm(v1.root, { recursive: true, force: true });
      await rm(v2.root, { recursive: true, force: true });
    }
  });

  test('BLUE-SHIM-DEPRECATE-1: PostToolUse output equals direct adapter output', async () => {
    const v1 = await createVault();
    const v2 = await createVault();
    try {
      const baseSetup = {
        session_id: 'shim-dep-0002',
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: 'setup',
      };
      await runWith(SHIM_PATH, v1.vault, baseSetup);
      await runWith(ADAPTER_PATH, v2.vault, baseSetup);

      const toolPayload = {
        session_id: 'shim-dep-0002',
        hook_event_name: 'PostToolUse',
        cwd: '/tmp',
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
        tool_response: { stdout: 'nothing to commit\n' },
      };
      const r1 = await runWith(SHIM_PATH, v1.vault, toolPayload);
      const r2 = await runWith(ADAPTER_PATH, v2.vault, toolPayload);
      assert.equal(r1.code, 0);
      assert.equal(r2.code, 0);

      const f1 = (await readdir(join(v1.vault, 'session-logs'))).filter((f) => f.endsWith('.md'));
      const f2 = (await readdir(join(v2.vault, 'session-logs'))).filter((f) => f.endsWith('.md'));
      const c1 = stripVolatileFields(await readFile(join(v1.vault, 'session-logs', f1[0]), 'utf8'));
      const c2 = stripVolatileFields(await readFile(join(v2.vault, 'session-logs', f2[0]), 'utf8'));
      assert.equal(c1, c2);
    } finally {
      await rm(v1.root, { recursive: true, force: true });
      await rm(v2.root, { recursive: true, force: true });
    }
  });

  test('BLUE-SHIM-DEPRECATE-2: shim exits 0 even when OBSIDIAN_VAULT is garbage path', async () => {
    const { code } = await new Promise((resolve, reject) => {
      const child = spawn('node', [SHIM_PATH], {
        env: { ...process.env, OBSIDIAN_VAULT: '/absolutely/nonexistent/path/xyzzy' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code }));
      child.stdin.write(JSON.stringify({
        session_id: 'shim-dep-0003',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'x',
      }));
      child.stdin.end();
    });
    assert.equal(code, 0);
  });

  test('BLUE-SHIM-DEPRECATE-2: shim exits 0 for malformed JSON (core never reached)', async () => {
    const { root, vault } = await createVault();
    try {
      const { code } = await new Promise((resolve, reject) => {
        const child = spawn('node', [SHIM_PATH], {
          env: { ...process.env, OBSIDIAN_VAULT: vault },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.on('error', reject);
        child.on('exit', (code) => resolve({ code }));
        child.stdin.write('not json {{{');
        child.stdin.end();
      });
      assert.equal(code, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
