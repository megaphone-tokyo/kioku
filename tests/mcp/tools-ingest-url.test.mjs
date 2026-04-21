// tools-ingest-url.test.mjs — kioku_ingest_url MCP tool (機能 2.2) のユニット/結合テスト。
//
// MCP31   正常 URL → fetched_and_summarized_pending
// MCP32   SSRF: localhost reject (KIOKU_URL_ALLOW_LOOPBACK=0 強制)
// MCP32b  HIGH-1: KIOKU_URL_ALLOW_LOOPBACK=1 でも file:// は reject
// MCP32c  HIGH-1: KIOKU_URL_ALLOW_LOOPBACK=1 でも user:pass@ は reject
// MCP33   冪等再実行 → skipped
// MCP34   robots Disallow → invalid_request
// MCP35   lockfile 競合 → 200ms 後も pending (acquire 中) — try/finally で cleanup (HIGH-3)
// MCP36   child env allowlist (GH_TOKEN リーク無し、KIOKU_NO_LOG / KIOKU_MCP_CHILD は伝搬)
// MCP37   default subdir = articles
// MCP38   title 引数 → frontmatter
// MCP39   tags 伝搬 + masking (MED-4: tag 値も applyMasks を通る)
// MCP40   refresh_days 引数 → frontmatter
// MCP41   HTML content-type → 通常 URL フロー (PDF dispatch しない)
// MCP42   application/pdf → handleIngestPdf に dispatch
// MCP43   octet-stream + URL 末尾 .pdf → dispatch
// MCP44   PDF body > 50MB → invalid_request
// MCP45   PDF dispatch は outer withLock を release してから handleIngestPdf が
//         自前 withLock を acquire する (v0.4.0 Tier A#3 M-a2 refactor)
// MCP45b  concurrent PDF dispatch (異 vault) が短時間で完了する (Tier A#3 M-a2 invariant)
// MCP45c  handleIngestPdf 失敗時に orphan PDF が raw-sources/ から cleanup される
//         (v0.4.0 Tier A#3 post-review GAP-1 fix)
// MCP46   CRIT-1: late-PDF discovery で binary 再 fetch して PDF magic bytes が保持される
// MCP46b  v0.3.5 Option B: 長い PDF dispatch → status: dispatched_to_pdf_queued
// MCP47   HIGH-2: fetch エラーメッセージに credentials / 内部 IP / raw URL を含めない
// MCP48   MED-1: subdir に空白等の不正文字 → silent mangle ではなく invalid_params で reject
//
// 外部依存:
//   - fixture-server.mjs が /article-normal.html, /article-sparse.html, /robots.txt,
//     /pdf?name=, /huge-pdf を配信。
//   - PDF dispatch は handleIngestPdf 経由で extract-pdf.sh を spawn するため poppler が必要。
//     未インストール環境では PDF dispatch スイートを skip する。
//   - claude CLI は stub に差し替え (stubBin)。LLM fallback (llm-fallback.mjs) も同 stub を呼ぶ。

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from '../helpers/fixture-server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_DIR = join(__dirname, '..', '..', 'mcp');

const { handleIngestUrl } = await import(join(MCP_DIR, 'tools', 'ingest-url.mjs'));

// poppler が無ければ PDF dispatch サブスイートを skip (handleIngestPdf が extract-pdf.sh
// を spawn するので pdfinfo / pdftotext が必要)。
const popplerCheck = spawnSync(
  'sh',
  ['-c', 'command -v pdfinfo >/dev/null 2>&1 && command -v pdftotext >/dev/null 2>&1'],
  { stdio: 'ignore' },
);
const HAS_POPPLER = popplerCheck.status === 0;

let server;
let workspace;
let stubBin;
let stubLog;

