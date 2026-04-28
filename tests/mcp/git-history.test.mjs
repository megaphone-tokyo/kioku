// git-history.test.mjs — lib/git-history.mjs のユニットテスト (Phase D α V-1 + V-2 hotfix)
//
// 実行: node --test tools/claude-brain/tests/mcp/git-history.test.mjs
//
// 方針:
//   - 実 Vault に触らない (mktemp -d で fixture git repo を作る)
//   - ネットワークなし
//   - trap 相当で tmpdir クリーンアップ
//   - spawn-based git 呼び出しを実機 git で検証 (git 未インストール環境では skip)
//
// 既存ケース (VIZ-GH-1 〜 8) + V-2 hotfix 新規 (VIZ-GH-9 〜 14):
//   VIZ-GH-1:  非 git dir で isGitRepo() === false
//   VIZ-GH-2:  git init 直後の isGitRepo() === true
//   VIZ-GH-3:  commit 履歴を getFileHistory() が時系列で返す (H3 新 shape)
//   VIZ-GH-4:  subPath filter が機能する
//   VIZ-GH-5:  getFileContentAtCommit() で過去 commit の内容取得、不在は null
//   VIZ-GH-6:  listFilesAtCommit() が指定 commit の md file を列挙 (H3 新 shape)
//   VIZ-GH-7:  invalid sha は throw
//   VIZ-GH-8:  parseGitLogOutput unit (KIOKU sentinel + NUL separator)
//   VIZ-GH-9:  H3 observability — 非 git dir で error='not_a_git_repo'
//   VIZ-GH-10: H2 revspec injection — ':' / '..' / 絶対 path は throw
//   VIZ-GH-11: BLUE-NEW H1 — 悪意ある .git/config の fsmonitor が fire しない
//   VIZ-GH-12: M5 SHA-256 (64 hex) を sha validator が受理
//   VIZ-GH-13: M6 日本語 filename が -z で正しく parse される
//   VIZ-GH-14: M4 allowedPrefixes 違反で getFileContentAtCommit が throw

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isGitRepo,
  getFileHistory,
  getFileContentAtCommit,
  listFilesAtCommit,
  parseGitLogOutput,
} from '../../mcp/lib/git-history.mjs';

