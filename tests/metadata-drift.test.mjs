// tests/metadata-drift.test.mjs — v0.7.2 PR B metadata drift detection
//
// Targets: KIOKU の metadata / docs drift を機械的に検出し future regression を pin する。
//          codex roadmap §P0 drift 自動検出テスト
//          (plan/codex/260430_kioku-product-improvement-roadmap.md L202-245) の codification。
//
// Test prefixes (BLUE-DRIFT-* namespace, per LEARN#8a no collision verified):
//   - BLUE-DRIFT-TOOL-1     : MCP server.mjs registerTool ↔ manifest.json tools[].name 一致
//   - BLUE-DRIFT-TOOL-2     : app/README.md (EN) tool 言及 ⊆ manifest set (no phantom)
//   - BLUE-DRIFT-TOOL-3     : context/14-mcp-server.md tool 言及 ⊆ manifest set (no phantom)
//   - BLUE-DRIFT-VERSION-1  : 4 metadata file (mcp/package.json, mcp/manifest.json,
//                             .claude-plugin/plugin.json, .claude-plugin/marketplace.json
//                             metadata.version) all parity
//   - BLUE-DRIFT-VERSION-2  : marketplace.json metadata.version ↔ plugins[0].version 一致 (5th place)
//   - BLUE-DRIFT-VERSION-3  : version 文字列が semver 形式 (X.Y.Z) であること (sanity gate)
//   - BLUE-DRIFT-INSTALL-1  : docs/install-guide-plugin.md fenced bash code block で
//                             current syntax を使用 (legacy 不在)
//   - BLUE-DRIFT-INSTALL-2  : docs/install-guide-plugin.md install identifier kioku@<owner>
//                             の <owner> が marketplace.json.name と一致
//   - BLUE-DRIFT-INSTALL-3  : marketplace add 引数 owner/repo slug が <owner>/kioku 形式で整合
//
// 設計方針:
//   - Node 18+ stdlib のみ (外部依存なし)
//   - JSON は parse して比較、Markdown は regex で抽出
//   - error message は「expected: X / found: Y / fix: Z」形式 (handoff §Acceptance criteria)
//   - drift 修正は本 test ではなく人間が手動で行う (read-only detection)
//   - MVP scope: EN README + docs/install-guide-plugin.md のみ。10 言語 README は後続 PR で拡張可
//
// LEARN#13 注意: regex literal に U+2028 / U+2029 / U+200B / U+FEFF を直接書かない。
// 本 file は ASCII のみで constructed regex を使い、literal 制御文字を含めない。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// path resolution

const moduleFilePath = fileURLToPath(import.meta.url);
const moduleDir = dirname(moduleFilePath);
const CB_ROOT = resolve(moduleDir, '..'); // tools/claude-brain/

const PATHS = {
  serverMjs: join(CB_ROOT, 'mcp', 'server.mjs'),
  manifest: join(CB_ROOT, 'mcp', 'manifest.json'),
  packageJson: join(CB_ROOT, 'mcp', 'package.json'),
  pluginJson: join(CB_ROOT, '.claude-plugin', 'plugin.json'),
  marketplaceJson: join(CB_ROOT, '.claude-plugin', 'marketplace.json'),
  contextMcp: join(CB_ROOT, 'context', '14-mcp-server.md'),
  installGuide: join(CB_ROOT, 'docs', 'install-guide-plugin.md'),
  appReadme: join(CB_ROOT, 'app', 'README.md'),
};

// helpers (no external dependency)

async function readJson(path) {
  const text = await readFile(path, 'utf8');
  return JSON.parse(text);
}

async function readText(path) {
  return await readFile(path, 'utf8');
}

// server.mjs から `register(<TOOL_DEF_NAME>, ...)` で登録された tool def 識別子を抽出
async function extractRegisteredToolDefIds() {
  const text = await readText(PATHS.serverMjs);
  const re = /register\(\s*([A-Z][A-Z0-9_]*_TOOL_DEF)\s*,/g;
  const ids = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    ids.push(m[1]);
  }
  return ids;
}

// server.mjs の import 文から `*_TOOL_DEF` -> import source path mapping
async function extractToolDefImports() {
  const text = await readText(PATHS.serverMjs);
  const re = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  const mapping = new Map();
  let m;
  while ((m = re.exec(text)) !== null) {
    const names = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /_TOOL_DEF$/.test(s));
    for (const name of names) {
      mapping.set(name, m[2]);
    }
  }
  return mapping;
}

