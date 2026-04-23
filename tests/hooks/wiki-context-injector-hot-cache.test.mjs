// wiki-context-injector-hot-cache.test.mjs — v0.5.1 Phase B の hot cache 注入テスト
//
// 実行: node --test tools/claude-brain/tests/hooks/wiki-context-injector-hot-cache.test.mjs
//
// 原則:
//   - 実 Vault を触らない (mktemp -d)
//   - ネットワークなし
//   - テスト終了時に tmpdir を確実に削除
//
// ケース (plan/26042303 §Phase B Task B-2):
//   HOT-1: SessionStart で hot.md 無し → 既存動作 (index.md のみ注入)
//   HOT-2: SessionStart で hot.md あり → 両方注入 + hot.md に applyMasks 適用
//   HOT-3: PostCompact で hot.md 注入、index.md は注入されない
//   HOT-4: hot.md サイズ上限 (MAX_HOT_CHARS = 4000) 超過時 truncate + WARN log
//   HOT-5: hot.md が symlink で vault 外を指す → 拒否
//   HOT-6: applyMasks の sk-ant-* トークンが [MASKED] 相当に伏字化
//   HOT-7: KIOKU_DEBUG=1 で stderr に注入サイズ log が出る

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const INJECTOR_PATH = join(__dirname, '..', '..', 'hooks', 'wiki-context-injector.mjs');

async function createVault() {
  const root = await mkdtemp(join(tmpdir(), 'claude-brain-hot-cache-test-'));
  const vault = join(root, 'vault');
  await mkdir(join(vault, 'wiki'), { recursive: true });
  return { root, vault };
}

// hookEvent が 'SessionStart' | 'PostCompact' | undefined (event 未指定で既定 SessionStart)
function runInjector({ vault, hookEvent, stdinPayload, debug = false, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (vault) env.OBSIDIAN_VAULT = vault;
    else delete env.OBSIDIAN_VAULT;
    // env fallback 経路 (install-hooks.sh 相当) を使うケースを真似る
    if (hookEvent) env.CLAUDE_HOOK_EVENT = hookEvent;
    else delete env.CLAUDE_HOOK_EVENT;
    if (debug) env.KIOKU_DEBUG = '1';
    else delete env.KIOKU_DEBUG;

    const stdinMode = stdinPayload ? 'pipe' : 'ignore';
    const child = spawn('node', [INJECTOR_PATH], {
      env,
      cwd: cwd || process.cwd(),
      stdio: [stdinMode, 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));

    if (stdinPayload) {
      child.stdin.write(stdinPayload);
      child.stdin.end();
    }
  });
}

