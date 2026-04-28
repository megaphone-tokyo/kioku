// tests/hooks/session-logger.e2e.test.mjs — v0.7.0 Q2 end-to-end shim path (MF1)
//
// shim (hooks/session-logger.mjs) → claude.mjs adapter → session-logger-core.mjs
// の 3 層 import chain を一気通貫で exercise し、1 session に複数 event を順番に
// 流して出力 file の final content が期待どおりであることを verify する。
// 既存 tests/hooks/session-logger.test.mjs (ghost-session / UserPromptSubmit /
// PostToolUse 等) とは相補的で、本 file は multi-event integration snapshot に
// focus する (LEARN#6 cross-boundary drift 防止)。
//
// Test prefix: E2E-SHIM-*

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

async function createVault() {
  const root = await mkdtemp(join(tmpdir(), 'kioku-e2e-shim-test-'));
  const vault = join(root, 'vault');
  await mkdir(vault, { recursive: true });
  return { root, vault };
}

function runShim(vault, payload, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SHIM_PATH], {
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

describe('session-logger: E2E-SHIM 3-layer (shim → claude adapter → core)', () => {
  test('E2E-SHIM-1: UserPromptSubmit + PostToolUse(Bash) + SessionEnd full round-trip', async () => {
    const { root, vault } = await createVault();
    try {
      const sessionId = 'e2e-shim-0001';

      const r1 = await runShim(vault, {
        session_id: sessionId,
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp/proj',
        prompt: 'Run ls and report.',
      });
      assert.equal(r1.code, 0);

      const r2 = await runShim(vault, {
        session_id: sessionId,
        hook_event_name: 'PostToolUse',
        cwd: '/tmp/proj',
        tool_name: 'Bash',
        // 'echo' は BASH_BLOCKLIST に入っているため使わない (E2E 目的は通常 command)。
        tool_input: { command: 'git status' },
        tool_response: { stdout: 'nothing to commit\n' },
      });
      assert.equal(r2.code, 0);

      const r3 = await runShim(vault, {
        session_id: sessionId,
        hook_event_name: 'SessionEnd',
        cwd: '/tmp/proj',
        exit_reason: 'user_quit',
      });
      assert.equal(r3.code, 0);

      // 出力 file
      const files = (await readdir(join(vault, 'session-logs'))).filter((f) => f.endsWith('.md'));
      assert.equal(files.length, 1);
      const content = await readFile(join(vault, 'session-logs', files[0]), 'utf8');

      // frontmatter
      assert.match(content, /type: session-log/);
      assert.match(content, new RegExp(`session_id: ${sessionId}`));
      // User prompt section
      assert.match(content, /## User /);
      assert.match(content, /Run ls and report\./);
      // PostToolUse (Bash) section — callout syntax
      assert.match(content, /\[!terminal\]- Bash /);
      assert.match(content, />\s*git status/);
      assert.match(content, />\s*nothing to commit/);
      // Session Summary
      assert.match(content, /## Session Summary /);
      assert.match(content, /exit_reason: user_quit/);
      assert.match(content, /user_prompts: 1/);
      assert.match(content, /bash_commands_logged: 1/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('E2E-SHIM-2: ghost session (PostToolUse first) via shim — no file created', async () => {
    const { root, vault } = await createVault();
    try {
      const r = await runShim(vault, {
        session_id: 'e2e-shim-ghost',
        hook_event_name: 'PostToolUse',
        cwd: '/tmp',
        tool_name: 'Edit',
        tool_input: { file_path: '/tmp/x' },
      });
      assert.equal(r.code, 0);

      const files = await readdir(join(vault, 'session-logs')).catch(() => []);
      const mdFiles = files.filter((f) => f.endsWith('.md'));
      assert.equal(mdFiles.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('E2E-SHIM-3: Edit tool logs file path through shim path', async () => {
    const { root, vault } = await createVault();
    try {
      const sessionId = 'e2e-shim-edit';
      await runShim(vault, {
        session_id: sessionId,
        hook_event_name: 'UserPromptSubmit',
        cwd: '/tmp',
        prompt: 'edit test',
      });
      const r2 = await runShim(vault, {
        session_id: sessionId,
        hook_event_name: 'PostToolUse',
        cwd: '/tmp',
        tool_name: 'Edit',
        tool_input: { file_path: '/tmp/target.ts' },
      });
      assert.equal(r2.code, 0);

      const files = (await readdir(join(vault, 'session-logs'))).filter((f) => f.endsWith('.md'));
      assert.equal(files.length, 1);
      const content = await readFile(join(vault, 'session-logs', files[0]), 'utf8');
      assert.match(content, /\[!file\] Edit: \/tmp\/target\.ts/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