before(async () => {
  process.env.KIOKU_URL_ALLOW_LOOPBACK = '1';
  server = await startFixtureServer();
  workspace = await mkdtemp(join(tmpdir(), 'kioku-iu-'));
  stubBin = join(workspace, 'claude-stub.sh');
  stubLog = join(workspace, 'claude-stub.log');
  // stub claude:
  //   - argv と KIOKU_* / OBSIDIAN_VAULT / GH_TOKEN / AWS_* / ANTHROPIC_ を log に dump
  //   - LLM fallback (llm-fallback.mjs) が KIOKU_LLM_FB_OUT を渡してきたら
  //     そのパスに最低限の Markdown を書き出して exit 0 (本物の LLM の代替)
  const script = [
    '#!/usr/bin/env bash',
    '{',
    '  echo "=== invocation ==="',
    '  echo "ARGV: $*"',
    "  env | grep -E '^(KIOKU_|OBSIDIAN_VAULT=|ANTHROPIC_|GH_TOKEN=|AWS_)' | sort",
    '  echo "--- end env ---"',
    `} >> "${stubLog}"`,
    'if [[ -n "${KIOKU_LLM_FB_OUT:-}" ]]; then',
    '  {',
    '    echo "# Fallback Stub"',
    '    echo "Body from fallback."',
    '  } > "$KIOKU_LLM_FB_OUT"',
    'fi',
    'exit 0',
    '',
  ].join('\n');
  await writeFile(stubBin, script, { mode: 0o755 });
  await chmod(stubBin, 0o755);
});

