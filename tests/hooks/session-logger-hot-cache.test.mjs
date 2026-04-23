// session-logger-hot-cache.test.mjs — v0.5.1 Phase B の Stop hook opt-in prompt テスト
//
// 実行: node --test tools/claude-brain/tests/hooks/session-logger-hot-cache.test.mjs
//
// 原則:
//   - 実 Vault を触らない (mktemp -d)
//   - ネットワークなし
//   - テスト終了時に tmpdir を確実に削除
//
// ケース (plan/26042303 §Phase B Task B-4):
//   HOT-8: KIOKU_HOT_AUTO_PROMPT 未設定 (default opt-out) → Stop 時 stdout 空
//   HOT-9: KIOKU_HOT_AUTO_PROMPT=1 (opt-in) → Stop 時 systemMessage JSON 出力
//
// 仕様理由 (26042304 meeting §3.1 高橋 指摘):
//   hot.md は Git sync 対象で session-logs より boundary が厳しい。自動 prompt
//   は user の明示 opt-in のみ発動し、default では何も出さない (fail-safe).
//
// Claude Code v2 schema 注意 (hotfix 4、2026-04-23):
//   Stop event は hookSpecificOutput の 3 event サポートリストに含まれず、v1 flat
//   `{additionalContext}` は Claude Code v2 CLI で silent 無効化される。
//   PostCompact (hotfix 3) と同じく top-level `systemMessage` に揃えた。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HOOK_PATH = join(__dirname, '..', '..', 'hooks', 'session-logger.mjs');

async function createVault() {
  const root = await mkdtemp(join(tmpdir(), 'claude-brain-stop-hotopt-'));
  const vault = join(root, 'vault');
  await mkdir(vault, { recursive: true });
  return { root, vault };
}

