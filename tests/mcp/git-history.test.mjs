// git-history.test.mjs — lib/git-history.mjs のユニットテスト (Phase D α V-1)
//
// 実行: node --test tools/claude-brain/tests/mcp/git-history.test.mjs
//
// 方針:
//   - 実 Vault に触らない (mktemp -d で fixture git repo を作る)
//   - ネットワークなし
//   - trap 相当で tmpdir クリーンアップ
//   - spawn-based git 呼び出しを実機 git で検証 (git 未インストール環境では skip)
//
// ケース (VIZ-GH-1 〜 6):
//   VIZ-GH-1: 非 git dir で isGitRepo() === false
//   VIZ-GH-2: git init 直後の isGitRepo() === true
//   VIZ-GH-3: commit 履歴を getFileHistory() が時系列で返す
//   VIZ-GH-4: subPath filter が機能する (wiki/ 限定で一部 commit のみ)
//   VIZ-GH-5: getFileContentAtCommit() で過去 commit の内容取得、不在は null
//   VIZ-GH-6: listFilesAtCommit() が指定 commit の md file を列挙

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
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

describe('git-history (Phase D α V-1)', () => {
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

  test('VIZ-GH-3: commit 履歴が時系列で返る (新しい順)', async () => {
    if (!gitAvailable) return;
    const root = await makeFixtureRepo();
    try {
      await mkdir(join(root, 'wiki'), { recursive: true });
      await writeFile(join(root, 'wiki', 'a.md'), '# A\n');
      await runCmd(root, 'git', ['add', '-A']);
      await runCmd(root, 'git', ['commit', '-m', 'first']);

      await new Promise((r) => setTimeout(r, 1100)); // 1s 以上空けて commit 時刻を差別化
      await writeFile(join(root, 'wiki', 'b.md'), '# B\n');
      await runCmd(root, 'git', ['add', '-A']);
      await runCmd(root, 'git', ['commit', '-m', 'second']);

      const commits = await getFileHistory(root, { subPath: 'wiki/' });
      assert.equal(commits.length, 2);
      // 新しい順 (second が先頭)
      assert.equal(commits[0].subject, 'second');
      assert.equal(commits[1].subject, 'first');
      // timestamp 降順
      assert.ok(commits[0].timestamp >= commits[1].timestamp);
      // files 配列に touched file が入る
      assert.ok(commits[0].files.includes('wiki/b.md'));
      assert.ok(commits[1].files.includes('wiki/a.md'));
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

      const commits = await getFileHistory(root, { subPath: 'wiki/' });
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
      const commits1 = await getFileHistory(root, { subPath: 'wiki/' });
      const v1sha = commits1[0].sha;

      await new Promise((r) => setTimeout(r, 1100));
      await writeFile(join(root, 'wiki', 'hot.md'), '# Version 2\n');
      await runCmd(root, 'git', ['add', '-A']);
      await runCmd(root, 'git', ['commit', '-m', 'v2']);
      const commits2 = await getFileHistory(root, { subPath: 'wiki/' });
      const v2sha = commits2[0].sha;

      // v1 時点の内容取得
      const v1 = await getFileContentAtCommit(root, v1sha, 'wiki/hot.md');
      assert.match(v1, /Version 1/);

      // v2 時点の内容取得
      const v2 = await getFileContentAtCommit(root, v2sha, 'wiki/hot.md');
      assert.match(v2, /Version 2/);

      // 不在 file → null
      const nada = await getFileContentAtCommit(root, v1sha, 'wiki/does-not-exist.md');
      assert.equal(nada, null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('VIZ-GH-6: listFilesAtCommit() — 指定 commit の md 列挙', async () => {
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
      const commits = await getFileHistory(root, { subPath: 'wiki/' });
      const sha = commits[0].sha;

      const files = await listFilesAtCommit(root, sha, { subPath: 'wiki/' });
      // md + png 全部返る (呼び出し側で md filter する想定)
      assert.ok(files.includes('wiki/index.md'));
      assert.ok(files.includes('wiki/concepts/jwt.md'));
      assert.ok(files.includes('wiki/concepts/oauth.md'));
      assert.ok(files.includes('wiki/image.png'));
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

  test('VIZ-GH-8: parseGitLogOutput unit (stdout parser)', () => {
    const stdout =
      'COMMIT\x1fabc123def456\x1fabc123d\x1f1700000000\x1fAlice\x1ffirst commit\nwiki/a.md\nwiki/b.md\n\n' +
      'COMMIT\x1ffeed1234\x1ffeed123\x1f1700000100\x1fBob\x1fsecond commit\nwiki/c.md\n\n';
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
});