after(async () => {
  delete process.env.KIOKU_URL_ALLOW_LOOPBACK;
  if (server) await server.close();
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

async function makeVault(name) {
  const v = join(workspace, name);
  await mkdir(join(v, 'raw-sources', 'articles', 'fetched'), { recursive: true });
  await mkdir(join(v, 'raw-sources', 'papers'), { recursive: true });
  await mkdir(join(v, 'wiki', 'summaries'), { recursive: true });
  await mkdir(join(v, '.cache', 'extracted'), { recursive: true });
  await mkdir(join(v, '.cache', 'html'), { recursive: true });
  return v;
}

describe('kioku_ingest_url', () => {
  test('MCP31 normal URL → fetched_and_summarized_pending', async () => {
    const v = await makeVault('mcp31');
    const r = await handleIngestUrl(
      v,
      { url: `${server.url}/article-normal.html` },
      { claudeBin: stubBin, robotsUrlOverride: `${server.url}/robots.txt?variant=allow` },
    );
    assert.ok(
      ['fetched_and_summarized', 'fetched_and_summarized_pending', 'fetched_only'].includes(r.status),
      `unexpected status: ${r.status}`,
    );
    assert.ok(r.path.startsWith('raw-sources/articles/fetched/'));
  });

  test('MCP32 SSRF: localhost rejected when KIOKU_URL_ALLOW_LOOPBACK=0', async () => {
    process.env.KIOKU_URL_ALLOW_LOOPBACK = '0';
    try {
      const v = await makeVault('mcp32');
      await assert.rejects(
        () => handleIngestUrl(v, { url: 'http://localhost/foo' }, { claudeBin: stubBin }),
        (e) => e.code === 'invalid_params',
      );
    } finally {
      process.env.KIOKU_URL_ALLOW_LOOPBACK = '1';
    }
  });

  test('MCP32b HIGH-1: loopback flag still rejects file:// scheme', async () => {
    // KIOKU_URL_ALLOW_LOOPBACK=1 が production に leak しても、scheme allowlist
    // (http/https only) は強制される。SSRF IP-range だけが skip される設計。
    const v = await makeVault('mcp32b');
    await assert.rejects(
      () => handleIngestUrl(v, { url: 'file:///etc/passwd' }, { claudeBin: stubBin }),
      (e) => e.code === 'invalid_params',
    );
  });

  test('MCP32c HIGH-1: loopback flag still rejects URL credentials', async () => {
    // user:pass@host も同様に loopback bypass 時にも reject される必要がある
    // (生クレデンシャルが log / error / network 経路に乗らないように)。
    const v = await makeVault('mcp32c');
    await assert.rejects(
      () => handleIngestUrl(
        v,
        { url: 'http://user:pass@127.0.0.1:8080/foo' },
        { claudeBin: stubBin },
      ),
      (e) => e.code === 'invalid_params',
    );
  });

  test('MCP33 idempotent second call → skipped', async () => {
    const v = await makeVault('mcp33');
    await handleIngestUrl(
      v,
      { url: `${server.url}/article-normal.html` },
      { claudeBin: stubBin, robotsUrlOverride: `${server.url}/robots.txt?variant=allow` },
    );
    const r2 = await handleIngestUrl(
      v,
      { url: `${server.url}/article-normal.html` },
      { claudeBin: stubBin, robotsUrlOverride: `${server.url}/robots.txt?variant=allow` },
    );
    assert.match(r2.status, /skipped/, `expected skipped status, got: ${r2.status}`);
  });

  test('MCP34 robots Disallow → invalid_request', async () => {
    const v = await makeVault('mcp34');
    await assert.rejects(
      () => handleIngestUrl(
        v,
        { url: `${server.url}/article-normal.html` },
        { claudeBin: stubBin, robotsUrlOverride: `${server.url}/robots.txt?variant=disallow` },
      ),
      (e) => e.code === 'invalid_request',
    );
  });

  test('MCP35 lockfile held externally → still pending after 200ms', async () => {
    // HIGH-3 fix: assert.equal が失敗しても lockfile / setTimeout / dangling promise が
    // 残らないよう try/finally + clearTimeout で確実に cleanup する。
    // 旧実装は assert 失敗時に lockfile が残留して後続テストの workspace が破損する
    // 可能性があった。
    const v = await makeVault('mcp35');
    // 別 PID 風の lockfile を置く (TTL 内扱い)
    await writeFile(join(v, '.kioku-mcp.lock'), '99999\n');
    const p = handleIngestUrl(
      v,
      { url: `${server.url}/article-normal.html` },
      { claudeBin: stubBin, robotsUrlOverride: `${server.url}/robots.txt?variant=allow` },
    );
    let tickHandle;
    const tick = new Promise((r) => { tickHandle = setTimeout(() => r('pending'), 200); });
    try {
      const res = await Promise.race([p.catch((e) => ({ err: e })), tick]);
      assert.equal(res, 'pending', `expected still pending on lock, got: ${JSON.stringify(res)}`);
    } finally {
      // setTimeout を確実に解放 (Promise.race 後の dangling handle 対策)
      clearTimeout(tickHandle);
      // lockfile を unlink すれば handler は acquire して進行 → 完了させてから resolve
      await rm(join(v, '.kioku-mcp.lock'), { force: true });
      await p.catch(() => {});
    }
  });

  test('MCP36 child env allowlist (no GH_TOKEN leak, KIOKU_NO_LOG / MCP_CHILD propagated)', async () => {
    await writeFile(stubLog, '');
    const prevGh = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'ghp_SHOULD_NOT_LEAK';
    try {
      const v = await makeVault('mcp36');
      // sparse HTML → Readability needsFallback → llm-fallback.mjs が stub claude を spawn
      await handleIngestUrl(
        v,
        { url: `${server.url}/article-sparse.html` },
        { claudeBin: stubBin, robotsUrlOverride: `${server.url}/robots.txt?variant=allow` },
      );
    } finally {
      if (prevGh === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = prevGh;
    }
    const log = await readFile(stubLog, 'utf8');
    assert.doesNotMatch(log, /SHOULD_NOT_LEAK/, 'GH_TOKEN must not propagate to LLM fallback child');
    assert.match(log, /KIOKU_NO_LOG=1/, 'KIOKU_NO_LOG=1 propagated');
    assert.match(log, /KIOKU_MCP_CHILD=1/, 'KIOKU_MCP_CHILD=1 propagated');
  });

  test('MCP37 default subdir = articles', async () => {
    const v = await makeVault('mcp37');
    const r = await handleIngestUrl(
      v,
      { url: `${server.url}/article-normal.html` },
      { claudeBin: stubBin, robotsUrlOverride: `${server.url}/robots.txt?variant=allow` },
    );
    assert.match(r.path, /raw-sources\/articles\/fetched\//);
  });

  test('MCP38 title arg overrides frontmatter title', async () => {
    const v = await makeVault('mcp38');
    const r = await handleIngestUrl(
      v,
      { url: `${server.url}/article-normal.html`, title: 'Custom Title' },
      { claudeBin: stubBin, robotsUrlOverride: `${server.url}/robots.txt?variant=allow` },
    );
    const content = await readFile(join(v, r.path), 'utf8');
    assert.match(content, /title: "Custom Title"/);
  });

  test('MCP39 tags propagate to frontmatter and tag values are masked', async () => {
    // MED-4 fix (code-quality 2026-04-19): tag 値も applyMasks を通る。
    // 旧実装では url-extract.mjs#buildFrontmatterObject が tags を素通ししていたため、
    // frontmatter に GitHub PAT 等の secret 文字列が漏洩 → vault の git push で
    // commit history に永久残留する欠陥があった。
    const v = await makeVault('mcp39');
    // MED-3 fix で tag は 32 文字以下に validate される。GitHub PAT mask rule
    // (`ghp_[A-Za-z0-9]{20,}`) を満たす最短の sentinel = `ghp_` + 20 文字 = 24 文字。
    // SHOULD_BE_MASKED 文字列 (16 chars) を 20 文字 alnum 中に含めて leak 検出可能にする。
    // 32 chars total: 'ghp_' (4) + 'SHOULDBEMASKED' (14) + 'xxxxxxxxxxxxxx' (14) = 32
    const sentinel = 'ghp_SHOULDBEMASKEDxxxxxxxxxxxxxx';
    assert.ok(sentinel.length <= 32, 'sentinel must fit in tag length limit');
    assert.match(sentinel, /^ghp_[A-Za-z0-9]{20,}$/, 'sentinel must match ghp_ mask rule');
    const r = await handleIngestUrl(
      v,
      {
        url: `${server.url}/article-normal.html`,
        tags: ['t1', sentinel],
      },
      { claudeBin: stubBin, robotsUrlOverride: `${server.url}/robots.txt?variant=allow` },
    );
    const content = await readFile(join(v, r.path), 'utf8');
    assert.match(content, /tags: \[/, 'tags array present in frontmatter');
    assert.match(content, /"t1"/, 't1 propagated');
    // 元値 (sentinel) は frontmatter からも本文からも漏れていてはならない
    assert.doesNotMatch(content, /SHOULDBEMASKED/, 'tag secret must be masked');
    // 代わりに mask placeholder が入っていることを確認 (applyMasks は ghp_ → ghp_***)
    assert.match(content, /"ghp_\*\*\*"/, 'mask placeholder applied to tag');
  });

  test('MCP39b og_image / published_time meta secrets are masked (red M-1)', async () => {
    // red M-1 fix (2026-04-20): <meta property="og:image"> と
    // <meta property="article:published_time"> の raw 文字列が attacker-controlled。
    // 旧実装では url-extract.mjs#buildFrontmatterObject で setRaw だったため
    // `og_image: "https://.../?ghp_..."` のような secret-bearing meta が frontmatter に
    // そのまま残り、git push で commit history に永続化する欠陥があった。
    const v = await makeVault('mcp39b');
    const r = await handleIngestUrl(
      v,
      { url: `${server.url}/article-meta-secrets.html` },
      { claudeBin: stubBin, robotsUrlOverride: `${server.url}/robots.txt?variant=allow` },
    );
    const content = await readFile(join(v, r.path), 'utf8');
    // og:image と published_time の secret sentinel は frontmatter から消えている
    assert.doesNotMatch(content, /METAPUBTIMESECRET/, 'published_time sentinel must be masked');
    assert.doesNotMatch(content, /METAOGIMGSECRET/, 'og_image sentinel must be masked');
    // mask placeholder が入っていることも確認 (applyMasks は ghp_ → ghp_***)
    assert.match(content, /ghp_\*\*\*/, 'mask placeholder applied to meta frontmatter');
  });

  test('MCP40 refresh_days arg overrides global default', async () => {
    const v = await makeVault('mcp40');
    const r = await handleIngestUrl(
      v,
      { url: `${server.url}/article-normal.html`, refresh_days: 7 },
      { claudeBin: stubBin, robotsUrlOverride: `${server.url}/robots.txt?variant=allow` },
    );
    const content = await readFile(join(v, r.path), 'utf8');
    assert.match(content, /refresh_days: 7/);
  });

  describe('PDF dispatch (§4.7)', { skip: !HAS_POPPLER ? 'poppler not installed' : false }, () => {
    test('MCP41 HTML content-type → no PDF dispatch', async () => {
      const v = await makeVault('mcp41');
      const r = await handleIngestUrl(
        v,
        { url: `${server.url}/article-normal.html` },
        { claudeBin: stubBin, robotsUrlOverride: `${server.url}/robots.txt?variant=allow` },
      );
      assert.notEqual(r.status, 'dispatched_to_pdf', `unexpected dispatch: ${r.status}`);
    });

    test('MCP42 application/pdf → dispatch to handleIngestPdf', async () => {
      const v = await makeVault('mcp42');
      const r = await handleIngestUrl(
        v,
        { url: `${server.url}/pdf?name=sample-8p.pdf` },
        { claudeBin: stubBin, robotsUrlOverride: `${server.url}/robots.txt?variant=allow` },
      );
      // 8p PDF = 1 chunk なので size-gate 下限側 (sync 継続)
      assert.equal(r.status, 'dispatched_to_pdf');
      assert.ok(
        r.path.startsWith('raw-sources/papers/'),
        `expected raw-sources/papers/ prefix, got: ${r.path}`,
      );
      assert.ok(r.pdf_result, 'pdf_result wrapper present');
      assert.equal(r.pdf_result.status, 'extracted_and_summarized',
        'short PDF should be summarized synchronously');
    });

    test('MCP42b v0.3.5: long PDF (42p = 3 chunks) → dispatched_to_pdf_queued', async () => {
      // handleIngestPdf が `queued_for_summary` を返す分岐が URL 経路でも
      // `dispatched_to_pdf_queued` に正しく伝搬すること。
      const v = await makeVault('mcp42b');
      const r = await handleIngestUrl(
        v,
        { url: `${server.url}/pdf?name=sample-42p.pdf` },
        { claudeBin: stubBin, robotsUrlOverride: `${server.url}/robots.txt?variant=allow` },
      );
      assert.equal(r.status, 'dispatched_to_pdf_queued',
        `long PDF should surface queued status, got: ${JSON.stringify(r).slice(0, 300)}`);
      assert.ok(r.path.startsWith('raw-sources/papers/'), `path: ${r.path}`);
      assert.ok(r.pdf_result, 'pdf_result wrapper present');
      assert.equal(r.pdf_result.status, 'queued_for_summary',
        'inner pdf_result should mirror the queued status');
      assert.ok(
        Array.isArray(r.pdf_result.expected_summaries)
          && r.pdf_result.expected_summaries.length >= 2,
        'expected_summaries must guide client to poll wiki/summaries/',
      );
      assert.equal(typeof r.pdf_result.detached_pid, 'number', 'detached_pid surfaced');
    });

    test('MCP43 octet-stream + URL .pdf → dispatch', async () => {
      const v = await makeVault('mcp43');
      // /pdf-file/<name>.pdf にすると pathname 末尾が `.pdf` になり、
      // octet-stream Content-Type でも PDF として dispatch される。
      const r = await handleIngestUrl(
        v,
        {
          url: `${server.url}/pdf-file/sample-8p.pdf?ct=${encodeURIComponent('application/octet-stream')}`,
        },
        { claudeBin: stubBin, robotsUrlOverride: `${server.url}/robots.txt?variant=allow` },
      );
      assert.equal(r.status, 'dispatched_to_pdf');
    });

    test('MCP44 PDF body > 50MB → invalid_request', async () => {
      const v = await makeVault('mcp44');
      await assert.rejects(
        () => handleIngestUrl(
          v,
          { url: `${server.url}/huge-pdf` },
          { claudeBin: stubBin, robotsUrlOverride: `${server.url}/robots.txt?variant=allow` },
        ),
        (e) => e.code === 'invalid_request',
      );
    });

    test('MCP45 PDF dispatch releases outer lock before handleIngestPdf acquires its own (v0.4.0 Tier A#3 M-a2)', async () => {
      // 2026-04-21 M-a2 fix: 旧実装は outer withLock を保持したまま handleIngestPdf に
      // skipLock=true で dispatch → 大容量 PDF (poppler 同期 extract) で outer lock を
      // 最大 4.5 分保持する問題があった。新実装は dispatchToPdf を withLock の外へ
      // 出し、handleIngestPdf が自前で withLock を取る (skipLock injection は API ごと
      // 削除済)。
      //
      // このテストは dispatch_to_pdf が成功することを検証する。refactor が壊れていて
      // outer lock が handleIngestPdf 呼び出し中も保持されていたら、handleIngestPdf
      // 側の withLock が 60s timeout で LockTimeoutError になり、このテストが失敗する。
      const v = await makeVault('mcp45');
      const r = await handleIngestUrl(
        v,
        { url: `${server.url}/pdf?name=sample-8p.pdf` },
        { claudeBin: stubBin, robotsUrlOverride: `${server.url}/robots.txt?variant=allow` },
      );
      assert.equal(r.status, 'dispatched_to_pdf');
      // Lockfile が呼び出し完了後に残っていないこと (withLock の finally で unlink される)
      const lockPath = join(v, '.kioku-mcp.lock');
      let lockExists = false;
      try {
        await readFile(lockPath);
        lockExists = true;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      assert.equal(lockExists, false, 'lockfile must be unlinked after dispatch');
    });

    test('MCP45c GAP-1 fix: orphan PDF is cleaned up when handleIngestPdf fails (v0.4.0 Tier A#3 post-review)', async () => {
      // 2026-04-21 /security-review (red + blue parallel) の GAP-1 共通指摘:
      //   refactor 後は outer withLock release 後に PDF が raw-sources/ に
      //   visible になるため、handleIngestPdf が失敗 (encrypted / invalid PDF /
      //   extract rc=2,4,5 / claude -p 失敗 等) した場合 PDF が orphan 化する。
      //
      // cleanup 条件:
      //   - `lock_timeout`: user retry 用に PDF を残す (このテストでは誘発しない)
      //   - それ以外の失敗: PDF を unlink する (このテストで検証する)
      //
      // 本テストは sample-encrypted.pdf を返す URL を ingest して、extract-pdf.sh
      // rc=2 → throwInvalidRequest('encrypted or invalid PDF') で failure が走る
      // ことを契機に、orphan PDF が raw-sources/papers/ から削除されることを確認。
      const v = await makeVault('mcp45c');
      let caught;
      try {
        await handleIngestUrl(
          v,
          { url: `${server.url}/pdf?name=sample-encrypted.pdf` },
          { claudeBin: stubBin, robotsUrlOverride: `${server.url}/robots.txt?variant=allow` },
        );
      } catch (e) {
        caught = e;
      }
      assert.ok(caught, 'expected handleIngestUrl to throw on encrypted PDF');
      // GAP-1 invariant: raw-sources/papers/ には orphan PDF が残っていないこと。
      // directory 自体は writePdfToDisk が mkdir 済なので存在するが、.pdf ファイルは 0。
      const papersDir = join(v, 'raw-sources', 'papers');
      let entries = [];
      try {
        entries = await readdir(papersDir);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      const remainingPdfs = entries.filter((n) => n.endsWith('.pdf'));
      assert.deepEqual(
        remainingPdfs,
        [],
        `expected no orphan PDFs after handleIngestPdf failure, got: ${JSON.stringify(remainingPdfs)}`,
      );
    });

    test('MCP45b PDF dispatch: outer lock is released during handleIngestPdf Phase 1 (v0.4.0 Tier A#3 M-a2)', async () => {
      // 2026-04-21 M-a2 refactor の invariant test: late-PDF dispatch 中、
      // outer withLock は既に解放されているので「別の操作が lockfile を取得できる」
      // はずである。旧実装 (skipLock=true で outer 保持) だと、以下の concurrent write
      // は outer lock と conflict して 60s LockTimeoutError になるケースがあった。
      //
      // 実装: PDF dispatch 中に別 vault への kioku_ingest_url を同時並行で走らせて、
      // 両方とも短時間で完了する (60s timeout せず) ことを確認する。
      // (別 vault = lockfile 分離されているので本来は無関係だが、本 test では
      //  handleIngestUrl API 自体に concurrent 安全性があることを proof する)
      const v1 = await makeVault('mcp45b-1');
      const v2 = await makeVault('mcp45b-2');
      const start = Date.now();
      const [r1, r2] = await Promise.all([
        handleIngestUrl(
          v1,
          { url: `${server.url}/pdf?name=sample-8p.pdf` },
          { claudeBin: stubBin, robotsUrlOverride: `${server.url}/robots.txt?variant=allow` },
        ),
        handleIngestUrl(
          v2,
          { url: `${server.url}/pdf?name=sample-8p.pdf` },
          { claudeBin: stubBin, robotsUrlOverride: `${server.url}/robots.txt?variant=allow` },
        ),
      ]);
      const duration = Date.now() - start;
      assert.equal(r1.status, 'dispatched_to_pdf');
      assert.equal(r2.status, 'dispatched_to_pdf');
      // 60s timeout に達していたら旧実装の lock 競合を疑う。
      // stub claude では通常 5-20s 程度で完了するので 30s cap で十分余裕がある。
      assert.ok(duration < 30_000,
        `concurrent dispatch must complete quickly (actual: ${duration}ms)`);
    });

    test('MCP46 CRIT-1: late-PDF discovery re-fetches with binary mode', async () => {
      // late-PDF discovery 経路:
      //   1 回目 fetch (ingest-url 側 binary:true) → text/html を受領
      //   → extractAndSaveUrl に委譲 (refresh skip 等のため非バイナリ再 fetch)
      //   2 回目 fetch (extractAndSaveUrl 側、非バイナリ) → application/pdf を受領
      //   → not_html + pdfCandidate でルーティング
      //
      // 旧実装 (CRIT-1 fix 前) は err.fetchResult.body (UTF-8 文字列に decode 済) を
      // そのまま PDF として保存していた → PDF バイトが U+FFFD に化けて壊れる。
      // 修正後は binary:true で再 fetch するので magic bytes (%PDF-) が保持される。
      //
      // /html-then-pdf?name= は同 URL に対して 1 回目 HTML / 2 回目以降 PDF を返す
      // fixture-server endpoint。Map<string,count> でカウント、test 間で workspace
      // が分かれていてもサーバープロセス越しに状態は共有される (本テストでも一意な
      // name を渡せば干渉しない)。
      const v = await makeVault('mcp46');
      // counter は startFixtureServer で reset (1 回目 = HTML, 2 回目以降 = PDF)
      // 既に他の test で同じ name を引いていないか念のため counter clear する。
      server.htmlThenPdfCounts.clear();
      const r = await handleIngestUrl(
        v,
        { url: `${server.url}/html-then-pdf?name=sample-8p.pdf` },
        { claudeBin: stubBin, robotsUrlOverride: `${server.url}/robots.txt?variant=allow` },
      );
      assert.equal(r.status, 'dispatched_to_pdf');
      assert.ok(r.path.startsWith('raw-sources/papers/'));
      // 保存ファイルが valid PDF (PDF magic bytes %PDF- で始まる) ことを確認。
      // 旧コードは UTF-8 化けで壊れていた → magic bytes が一致しない。
      const saved = await readFile(join(v, r.path));
      assert.equal(
        saved.subarray(0, 5).toString('ascii'),
        '%PDF-',
        'saved file must start with %PDF- magic bytes',
      );
      // fixture と完全一致することも確認 (UTF-8 経路を経ていれば必ず差分が出る)
      const fixture = await readFile(
        join(__dirname, '..', 'fixtures', 'pdf', 'sample-8p.pdf'),
      );
      assert.equal(
        Buffer.compare(saved, fixture),
        0,
        'saved PDF must be byte-identical to the fixture (no UTF-8 corruption)',
      );
    });
  });

  test('MCP47 HIGH-2: fetch error message does not leak credentials in URL', async () => {
    // KIOKU_URL_ALLOW_LOOPBACK=1 (テスト) でも、url credentials は HIGH-1 fix で
    // invalid_params にされる。ここで確認したいのは、production 経路 (loopback flag
    // 無し) で fetchUrl が credentials を含む URL を引いた場合、上位に投げる
    // エラーメッセージに `secret` 文字列が含まれないこと。
    // FetchError.message は raw URL を含むが、ingest-url.mjs (HIGH-2 fix) で code only に
    // 書き換えてから throw するので message に secret は乗らない。
    process.env.KIOKU_URL_ALLOW_LOOPBACK = '0';
    try {
      const v = await makeVault('mcp47');
      const sentinel = 'TOPSECRET_DO_NOT_LEAK_AAAAA';
      let caught;
      try {
        await handleIngestUrl(
          v,
          { url: `http://user:${sentinel}@example.com/foo` },
          { claudeBin: stubBin },
        );
      } catch (e) {
        caught = e;
      }
      assert.ok(caught, 'expected handleIngestUrl to throw');
      // エラー code は invalid_params (URL credentials は url-security.validateUrl
      // で reject される) であってほしいが、network 経路に到達したら invalid_request
      // でも可。重要なのは sentinel が message に乗らないこと。
      assert.doesNotMatch(
        caught.message || '',
        new RegExp(sentinel),
        'sentinel credential must not appear in error message',
      );
    } finally {
      process.env.KIOKU_URL_ALLOW_LOOPBACK = '1';
    }
  });

  test('MCP48 MED-1: subdir with whitespace rejected (no silent mangling)', async () => {
    // 旧実装: subdir.replace(/[^\p{L}\p{N}_-]/gu, '') で "my notes" → "mynotes" と
    // 黙って書き換わる UX trap。修正後は invalid_params で reject する。
    const v = await makeVault('mcp48');
    await assert.rejects(
      () => handleIngestUrl(
        v,
        { url: `${server.url}/article-normal.html`, subdir: 'my notes' },
        { claudeBin: stubBin, robotsUrlOverride: `${server.url}/robots.txt?variant=allow` },
      ),
      (e) => e.code === 'invalid_params',
    );
  });
});