// runHook with stdout capture (既存 session-logger.test.mjs の runHook は stdout を
// 捨てるため、opt-in prompt を検証する本 test では独自 runner を使う)
function runHook(vault, payload, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      OBSIDIAN_VAULT: vault,
      ...extraEnv,
    };
    // 親 process で KIOKU_HOT_AUTO_PROMPT が set されていても、test ごとに
    // 明示制御したいので未指定 = 未設定にする
    if (!Object.prototype.hasOwnProperty.call(extraEnv, 'KIOKU_HOT_AUTO_PROMPT')) {
      delete env.KIOKU_HOT_AUTO_PROMPT;
    }
    const child = spawn('node', [HOOK_PATH], {
      env,
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

async function seedSession(vault, sessionId, prompt = 'hot cache opt-in test') {
  // UserPromptSubmit でセッション file を作る (ghost 抑止のため必須).
  // prompt は file 名 の title 部分に使われるため、同秒に複数 seed すると
  // sid4 (session_id 先頭 4 文字) が共有された場合に `flag: 'wx'` の EEXIST で
  // entry 作成が失敗する。ループ test では prompt を unique にする必要がある。
  return runHook(vault, {
    session_id: sessionId,
    hook_event_name: 'UserPromptSubmit',
    cwd: '/tmp',
    prompt,
  });
}

async function writeTranscript(root, lines) {
  const transcript = join(root, 'transcript.jsonl');
  await writeFile(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return transcript;
}

describe('session-logger — Stop hook hot cache opt-in prompt (v0.5.1 Phase B)', () => {
  test('HOT-8: default (KIOKU_HOT_AUTO_PROMPT 未設定) → Stop 時 stdout 空 (opt-out 既定)', async () => {
    const { root, vault } = await createVault();
    try {
      const sid = 'test-session-hot8';
      await seedSession(vault, sid);

      const transcript = await writeTranscript(root, [
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        },
      ]);

      const { code, stdout } = await runHook(vault, {
        session_id: sid,
        hook_event_name: 'Stop',
        cwd: '/tmp',
        transcript_path: transcript,
      });

      assert.equal(code, 0);
      assert.equal(stdout, '', 'default opt-out で stdout に additionalContext が出ないこと');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('HOT-9: KIOKU_HOT_AUTO_PROMPT=1 → Stop 時 systemMessage JSON に hot.md 更新提案を含む (v2 schema)', async () => {
    const { root, vault } = await createVault();
    try {
      const sid = 'test-session-hot9';
      await seedSession(vault, sid);

      const transcript = await writeTranscript(root, [
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        },
      ]);

      const { code, stdout } = await runHook(
        vault,
        {
          session_id: sid,
          hook_event_name: 'Stop',
          cwd: '/tmp',
          transcript_path: transcript,
        },
        { KIOKU_HOT_AUTO_PROMPT: '1' },
      );

      assert.equal(code, 0);
      assert.ok(stdout.length > 0, 'opt-in で stdout に出力があること');
      const parsed = JSON.parse(stdout);
      // Claude Code v2 schema: Stop は hookSpecificOutput 非サポートのため top-level systemMessage
      assert.ok(typeof parsed.systemMessage === 'string', 'v2 は top-level systemMessage を使う');
      assert.ok(!parsed.additionalContext, 'v1 flat additionalContext は使わない (silent 無効化対策)');
      assert.match(parsed.systemMessage, /ホットキャッシュ更新/);
      assert.match(parsed.systemMessage, /wiki\/hot\.md/);
      assert.match(parsed.systemMessage, /秘密情報/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('HOT-9b: truthy 値 "true" / "yes" / "on" でも opt-in 発火 (fail-safe)', async () => {
    const { root, vault } = await createVault();
    try {
      const values = ['true', 'yes', 'on', 'TRUE'];
      for (let i = 0; i < values.length; i += 1) {
        const v = values[i];
        const sid = `test-session-hot9b-${i}`; // index-based で collision 防止
        await seedSession(vault, sid, `hot9b-seed-${i}`); // prompt も unique にして fileName 衝突回避
        const transcript = await writeTranscript(root, [
          {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
          },
        ]);
        const { code, stdout } = await runHook(
          vault,
          {
            session_id: sid,
            hook_event_name: 'Stop',
            cwd: '/tmp',
            transcript_path: transcript,
          },
          { KIOKU_HOT_AUTO_PROMPT: v },
        );
        assert.equal(code, 0, `value="${v}" exit 0`);
        assert.ok(stdout.length > 0, `value="${v}" stdout prompt 出力あり`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('HOT-9c: falsy 値 "0" / "false" / "" では prompt 出さない', async () => {
    const { root, vault } = await createVault();
    try {
      const values = ['0', 'false', '', 'no'];
      for (let i = 0; i < values.length; i += 1) {
        const v = values[i];
        const sid = `test-session-hot9c-${i}`; // index-based で collision 防止
        await seedSession(vault, sid, `hot9c-seed-${i}`); // prompt も unique にして fileName 衝突回避
        const transcript = await writeTranscript(root, [
          {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'y' }] },
          },
        ]);
        const { code, stdout } = await runHook(
          vault,
          {
            session_id: sid,
            hook_event_name: 'Stop',
            cwd: '/tmp',
            transcript_path: transcript,
          },
          { KIOKU_HOT_AUTO_PROMPT: v },
        );
        assert.equal(code, 0, `value="${v}" exit 0`);
        assert.equal(stdout, '', `value="${v}" stdout 空 (opt-out)`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('HOT-9d: KIOKU_HOT_AUTO_PROMPT が child-env ENV_ALLOW_EXACT に登録されている (parity 検証)', async () => {
    const { ENV_ALLOW_EXACT } = await import('../../mcp/lib/child-env.mjs');
    assert.ok(
      ENV_ALLOW_EXACT.has('KIOKU_HOT_AUTO_PROMPT'),
      'KIOKU_HOT_AUTO_PROMPT が mcp/lib/child-env.mjs の ENV_ALLOW_EXACT に追加されていること',
    );
  });
});
