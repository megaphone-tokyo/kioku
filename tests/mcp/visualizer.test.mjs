// visualizer.test.mjs — kioku_generate_viz (Phase D α V-2) のユニット/結合テスト
//
// 実行: node --test tools/claude-brain/tests/mcp/visualizer.test.mjs
//
// ケース (VIZ-T1 〜 VIZ-T7):
//   VIZ-T1: TOOL_DEF shape (name / title / description / inputShape)
//   VIZ-T2: 非 git vault → helpful error
//   VIZ-T3: 正常パス — git fixture で生成、HTML 内に data JSON 埋め込み確認
//   VIZ-T4: output_path validation — `.cache/viz/` prefix 以外は reject
//   VIZ-T5: embeddings=true は "deferred to v0.8" で reject
//   VIZ-T6: path traversal in output_path → boundary error
//   VIZ-T7: XSS hardening — script close tag が HTML 内で escape される

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  VISUALIZER_TOOL_DEF,
  handleGenerateViz,
  _internals,
} from '../../mcp/tools/visualizer.mjs';

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

async function hasGit() {
  return new Promise((resolve) => {
    const child = spawn('git', ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function makeFixtureVault() {
  const root = await mkdtemp(join(tmpdir(), 'kioku-viz-test-'));
  await runCmd(root, 'git', ['init', '-b', 'main']);
  await runCmd(root, 'git', ['config', 'user.email', 'test@example.com']);
  await runCmd(root, 'git', ['config', 'user.name', 'Test User']);
  await mkdir(join(root, 'wiki', 'concepts'), { recursive: true });
  await mkdir(join(root, '.cache'), { recursive: true });

  // 2 commit で history 作る
  await writeFile(
    join(root, 'wiki', 'index.md'),
    '---\ntype: index\ntitle: Index\n---\n\n# Index\n\n- [[concepts/jwt]]\n',
  );
  await writeFile(
    join(root, 'wiki', 'concepts', 'jwt.md'),
    '---\ntype: concept\ntags: [auth]\n---\n\n# JWT\n',
  );
  await runCmd(root, 'git', ['add', '-A']);
  await runCmd(root, 'git', ['commit', '-m', 'v1 initial wiki']);

  await new Promise((r) => setTimeout(r, 1100));
  await writeFile(
    join(root, 'wiki', 'concepts', 'oauth.md'),
    '---\ntype: concept\ntags: [auth, security]\n---\n\n# OAuth\n\n[[jwt]]\n',
  );
  await runCmd(root, 'git', ['add', '-A']);
  await runCmd(root, 'git', ['commit', '-m', 'v2 add oauth page']);
  return root;
}

describe('kioku_generate_viz (Phase D α V-2)', () => {
  let gitAvailable = true;

  before(async () => {
    gitAvailable = await hasGit();
  });

  test('VIZ-T1: TOOL_DEF shape', () => {
    assert.equal(VISUALIZER_TOOL_DEF.name, 'kioku_generate_viz');
    assert.ok(typeof VISUALIZER_TOOL_DEF.title === 'string' && VISUALIZER_TOOL_DEF.title.length > 0);
    assert.ok(typeof VISUALIZER_TOOL_DEF.description === 'string');
    assert.match(VISUALIZER_TOOL_DEF.description, /Timeline/);
    assert.match(VISUALIZER_TOOL_DEF.description, /Diff/);
    assert.ok(VISUALIZER_TOOL_DEF.inputShape);
    // zod schema 確認
    const shape = VISUALIZER_TOOL_DEF.inputShape;
    assert.ok(shape.output_path);
    assert.ok(shape.since);
    assert.ok(shape.max_commits);
    assert.ok(shape.embeddings);
  });

  test('VIZ-T2: 非 git vault → helpful error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kioku-viz-nongit-'));
    try {
      await mkdir(join(root, 'wiki'), { recursive: true });
      await mkdir(join(root, '.cache', 'viz'), { recursive: true });
      await assert.rejects(
        () => handleGenerateViz(root, {}),
        /not a git repository/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('VIZ-T3: 正常生成 — HTML + data JSON 埋め込み', async () => {
    if (!gitAvailable) return;
    const root = await makeFixtureVault();
    try {
      const res = await handleGenerateViz(root, {});
      assert.ok(res.path);
      assert.match(res.path, /\.cache\/viz\/wiki-graph\.html$/);
      assert.ok(res.commits >= 2);
      assert.ok(res.snapshots >= 2);
      assert.ok(Array.isArray(res.views));
      assert.ok(res.views.includes('timeline-player'));
      assert.ok(res.views.includes('diff-viewer'));

      // HTML 内容確認
      const html = await readFile(res.path, 'utf8');
      assert.match(html, /<!doctype html>/i);
      assert.match(html, /id="kioku-data"/);
      assert.ok(!html.includes('__KIOKU_VIZ_DATA__'), 'placeholder not replaced');

      // embed JSON を抽出して parse
      const m = html.match(/<script type="application\/json" id="kioku-data">([^<]*)<\/script>/);
      assert.ok(m, 'kioku-data script block missing');
      const parsed = JSON.parse(m[1]);
      assert.equal(parsed.schema_version, 1);
      assert.ok(Array.isArray(parsed.snapshots));
      assert.ok(parsed.snapshots.length >= 2);
      // snapshot に body が含まれていないこと (plan P1 絶対契約)
      for (const s of parsed.snapshots) {
        for (const p of s.pages) {
          assert.ok(!('body' in p), `page body leaked: ${p.name}`);
          assert.ok(!('content' in p), `page content leaked: ${p.name}`);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('VIZ-T4: output_path validation — .cache/viz/ prefix 必須', async () => {
    if (!gitAvailable) return;
    const root = await makeFixtureVault();
    try {
      // wiki/ への書き込みは禁止
      await assert.rejects(
        () => handleGenerateViz(root, { output_path: 'wiki/evil.html' }),
        /must start with/,
      );
      // raw-sources/ も禁止
      await assert.rejects(
        () => handleGenerateViz(root, { output_path: 'raw-sources/x.html' }),
        /must start with/,
      );
      // .html 以外の拡張子 reject
      await assert.rejects(
        () => handleGenerateViz(root, { output_path: '.cache/viz/foo.txt' }),
        /must end with \.html/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('VIZ-T5: embeddings=true は deferred to v0.8 で reject', async () => {
    if (!gitAvailable) return;
    const root = await makeFixtureVault();
    try {
      await assert.rejects(
        () => handleGenerateViz(root, { embeddings: true }),
        /deferred to v0\.8/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('VIZ-T6: path traversal in output_path → boundary error', async () => {
    if (!gitAvailable) return;
    const root = await makeFixtureVault();
    try {
      // 前半は prefix check で落ちるが、allow-list 通過後の path traversal は assertInsideBase で catch
      await assert.rejects(
        () => handleGenerateViz(root, { output_path: '.cache/viz/../wiki/evil.html' }),
        /invalid output_path|path.*boundary|path traversal/i,
      );
      await assert.rejects(
        () => handleGenerateViz(root, { output_path: '.cache/viz//etc/passwd.html' }),
        /invalid output_path|path.*boundary|unsafe/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('VIZ-T7: XSS hardening — safeJsonForScript が </ を escape', () => {
    const { safeJsonForScript } = _internals;
    // script close tag を含む文字列
    const malicious = { injected: 'hello</script><script>alert(1)</script>' };
    const out = safeJsonForScript(malicious);
    // </script> は escape されて生の `</` が残らないこと
    assert.ok(!out.includes('</script>'), 'raw </script> leaked');
    assert.ok(out.includes('\\u003c/script>'), 'closing tag not escaped');
    // JSON.parse しても元データに戻ること (escape 後も valid JSON)
    assert.deepEqual(JSON.parse(out), malicious);
  });
});