// 1 file を read して `<id>` の `name: '...'` field を抽出。
// 再 export (`export { id } from './path'`) を最大 N 段まで辿る。
async function resolveIdInFile(id, filePath, fileCache, depth = 0) {
  if (depth > 5) {
    throw new Error(
      `[drift-test] re-export chain が深すぎます (id=${id}, file=${filePath})`,
    );
  }
  let text = fileCache.get(filePath);
  if (text === undefined) {
    text = await readText(filePath);
    fileCache.set(filePath, text);
  }

  // case 1: 直接 export (`export const ID = { ... name: 'kioku_xxx' ... }`)
  // 識別子が `=` の左辺にあるかを見て decl の場合は近傍の name field を抽出
  const declRe = new RegExp(`export\\s+const\\s+${id}\\s*=`);
  if (declRe.test(text)) {
    const idIdx = text.search(declRe);
    const tail = text.slice(idIdx);
    const nameMatch = /name\s*:\s*['"]([^'"]+)['"]/.exec(tail);
    if (!nameMatch) {
      throw new Error(
        `[drift-test] tool def ${id} (${filePath}) で 'name:' field が抽出できません。`,
      );
    }
    return nameMatch[1];
  }

  // case 2: 再 export (`export { id, ... } from '<path>'`)
  const reExportRe = /export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = reExportRe.exec(text)) !== null) {
    const names = m[1]
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0])
      .filter((s) => s.length > 0);
    if (names.includes(id)) {
      const nextPath = resolve(dirname(filePath), m[2]);
      return await resolveIdInFile(id, nextPath, fileCache, depth + 1);
    }
  }

  throw new Error(
    `[drift-test] tool def ${id} を file ${filePath} (またはその re-export 先) で解決できません。`,
  );
}

// 各 tool def file を read し identName -> toolName mapping を返す
async function resolveToolNamesFromDefs() {
  const ids = await extractRegisteredToolDefIds();
  const importMap = await extractToolDefImports();
  const idToToolName = new Map();
  const fileCache = new Map();
  for (const id of ids) {
    const importPath = importMap.get(id);
    if (!importPath) {
      throw new Error(
        `[drift-test] register(${id}, ...) の import が server.mjs で見つかりません。` +
          `server.mjs の import 文と register 呼び出しを確認してください。`,
      );
    }
    const filePath = resolve(dirname(PATHS.serverMjs), importPath);
    const toolName = await resolveIdInFile(id, filePath, fileCache);
    idToToolName.set(id, toolName);
  }
  return idToToolName;
}

// markdown 全文から `kioku_xxx` 識別子を抽出 (重複排除)
function extractKiokuToolMentions(markdown) {
  const re = /kioku_[a-z][a-z0-9_]*/g;
  const set = new Set();
  let m;
  while ((m = re.exec(markdown)) !== null) {
    set.add(m[0]);
  }
  return set;
}

