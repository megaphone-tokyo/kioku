// visualizer-vaults.mjs — Sprint 3 v0.8 β Phase 4 fixture vault builder
//
// 「screenshot regression test を deterministic に走らせる」目的の helper。
// CLAUDE.md `テスト方針: 実 Vault を絶対に汚染しない` に従い、本物の Vault には触らず
// tmpdir に static fixture (tests/fixtures/visualizer-{empty,small}-vault/) を copy → git init →
// initial commit、必要なら 2nd commit (Timeline 切替確認用) を作って path を返す。
//
// 設計方針:
//   - 親 repo の .git に nested git repo を作れないので、static fixture には .git を含めない。
//     test 実行時に builder が tmp 上で git init する。
//   - visualizer.mjs は `git log` で commit 履歴を集めるので、初回 commit は必須。
//     small Vault は 2 commit 用意し snapshot 切替が機能することを確認できる。
//   - SAFE_CONFIG (visualizer の RCE hardening) を尊重: builder は user-level git config を
//     使うが、init.defaultBranch / user.name / user.email を inline 指定して reproducible に。
//   - LEARN#6 cross-boundary drift 回避: builder の output path は absolute、消費側は
//     `await rm(vault, { recursive: true, force: true })` で必ず cleanup する責務。

import { copyFile, cp, mkdir, mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EMPTY_FIXTURE_DIR = join(__dirname, 'visualizer-empty-vault');
const SMALL_FIXTURE_DIR = join(__dirname, 'visualizer-small-vault');
// Real repo source for dashboard.base — copied into small vault so shell
// BLUE-WEBUI-SHELL-3 can render the canonical 10-view dashboard (Sprint 4 PR B).
const DASHBOARD_BASE_SRC = join(__dirname, '..', '..', 'templates', 'wiki', 'meta', 'dashboard.base');

// SAFE_CONFIG と同等の "侵害された .git/config を読まない" git 呼び出し。
// builder は user vault 内で動かないので fsmonitor 脅威は低いが、CI / reviewer 安心のため
// 同じ pattern を踏襲する。
const GIT_SAFE_ARGS = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.version=2'];
const GIT_SAFE_ENV = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  // identity を inline で固定: user vault の global config (RYU AI) を継承しない reproducibility
  GIT_AUTHOR_NAME: 'visualizer-fixture',
  GIT_AUTHOR_EMAIL: 'fixture@test.local',
  GIT_COMMITTER_NAME: 'visualizer-fixture',
  GIT_COMMITTER_EMAIL: 'fixture@test.local',
};

async function git(cwd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', [...GIT_SAFE_ARGS, ...args], {
      cwd,
      env: { ...process.env, ...GIT_SAFE_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(' ')} failed (code ${code}): ${stderr.trim()}`));
    });
  });
}

// Recursively copy a fixture directory into the destination. Skips README files at
// the fixture root so the test vault doesn't get polluted with fixture meta docs.
async function copyFixture(src, dst) {
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await cp(join(src, entry.name), join(dst, entry.name), { recursive: true });
    } else if (entry.name === 'README.md') {
      // fixture meta は vault に持ち込まない
      continue;
    } else {
      await cp(join(src, entry.name), join(dst, entry.name));
    }
  }
}

// 共通: tmp に fixture を展開 + git init + initial commit
async function bootstrapTmpVault(fixtureDir, prefix) {
  const tmp = await mkdtemp(join(tmpdir(), prefix));
  try {
    await copyFixture(fixtureDir, tmp);
    await git(tmp, ['init', '-q', '-b', 'main']);
    // empty vault には commit する file が無いので allow-empty
    await git(tmp, ['add', '-A']);
    await git(tmp, ['commit', '-q', '--allow-empty', '-m', 'fixture: initial vault state']);
    return tmp;
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// Empty vault: README しか無い (= wiki/ も無い) → "まだ育っていない Vault" の正典再現。
// 返り値は absolute path、消費側は rm で cleanup する。
export async function cloneEmptyVault() {
  return bootstrapTmpVault(EMPTY_FIXTURE_DIR, 'kioku-viz-fixture-empty-');
}

// Small vault: 5 wiki page + auto-lint report、2 commit (snapshot 切替確認可)。
// 2nd commit は "concept の追記" として小さな update を加える (Diff view が空にならないため)。
// Sprint 4 PR B: templates/wiki/meta/dashboard.base を vault 内に copy。
// shell の Dashboard tab (PR A renderBases consumption) が fixture 上で動くようにする。
export async function cloneSmallVault() {
  const vault = await bootstrapTmpVault(SMALL_FIXTURE_DIR, 'kioku-viz-fixture-small-');
  try {
    // Copy dashboard.base into the fixture at the canonical location written by
    // tools/claude-brain/scripts/setup-vault.sh:221-222 (`wiki/meta/dashboard.base`)
    // so shell BLUE-WEBUI-SHELL-3 can render the canonical 10-view dashboard via
    // PR A renderBases. Committed as a dedicated step between initial and the
    // jwt update so downstream visualizer tests see a stable shape.
    const baseDst = join(vault, 'wiki', 'meta', 'dashboard.base');
    await mkdir(dirname(baseDst), { recursive: true });
    await copyFile(DASHBOARD_BASE_SRC, baseDst);
    await git(vault, ['add', 'wiki/meta/dashboard.base']);
    await git(vault, ['commit', '-q', '-m', 'fixture: add dashboard.base for shell PR B']);

    // 2nd commit: jwt.md に小さい追記を加える (Diff 用)
    const jwtPath = join(vault, 'wiki', 'concepts', 'jwt.md');
    const updated = [
      '---',
      'type: concept',
      'title: JWT (JSON Web Token)',
      'tags: [auth, session]',
      'updated: 2026-05-13',
      '---',
      '',
      '# JWT',
      '',
      'Compact, URL-safe means of representing claims to be transferred between two parties.',
      'Often used together with [[oauth]] flows for delegated authorization.',
      '',
      '## Use cases',
      '',
      '- Stateless session tokens',
      '- Service-to-service authorization',
      '',
    ].join('\n');
    await writeFile(jwtPath, updated, 'utf8');
    await git(vault, ['add', 'wiki/concepts/jwt.md']);
    await git(vault, ['commit', '-q', '-m', 'fixture: expand jwt concept with use cases']);
    return vault;
  } catch (err) {
    await rm(vault, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// 任意の vault を rm。test の finally 句で使う安全な wrapper。
export async function disposeFixtureVault(vault) {
  if (typeof vault !== 'string' || vault.length === 0) return;
  await rm(vault, { recursive: true, force: true }).catch(() => {});
}
