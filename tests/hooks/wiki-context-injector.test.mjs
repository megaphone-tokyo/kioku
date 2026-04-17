// wiki-context-injector.test.mjs — hooks/wiki-context-injector.mjs のユニットテスト
//
// 実行: node --test tools/claude-brain/tests/hooks/wiki-context-injector.test.mjs
//
// 原則:
//   - 実 Vault を触らない (mktemp -d)
//   - ネットワークなし
//   - テスト終了時に tmpdir を確実に削除
//
// ケース: Phase H テストケース H1-H5
//   H1: index.md 存在 → additionalContext に目次が含まれた JSON を stdout 出力
//   H2: index.md 不在 → 何も出力せず exit 0
//   H3: OBSIDIAN_VAULT 未設定 → exit 0
//   H4: index.md が 10,000 文字超 → Hook 側は全文出力 (打ち切りは Claude Code 側)
//   H5: 出力 JSON が valid (JSON.parse 成功)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const INJECTOR_PATH = join(__dirname, '..', '..', 'hooks', 'wiki-context-injector.mjs');

async function createVault() {
  const root = await mkdtemp(join(tmpdir(), 'claude-brain-injector-test-'));
  const vault = join(root, 'vault');
  await mkdir(join(vault, 'wiki'), { recursive: true });
  return { root, vault };
}

function runInjector({ vault, cwd, unsetVault = false } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (unsetVault) {
      delete env.OBSIDIAN_VAULT;
    } else if (vault) {
      env.OBSIDIAN_VAULT = vault;
    }
    const child = spawn('node', [INJECTOR_PATH], {
      env,
      cwd: cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('wiki-context-injector', () => {
  test('H1: index.md が存在すれば additionalContext に目次を含む JSON を出力する', async () => {
    const { root, vault } = await createVault();
    try {
      const indexBody = '# Wiki Index\n\n- [[concepts/jwt-authentication]]\n- [[projects/my-saas-app]]\n';
      await writeFile(join(vault, 'wiki', 'index.md'), indexBody);

      const fakeProjectCwd = join(root, 'my-project');
      await mkdir(fakeProjectCwd, { recursive: true });
      const { code, stdout } = await runInjector({ vault, cwd: fakeProjectCwd });

      assert.equal(code, 0, 'exit code 0');
      assert.ok(stdout.length > 0, 'stdout に出力あり');
      const parsed = JSON.parse(stdout);
      assert.ok(typeof parsed.additionalContext === 'string');
      assert.match(parsed.additionalContext, /ナレッジベース/);
      assert.match(parsed.additionalContext, /Wiki 目次/);
      assert.ok(
        parsed.additionalContext.includes(indexBody),
        'additionalContext に index.md 本文が含まれる'
      );
      assert.match(parsed.additionalContext, /現在のプロジェクト: my-project/);
      assert.ok(parsed.additionalContext.includes('$OBSIDIAN_VAULT/wiki/'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('H2: index.md が存在しなければ何も出力せず exit 0', async () => {
    const { root, vault } = await createVault();
    try {
      const { code, stdout } = await runInjector({ vault });
      assert.equal(code, 0);
      assert.equal(stdout, '');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('H3: OBSIDIAN_VAULT が未設定なら exit 0 で何も出力しない', async () => {
    const { code, stdout } = await runInjector({ unsetVault: true });
    assert.equal(code, 0);
    assert.equal(stdout, '');
  });

  test('H4: index.md が 10,000 文字を超えても Hook 側は全文出力する (打ち切りは Claude Code 側)', async () => {
    const { root, vault } = await createVault();
    try {
      const huge = '# Huge Index\n\n' + '- ' + 'x'.repeat(12000) + '\n';
      await writeFile(join(vault, 'wiki', 'index.md'), huge);

      const { code, stdout } = await runInjector({ vault });
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.ok(
        parsed.additionalContext.length > 10000,
        'Hook 側は切り詰めない (10KB 上限は Claude Code 側の責務)'
      );
      assert.ok(parsed.additionalContext.includes(huge));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('H5: 出力は valid JSON として parse できる', async () => {
    const { root, vault } = await createVault();
    try {
      await writeFile(join(vault, 'wiki', 'index.md'), '# Index\n\n特殊文字: "quote" \\ \n タブ\t 改行\n');
      const { code, stdout } = await runInjector({ vault });
      assert.equal(code, 0);
      assert.doesNotThrow(() => JSON.parse(stdout));
      const parsed = JSON.parse(stdout);
      assert.ok(typeof parsed.additionalContext === 'string');
      assert.ok(parsed.additionalContext.includes('"quote"'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