describe('wiki-context-injector — hot cache (v0.5.1 Phase B)', () => {
  test('HOT-1: SessionStart で hot.md 無し → 既存 index.md 動作のみ', async () => {
    const { root, vault } = await createVault();
    try {
      await writeFile(join(vault, 'wiki', 'index.md'), '# Wiki Index\n\n- [[concepts/jwt]]\n');

      const { code, stdout } = await runInjector({ vault, hookEvent: 'SessionStart' });
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
      const ctx = parsed.hookSpecificOutput.additionalContext;
      assert.match(ctx, /Wiki 目次/);
      assert.ok(!ctx.includes('ホットキャッシュ'),
        'hot.md 不在時は "ホットキャッシュ" セクションが出ないこと');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('HOT-2: SessionStart で hot.md あり → index.md + hot.md 両方注入 + applyMasks 適用', async () => {
    const { root, vault } = await createVault();
    try {
      await writeFile(join(vault, 'wiki', 'index.md'), '# Wiki Index\n');
      await writeFile(
        join(vault, 'wiki', 'hot.md'),
        '---\ntype: hot-cache\n---\n\n## Recent Context\n- working on v0.5.1 hot cache\n',
      );

      const { code, stdout } = await runInjector({ vault, hookEvent: 'SessionStart' });
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
      const ctx = parsed.hookSpecificOutput.additionalContext;
      assert.match(ctx, /Wiki 目次/);
      assert.match(ctx, /ホットキャッシュ/);
      assert.match(ctx, /working on v0\.5\.1 hot cache/);
      // v0.5.1 hotfix: hot.md section は Wiki 目次 section より前に配置される
      // (Claude Code v2 の additionalContext 末尾 truncate 対策)
      const hotIdx = ctx.indexOf('### ホットキャッシュ');
      const tocIdx = ctx.indexOf('### Wiki 目次');
      assert.ok(hotIdx > 0 && tocIdx > 0 && hotIdx < tocIdx,
        `hot.md section は Wiki 目次 section より前 (hotIdx=${hotIdx}, tocIdx=${tocIdx})`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('HOT-3: PostCompact で hot.md のみ注入 (index.md は含まれない)', async () => {
    const { root, vault } = await createVault();
    try {
      await writeFile(join(vault, 'wiki', 'index.md'), '# Wiki Index\n\n- [[concepts/jwt]]\n');
      await writeFile(
        join(vault, 'wiki', 'hot.md'),
        '---\ntype: hot-cache\n---\n\n## Recent Context\n- post-compact snapshot\n',
      );

      const { code, stdout } = await runInjector({ vault, hookEvent: 'PostCompact' });
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      // Claude Code v2 schema: PostCompact は hookSpecificOutput 非サポートのため
      // top-level systemMessage で注入 (v0.5.1 hotfix 3、2026-04-23)
      assert.ok(typeof parsed.systemMessage === 'string',
        'PostCompact は top-level systemMessage を使う');
      assert.ok(!parsed.hookSpecificOutput, 'PostCompact では hookSpecificOutput を使わない');
      const ctx = parsed.systemMessage;
      assert.match(ctx, /ホットキャッシュ \(自動注入 \/ PostCompact\)/);
      assert.match(ctx, /post-compact snapshot/);
      assert.ok(!ctx.includes('Wiki 目次'), 'PostCompact では index.md を注入しない');
      assert.ok(!ctx.includes('[[concepts/jwt]]'), 'PostCompact で index.md の目次は含まれない');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('HOT-4: hot.md サイズ上限超過時は truncate + KIOKU_DEBUG で WARN log', async () => {
    const { root, vault } = await createVault();
    try {
      await writeFile(join(vault, 'wiki', 'index.md'), '# Wiki Index\n');
      // MAX_HOT_CHARS = 4000 を超えるペイロード (5000 字)
      const huge = '---\ntype: hot-cache\n---\n\n## Recent Context\n' + 'x'.repeat(5000) + '\n';
      await writeFile(join(vault, 'wiki', 'hot.md'), huge);

      const { code, stdout, stderr } = await runInjector({
        vault,
        hookEvent: 'PostCompact',
        debug: true,
      });
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      // PostCompact は systemMessage 経路 (v0.5.1 hotfix 3)
      assert.match(parsed.systemMessage, /\.\.\. \(truncated by injector\)/);
      assert.match(stderr, /hot\.md truncated: \d+ > 4000 chars/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('HOT-5: hot.md が symlink で vault 外を指す → 拒否 (注入しない)', async () => {
    const { root, vault } = await createVault();
    try {
      await writeFile(join(vault, 'wiki', 'index.md'), '# Wiki Index\n');

      // vault 外に leak ファイルを用意
      const leakDir = join(root, 'outside');
      await mkdir(leakDir, { recursive: true });
      const leakFile = join(leakDir, 'leak.md');
      await writeFile(
        leakFile,
        '## Secret\n- ATTACKER-PAYLOAD-should-not-be-injected\n',
      );
      // wiki/hot.md を vault 外ファイルへの symlink にする
      await symlink(leakFile, join(vault, 'wiki', 'hot.md'));

      const { code, stdout, stderr } = await runInjector({
        vault,
        hookEvent: 'PostCompact',
        debug: true,
      });
      assert.equal(code, 0);
      // PostCompact で hot.md が無効なら何も出力しない
      assert.equal(stdout, '', 'vault 外 symlink は拒否、stdout 空');
      assert.match(stderr, /hot\.md resolves outside vault/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('HOT-6: applyMasks が hot.md 注入前に秘密情報パターンを伏字化', async () => {
    const { root, vault } = await createVault();
    try {
      await writeFile(join(vault, 'wiki', 'index.md'), '# Wiki Index\n');
      // 誤って漏れた Anthropic API key パターンを hot.md に仕込む
      const leakedKey = 'sk-ant-api03-0123456789abcdefghij0123456789abcdefghij';
      await writeFile(
        join(vault, 'wiki', 'hot.md'),
        `---\ntype: hot-cache\n---\n\n## Recent Context\n- leaked: ${leakedKey}\n`,
      );

      const { code, stdout } = await runInjector({ vault, hookEvent: 'PostCompact' });
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      // PostCompact は systemMessage 経路 (v0.5.1 hotfix 3)
      const ctx = parsed.systemMessage;
      assert.ok(typeof ctx === 'string', 'PostCompact は top-level systemMessage');
      assert.ok(!ctx.includes(leakedKey), 'applyMasks が raw API key を削ること');
      assert.match(ctx, /sk-ant-\*\*\*/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('HOT-7: KIOKU_DEBUG=1 で stderr に注入サイズ log を出す', async () => {
    const { root, vault } = await createVault();
    try {
      await writeFile(join(vault, 'wiki', 'index.md'), '# Wiki Index\n');
      await writeFile(
        join(vault, 'wiki', 'hot.md'),
        '---\ntype: hot-cache\n---\n\n## Recent Context\n- debug log test\n',
      );

      const ss = await runInjector({ vault, hookEvent: 'SessionStart', debug: true });
      assert.equal(ss.code, 0);
      assert.match(ss.stderr, /SessionStart: injected \d+ chars \(index=true, hot=true\)/);

      const pc = await runInjector({ vault, hookEvent: 'PostCompact', debug: true });
      assert.equal(pc.code, 0);
      assert.match(pc.stderr, /PostCompact: injected \d+ chars \(hot=\d+ chars\)/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