// helper: spawn で git コマンドを実行して exit code 0 を待つ
function runCmd(cwd, cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`));
    });
  });
}

// git が PATH に無い環境での早期 skip 判定
async function hasGit() {
  return new Promise((resolve) => {
    const child = spawn('git', ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function makeFixtureRepo() {
  const root = await mkdtemp(join(tmpdir(), 'kioku-git-history-test-'));
  await runCmd(root, 'git', ['init', '-b', 'main']);
  await runCmd(root, 'git', ['config', 'user.email', 'test@example.com']);
  await runCmd(root, 'git', ['config', 'user.name', 'Test User']);
  return root;
}

describe('git-history (Phase D α V-1 + V-2 hotfix)', () => {
  let gitAvailable = true;

  before(async () => {
    gitAvailable = await hasGit();
  });

  test('VIZ-GH-1: 非 git dir で isGitRepo() === false', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(join(tmpdir(), 'kioku-git-nongit-'));
    try {
      const ok = await isGitRepo(root);
      assert.equal(ok, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('VIZ-GH-2: git init 後の isGitRepo() === true', async () => {
    if (!gitAvailable) return;
    const root = await makeFixtureRepo();
    try {
      const ok = await isGitRepo(root);
      assert.equal(ok, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('VIZ-GH-3: commit 履歴が時系列で返る (新しい順、H3 新 shape)', async () => {
    if (!gitAvailable) return;
    const root = await makeFixtureRepo();
    try {
      await mkdir(join(root, 'wiki'), { recursive: true });
      await writeFile(join(root, 'wiki', 'a.md'), '# A\n');
      await runCmd(root, 'git', ['add', '-A']);
      await runCmd(root, 'git', ['commit', '-m', 'first']);

      await new Promise((r) => setTimeout(r, 1100));
      await writeFile(join(root, 'wiki', 'b.md'), '# B\n');
      await runCmd(root, 'git', ['add', '-A']);
      await runCmd(root, 'git', ['commit', '-m', 'second']);

      const res = await getFileHistory(root, { subPath: 'wiki/' });
      // H3: 新 shape { commits, truncated, error }
      assert.equal(res.error, null);
      assert.equal(res.truncated, false);
      assert.equal(res.commits.length, 2);
      // 新しい順 (second が先頭)
      assert.equal(res.commits[0].subject, 'second');
      assert.equal(res.commits[1].subject, 'first');
      // timestamp 降順
      assert.ok(res.commits[0].timestamp >= res.commits[1].timestamp);
      // files 配列に touched file が入る
      assert.ok(res.commits[0].files.includes('wiki/b.md'));
      assert.ok(res.commits[1].files.includes('wiki/a.md'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('VIZ-GH-4: subPath filter — 非 wiki/ commit は除外', async () => {
    if (!gitAvailable) return;
    const root = await makeFixtureRepo();
    try {
      await mkdir(join(root, 'wiki'), { recursive: true });
      await mkdir(join(root, 'other'), { recursive: true });
      await writeFile(join(root, 'wiki', 'x.md'), '# X\n');
      await runCmd(root, 'git', ['add', '-A']);
      await runCmd(root, 'git', ['commit', '-m', 'wiki change']);

      await new Promise((r) => setTimeout(r, 1100));
      await writeFile(join(root, 'other', 'y.md'), '# Y\n');
      await runCmd(root, 'git', ['add', '-A']);
      await runCmd(root, 'git', ['commit', '-m', 'other change']);

      const { commits } = await getFileHistory(root, { subPath: 'wiki/' });
      assert.equal(commits.length, 1);
      assert.equal(commits[0].subject, 'wiki change');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('VIZ-GH-5: getFileContentAtCommit() — 過去 commit の内容取得、不在は null', async () => {
    if (!gitAvailable) return;
    const root = await makeFixtureRepo();
    try {
      await mkdir(join(root, 'wiki'), { recursive: true });
      await writeFile(join(root, 'wiki', 'hot.md'), '# Version 1\n');
      await runCmd(root, 'git', ['add', '-A']);
      await runCmd(root, 'git', ['commit', '-m', 'v1']);
      const { commits: commits1 } = await getFileHistory(root, { subPath: 'wiki/' });
      const v1sha = commits1[0].sha;

      await new Promise((r) => setTimeout(r, 1100));
      await writeFile(join(root, 'wiki', 'hot.md'), '# Version 2\n');
      await runCmd(root, 'git', ['add', '-A']);
      await runCmd(root, 'git', ['commit', '-m', 'v2']);
      const { commits: commits2 } = await getFileHistory(root, { subPath: 'wiki/' });
      const v2sha = commits2[0].sha;

      const v1 = await getFileContentAtCommit(root, v1sha, 'wiki/hot.md');
      assert.match(v1, /Version 1/);

      const v2 = await getFileContentAtCommit(root, v2sha, 'wiki/hot.md');
      assert.match(v2, /Version 2/);

      // 不在 file → null
      const nada = await getFileContentAtCommit(root, v1sha, 'wiki/does-not-exist.md');
      assert.equal(nada, null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('VIZ-GH-6: listFilesAtCommit() — 指定 commit の file 列挙 (H3 新 shape)', async () => {
    if (!gitAvailable) return;
    const root = await makeFixtureRepo();
    try {
      await mkdir(join(root, 'wiki', 'concepts'), { recursive: true });
      await writeFile(join(root, 'wiki', 'index.md'), '# Index\n');
      await writeFile(join(root, 'wiki', 'concepts', 'jwt.md'), '# JWT\n');
      await writeFile(join(root, 'wiki', 'concepts', 'oauth.md'), '# OAuth\n');
      await writeFile(join(root, 'wiki', 'image.png'), 'binary\n'); // 非 md
      await runCmd(root, 'git', ['add', '-A']);
      await runCmd(root, 'git', ['commit', '-m', 'init']);
      const { commits } = await getFileHistory(root, { subPath: 'wiki/' });
      const sha = commits[0].sha;

      const listing = await listFilesAtCommit(root, sha, { subPath: 'wiki/' });
      assert.equal(listing.error, null);
      assert.equal(listing.truncated, false);
      assert.ok(listing.files.includes('wiki/index.md'));
      assert.ok(listing.files.includes('wiki/concepts/jwt.md'));
      assert.ok(listing.files.includes('wiki/concepts/oauth.md'));
      assert.ok(listing.files.includes('wiki/image.png'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('VIZ-GH-7: invalid sha は throw', async () => {
    await assert.rejects(
      () => getFileContentAtCommit('/tmp', 'not-a-sha', 'wiki/x.md'),
      /invalid sha/,
    );
    await assert.rejects(
      () => listFilesAtCommit('/tmp', 'xyz!!!', { subPath: 'wiki/' }),
      /invalid sha/,
    );
  });

  test('VIZ-GH-8: parseGitLogOutput unit (KIOKU sentinel + NUL separator + \\n file prefix)', () => {
    // actual git format: KIOKU\x01<sha>\x01<short>\x01<ct>\x01<author>\x01<subject>\0\n<file>\0<file>\0
    const stdout =
      'KIOKU\x01abc123def456\x01abc123d\x011700000000\x01Alice\x01first commit\0\nwiki/a.md\0wiki/b.md\0'
      + 'KIOKU\x01feed1234\x01feed123\x011700000100\x01Bob\x01second commit\0\nwiki/c.md\0';
    const commits = parseGitLogOutput(stdout);
    assert.equal(commits.length, 2);
    assert.equal(commits[0].sha, 'abc123def456');
    assert.equal(commits[0].shortSha, 'abc123d');
    assert.equal(commits[0].timestamp, 1700000000 * 1000);
    assert.equal(commits[0].author, 'Alice');
    assert.equal(commits[0].subject, 'first commit');
    assert.deepEqual(commits[0].files, ['wiki/a.md', 'wiki/b.md']);
    assert.equal(commits[1].sha, 'feed1234');
    assert.deepEqual(commits[1].files, ['wiki/c.md']);
  });

  test('VIZ-GH-9: H3 observability — 非 git dir で error=not_a_git_repo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kioku-git-nonrepo-'));
    try {
      const res = await getFileHistory(root, { subPath: 'wiki/' });
      assert.deepEqual(res.commits, []);
      assert.equal(res.truncated, false);
      assert.equal(res.error, 'not_a_git_repo');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('VIZ-GH-10: H2 revspec injection — ":" / ".." / 絶対 path は throw', async () => {
    if (!gitAvailable) return;
    const root = await makeFixtureRepo();
    try {
      // 空 wiki 作成して valid sha を得る
      await mkdir(join(root, 'wiki'), { recursive: true });
      await writeFile(join(root, 'wiki', 'a.md'), '# A\n');
      await runCmd(root, 'git', ['add', '-A']);
      await runCmd(root, 'git', ['commit', '-m', 'init']);
      const { commits } = await getFileHistory(root, { subPath: 'wiki/' });
      const sha = commits[0].sha;

      // revspec injection 候補
      await assert.rejects(
        () => getFileContentAtCommit(root, sha, 'wiki/a:evil.md'),
        /invalid relPath/,
      );
      await assert.rejects(
        () => getFileContentAtCommit(root, sha, '../etc/passwd'),
        /invalid relPath/,
      );
      await assert.rejects(
        () => getFileContentAtCommit(root, sha, '/etc/passwd'),
        /invalid relPath/,
      );
      // subPath also validated
      await assert.rejects(
        () => listFilesAtCommit(root, sha, { subPath: 'wiki/..' }),
        /invalid subPath/,
      );
      await assert.rejects(
        () => getFileHistory(root, { subPath: '..evil' }),
        /invalid subPath/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('VIZ-GH-11: BLUE-NEW H1 — 悪意ある .git/config fsmonitor が fire しない', async () => {
    if (!gitAvailable) return;
    const root = await makeFixtureRepo();
    const canary = join(root, 'fsmonitor-canary.txt');
    try {
      await writeFile(join(root, 'wiki.md'), '# test\n');
      await runCmd(root, 'git', ['add', '-A']);
      await runCmd(root, 'git', ['commit', '-m', 'init']);

      // vault の .git/config に fsmonitor 罠を仕込む
      const gitConfigPath = join(root, '.git', 'config');
      const originalConfig = await readFile(gitConfigPath, 'utf8');
      const maliciousHookPath = join(root, '.git', 'malicious-hook.sh');
      // hook が本当に fire されたら canary file を作るようにする (POSIX shell 依存を避け、シンプルな touch)
      await writeFile(maliciousHookPath, `#!/bin/sh\ntouch "${canary}"\necho ok\n`, { mode: 0o755 });
      await writeFile(
        gitConfigPath,
        `${originalConfig}\n[core]\n\tfsmonitor = ${maliciousHookPath}\n`,
      );

      // getFileHistory 呼び出し後に canary が存在しないことを確認
      await getFileHistory(root, { subPath: '' });

      let canaryCreated = true;
      try {
        await stat(canary);
      } catch {
        canaryCreated = false;
      }
      assert.equal(canaryCreated, false, 'fsmonitor hook fired despite SAFE_CONFIG');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('VIZ-GH-12: M5 SHA-256 (64 hex) を sha validator が受理', async () => {
    // 仮の 64 hex sha (実際の repo では使わないが validator の shape を確認)
    const sha256 = 'a'.repeat(64);
    // 非存在 repo で呼んでも sha validation は通る → エラーは git exit non-zero で null 返却
    await assert.doesNotReject(async () => {
      await getFileContentAtCommit('/tmp', sha256, 'wiki/x.md');
    });
    // 65 hex は reject
    await assert.rejects(
      () => getFileContentAtCommit('/tmp', 'a'.repeat(65), 'wiki/x.md'),
      /invalid sha/,
    );
  });

  test('VIZ-GH-13: M6 日本語 filename が -z で正しく parse', async () => {
    if (!gitAvailable) return;
    const root = await makeFixtureRepo();
    try {
      await mkdir(join(root, 'wiki'), { recursive: true });
      await writeFile(join(root, 'wiki', '日本語ファイル.md'), '# 日本語\n');
      await writeFile(join(root, 'wiki', 'ひらがな.md'), '# ひらがな\n');
      await runCmd(root, 'git', ['add', '-A']);
      await runCmd(root, 'git', ['commit', '-m', '日本語コミット']);

      const { commits } = await getFileHistory(root, { subPath: 'wiki/' });
      assert.equal(commits.length, 1);
      assert.equal(commits[0].subject, '日本語コミット');
      assert.ok(commits[0].files.includes('wiki/日本語ファイル.md'));
      assert.ok(commits[0].files.includes('wiki/ひらがな.md'));

      const listing = await listFilesAtCommit(root, commits[0].sha, { subPath: 'wiki/' });
      assert.ok(listing.files.includes('wiki/日本語ファイル.md'));
      assert.ok(listing.files.includes('wiki/ひらがな.md'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('VIZ-GH-14: M4 allowedPrefixes 違反で throw', async () => {
    if (!gitAvailable) return;
    const root = await makeFixtureRepo();
    try {
      await mkdir(join(root, 'wiki'), { recursive: true });
      await mkdir(join(root, 'raw-sources'), { recursive: true });
      await writeFile(join(root, 'wiki', 'a.md'), '# A\n');
      await writeFile(join(root, 'raw-sources', 'b.md'), '# B\n');
      await runCmd(root, 'git', ['add', '-A']);
      await runCmd(root, 'git', ['commit', '-m', 'init']);
      const { commits } = await getFileHistory(root);
      const sha = commits[0].sha;

      // allowedPrefixes='wiki/' で wiki 配下は OK
      const ok = await getFileContentAtCommit(root, sha, 'wiki/a.md', {
        allowedPrefixes: ['wiki/'],
      });
      assert.match(ok, /# A/);

      // raw-sources/ は reject
      await assert.rejects(
        () => getFileContentAtCommit(root, sha, 'raw-sources/b.md', { allowedPrefixes: ['wiki/'] }),
        /relPath must start with/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