// markdown から fenced bash/sh/shell code block の本文のみを抽出
function extractFencedBashBlocks(markdown) {
  const re = /```(?:bash|sh|shell)\s*\n([\s\S]*?)\n```/g;
  const blocks = [];
  let m;
  while ((m = re.exec(markdown)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

// Category 1: MCP tool registry drift

describe('BLUE-DRIFT-TOOL: MCP tool registry drift', () => {
  test('BLUE-DRIFT-TOOL-1: server.mjs registerTool set === manifest.json tools[].name set', async () => {
    const idToName = await resolveToolNamesFromDefs();
    const serverNames = new Set(idToName.values());

    const manifest = await readJson(PATHS.manifest);
    const manifestNames = new Set(manifest.tools.map((t) => t.name));

    const missingInManifest = [...serverNames].filter((n) => !manifestNames.has(n)).sort();
    const missingInServer = [...manifestNames].filter((n) => !serverNames.has(n)).sort();

    assert.deepEqual(
      { missingInManifest, missingInServer },
      { missingInManifest: [], missingInServer: [] },
      `MCP tool registry drift detected.\n` +
        `  expected: server.mjs registerTool set === manifest.json tools[].name set\n` +
        `  found: server has ${serverNames.size} tools, manifest has ${manifestNames.size} tools\n` +
        `  manifest missing (add to manifest.json tools[]): ${missingInManifest.join(', ') || '(none)'}\n` +
        `  server missing (remove from manifest or add register): ${missingInServer.join(', ') || '(none)'}`,
    );
  });

  test('BLUE-DRIFT-TOOL-2: app/README.md (EN) tool mentions are subset of manifest set', async () => {
    const manifest = await readJson(PATHS.manifest);
    const manifestNames = new Set(manifest.tools.map((t) => t.name));

    const readmeText = await readText(PATHS.appReadme);
    const readmeMentions = extractKiokuToolMentions(readmeText);

    const phantom = [...readmeMentions].filter((n) => !manifestNames.has(n)).sort();

    assert.deepEqual(
      phantom,
      [],
      `app/README.md tool mention drift detected.\n` +
        `  expected: app/README.md で言及される kioku_* tool は全て manifest.json tools[].name に存在\n` +
        `  found phantom (README に記載あり、manifest に無し): ${phantom.join(', ')}\n` +
        `  fix: app/README.md から該当 tool 言及を削除する、または manifest.json に追加する`,
    );
  });

  test('BLUE-DRIFT-TOOL-3: context/14-mcp-server.md tool mentions are subset of manifest set', async () => {
    const manifest = await readJson(PATHS.manifest);
    const manifestNames = new Set(manifest.tools.map((t) => t.name));

    const contextText = await readText(PATHS.contextMcp);
    const contextMentions = extractKiokuToolMentions(contextText);

    const phantom = [...contextMentions].filter((n) => !manifestNames.has(n)).sort();

    assert.deepEqual(
      phantom,
      [],
      `context/14-mcp-server.md tool mention drift detected.\n` +
        `  expected: context/14 で言及される kioku_* tool は全て manifest.json tools[].name に存在\n` +
        `  found phantom: ${phantom.join(', ')}\n` +
        `  fix: context/14-mcp-server.md から該当 tool 言及を削除する、または manifest に追加する`,
    );
  });
});

// Category 2: 5-place version parity

describe('BLUE-DRIFT-VERSION: 5-place version parity', () => {
  test('BLUE-DRIFT-VERSION-1: 4 metadata files の version が一致', async () => {
    const pkg = await readJson(PATHS.packageJson);
    const man = await readJson(PATHS.manifest);
    const plugin = await readJson(PATHS.pluginJson);
    const market = await readJson(PATHS.marketplaceJson);

    const versions = {
      'mcp/package.json': pkg.version,
      'mcp/manifest.json': man.version,
      '.claude-plugin/plugin.json': plugin.version,
      '.claude-plugin/marketplace.json metadata.version': market.metadata?.version,
    };

    const distinct = new Set(Object.values(versions));
    assert.equal(
      distinct.size,
      1,
      `4 metadata version mismatch detected.\n` +
        `  expected: 全 4 file の version が同一\n` +
        `  found: ${JSON.stringify(versions, null, 2)}\n` +
        `  fix: release cascade Step 1 で 4 file 全て同じ version に bump する`,
    );
  });

  test('BLUE-DRIFT-VERSION-2: marketplace.json metadata.version === plugins[0].version (5th place)', async () => {
    const market = await readJson(PATHS.marketplaceJson);
    const metaVer = market.metadata?.version;
    const pluginVer = market.plugins?.[0]?.version;

    assert.equal(
      metaVer,
      pluginVer,
      `marketplace.json internal version mismatch.\n` +
        `  expected: metadata.version === plugins[0].version (5 places parity)\n` +
        `  found: metadata.version=${metaVer}, plugins[0].version=${pluginVer}\n` +
        `  fix: .claude-plugin/marketplace.json の 2 occurrence を同じ version に揃える`,
    );
  });

  test('BLUE-DRIFT-VERSION-3: version 文字列が semver 形式', async () => {
    const pkg = await readJson(PATHS.packageJson);
    const semverRe = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
    assert.ok(
      semverRe.test(pkg.version),
      `version semver violation.\n` +
        `  expected: ^\\d+\\.\\d+\\.\\d+(-prerelease)?$ (例: 0.7.1, 0.7.2-rc1)\n` +
        `  found: mcp/package.json version=${pkg.version}\n` +
        `  fix: semver compliant な version 文字列に修正する`,
    );
  });
});

// Category 3: install command syntax drift

describe('BLUE-DRIFT-INSTALL: install command syntax drift', () => {
  test('BLUE-DRIFT-INSTALL-1: docs/install-guide-plugin.md fenced bash で current syntax を使用', async () => {
    const text = await readText(PATHS.installGuide);
    const blocks = extractFencedBashBlocks(text);
    const joined = blocks.join('\n');

    // legacy syntax: `claude marketplace add` (no `plugin` between)
    // word boundary を使い `claude plugin marketplace add` には match しないようにする
    const legacyRe = /(^|[^a-zA-Z])claude\s+marketplace\s+add\b/m;
    const hasLegacy = legacyRe.test(joined);
    const currentRe = /claude\s+plugin\s+marketplace\s+add\b/;
    const hasCurrent = currentRe.test(joined);

    assert.equal(
      hasLegacy,
      false,
      `legacy install syntax found in docs/install-guide-plugin.md fenced bash block.\n` +
        `  expected: 'claude plugin marketplace add ...' (Claude Code v2.1.89+ syntax)\n` +
        `  found: legacy 'claude marketplace add ...' present (§44 incident 再発)\n` +
        `  fix: docs/install-guide-plugin.md の bash code block で 'claude marketplace add' を 'claude plugin marketplace add' に書き換える`,
    );
    assert.equal(
      hasCurrent,
      true,
      `current install syntax missing in docs/install-guide-plugin.md.\n` +
        `  expected: 少なくとも 1 つの bash code block に 'claude plugin marketplace add ...' が存在\n` +
        `  found: 'claude plugin marketplace add' を含む bash block が無い\n` +
        `  fix: docs/install-guide-plugin.md の install snippet で current syntax を使う`,
    );
  });

  test('BLUE-DRIFT-INSTALL-2: docs install identifier kioku@<owner> が marketplace.json.name と一致', async () => {
    const market = await readJson(PATHS.marketplaceJson);
    const expectedOwner = market.name;

    const text = await readText(PATHS.installGuide);
    const installRe = /claude\s+plugin\s+install\s+kioku@([a-zA-Z0-9._-]+)/g;
    const owners = new Set();
    let m;
    while ((m = installRe.exec(text)) !== null) {
      owners.add(m[1]);
    }

    assert.notEqual(
      owners.size,
      0,
      `docs/install-guide-plugin.md に 'claude plugin install kioku@<owner>' snippet が見つからない.\n` +
        `  expected: kioku@<owner> identifier の install snippet が少なくとも 1 つ\n` +
        `  fix: docs/install-guide-plugin.md に install snippet を追加する`,
    );

    const ownersArr = [...owners].sort();
    const mismatched = ownersArr.filter((o) => o !== expectedOwner);

    assert.deepEqual(
      mismatched,
      [],
      `install identifier owner drift detected.\n` +
        `  expected: kioku@${expectedOwner} (= marketplace.json.name)\n` +
        `  found: ${ownersArr.join(', ')}\n` +
        `  fix: docs/install-guide-plugin.md の identifier を kioku@${expectedOwner} に揃える、` +
        `または .claude-plugin/marketplace.json の name field を更新する (§44 incident 参照)`,
    );
  });

  test('BLUE-DRIFT-INSTALL-3: docs marketplace add 引数の owner/repo slug が整合', async () => {
    const text = await readText(PATHS.installGuide);
    const addRe = /claude\s+plugin\s+marketplace\s+add\s+([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)/g;
    const slugs = new Set();
    let m;
    while ((m = addRe.exec(text)) !== null) {
      slugs.add(m[1]);
    }

    assert.notEqual(
      slugs.size,
      0,
      `docs/install-guide-plugin.md に 'claude plugin marketplace add <owner/repo>' snippet が見つからない.\n` +
        `  expected: owner/repo slug を含む marketplace add snippet\n` +
        `  fix: docs/install-guide-plugin.md に marketplace add snippet を追加する`,
    );

    const slugsArr = [...slugs].sort();
    const repoMismatch = slugsArr.filter((s) => !s.endsWith('/kioku'));

    assert.deepEqual(
      repoMismatch,
      [],
      `marketplace add slug repo name drift.\n` +
        `  expected: 全 slug が '<owner>/kioku' 形式\n` +
        `  found: ${slugsArr.join(', ')}\n` +
        `  fix: docs/install-guide-plugin.md の marketplace add slug を '<owner>/kioku' に揃える`,
    );

    const owners = new Set(slugsArr.map((s) => s.split('/')[0]));
    assert.equal(
      owners.size,
      1,
      `marketplace add slug owner inconsistency.\n` +
        `  expected: 全 marketplace add snippet が同じ owner を指す\n` +
        `  found owners: ${[...owners].sort().join(', ')}\n` +
        `  fix: docs/install-guide-plugin.md の owner 部分を統一する`,
    );
  });
});
