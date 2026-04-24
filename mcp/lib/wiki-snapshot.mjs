// wiki-snapshot.mjs — 指定 git commit での wiki/ 配下のスナップショットを構築
//
// 使い方:
//   const snap = await buildWikiSnapshot(vaultDir, sha);
//   // snap = { sha, timestamp, pages: [...], links: [...] }
//
// Visualizer (Phase D α) が時系列 animation / diff を生成するための input。
//
// 設計原則 (plan/claude/26042402 §Security / Trust boundary):
//   - 本文 (body) は snapshot に含めない (frontmatter + wikilink のみ、漏洩 blast radius 限定)
//   - applyMasks() を frontmatter 値に適用 (secret 漏洩防御、既存 KIOKU pattern)
//   - git-history.mjs の spawn-based safe command 経由で read-only

import { parseFrontmatter } from './frontmatter.mjs';
import { findWikilinks } from './wikilinks.mjs';
import { maskText as applyMasks } from '../../scripts/lib/masking.mjs';
import { getFileContentAtCommit, listFilesAtCommit } from './git-history.mjs';

export class WikiSnapshotError extends Error {
  constructor(message, code = 'snapshot_error') {
    super(message);
    this.name = 'WikiSnapshotError';
    this.code = code;
  }
}

// 指定 commit での wiki/ スナップショットを構築
//
// 返り値:
// {
//   sha: '<full sha>',
//   timestamp: <ms since epoch、呼び出し側で指定 or null>,
//   pages: [{
//     path: 'wiki/concepts/jwt.md',         // vault-relative
//     name: 'jwt',                           // basename without extension
//     folder: 'wiki/concepts',               // parent folder (nav/group 用)
//     type: 'concept',                       // frontmatter type
//     tags: ['auth', 'security'],            // frontmatter tags
//     title: 'JWT Authentication',           // frontmatter title (あれば)
//     wikilinks: ['oauth2', 'session-token'],// [[wikilink]] targets (extension なし)
//     frontmatter: { ... applyMasks 適用済 } // all frontmatter, secret masked
//   }, ...],
//   links: [{ from: 'jwt', to: 'oauth2' }, ...]  // edges (derived from wikilinks)
// }
export async function buildWikiSnapshot(vaultDir, sha, options = {}) {
  if (typeof vaultDir !== 'string' || vaultDir.length === 0) {
    throw new WikiSnapshotError('vaultDir required', 'invalid_args');
  }
  if (typeof sha !== 'string' || !/^[0-9a-f]{4,40}$/.test(sha)) {
    throw new WikiSnapshotError('invalid sha', 'invalid_args');
  }
  const { subPath = 'wiki/', timestamp = null } = options;

  const files = await listFilesAtCommit(vaultDir, sha, { subPath });
  const mdFiles = files.filter((p) => p.endsWith('.md'));

  const pages = [];
  const linkSet = new Set(); // 重複 edges を除くため Set of "from\x1fto"
  for (const relPath of mdFiles) {
    const content = await getFileContentAtCommit(vaultDir, sha, relPath);
    if (content === null) continue; // 取得失敗 (rename etc.) は skip
    const page = parsePage(relPath, content);
    pages.push(page);
    for (const target of page.wikilinks) {
      linkSet.add(`${page.name}\x1f${target}`);
    }
  }

  const links = Array.from(linkSet).map((pair) => {
    const [from, to] = pair.split('\x1f');
    return { from, to };
  });

  return { sha, timestamp, pages, links };
}

// 内部: 1 page を parse
// frontmatter + wikilinks 抽出、applyMasks で secret 伏字化
function parsePage(relPath, content) {
  const parsed = parseFrontmatter(content);
  // parseFrontmatter() は { data, body } を返す (mcp/lib/frontmatter.mjs 正典)
  const rawFrontmatter = parsed?.data ?? {};
  const body = parsed?.body ?? content;

  // frontmatter values に applyMasks を適用
  const masked = maskFrontmatter(rawFrontmatter);

  const name = basenameWithoutExt(relPath);
  const folder = parentFolder(relPath);
  const wikilinks = findWikilinks(body);

  return {
    path: relPath,
    name,
    folder,
    type: typeof masked.type === 'string' ? masked.type : null,
    tags: Array.isArray(masked.tags)
      ? masked.tags.filter((t) => typeof t === 'string')
      : [],
    title: typeof masked.title === 'string' ? masked.title : null,
    wikilinks,
    frontmatter: masked,
  };
}

// frontmatter の各 string value に applyMasks を適用 (shallow)
// array / nested object は再帰で walk
function maskFrontmatter(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map((v) => maskValue(v));
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = maskValue(v);
  }
  return out;
}

function maskValue(v) {
  if (typeof v === 'string') return applyMasks(v);
  if (Array.isArray(v)) return v.map((x) => maskValue(x));
  if (v !== null && typeof v === 'object') return maskFrontmatter(v);
  return v;
}

function basenameWithoutExt(relPath) {
  const last = relPath.split('/').pop() ?? '';
  return last.replace(/\.md$/, '');
}

function parentFolder(relPath) {
  const parts = relPath.split('/');
  parts.pop();
  return parts.join('/');
}

// 2 snapshot 間の diff を計算 (View 2 Diff Viewer 用)
// 返り値: { added: [names], removed: [names], modified: [names], linkAdded: [{from,to}], linkRemoved: [{from,to}] }
export function diffSnapshots(beforeSnap, afterSnap) {
  if (!beforeSnap || !afterSnap) {
    throw new WikiSnapshotError('two snapshots required', 'invalid_args');
  }
  const beforeByName = indexByName(beforeSnap.pages);
  const afterByName = indexByName(afterSnap.pages);

  const added = [];
  const removed = [];
  const modified = [];

  for (const [name, page] of afterByName) {
    if (!beforeByName.has(name)) {
      added.push(name);
    } else {
      // shallow compare: tags / type / title / wikilinks 配列
      const prev = beforeByName.get(name);
      if (
        prev.type !== page.type ||
        prev.title !== page.title ||
        !arrayEqual(prev.tags, page.tags) ||
        !arrayEqual(prev.wikilinks, page.wikilinks)
      ) {
        modified.push(name);
      }
    }
  }
  for (const [name] of beforeByName) {
    if (!afterByName.has(name)) removed.push(name);
  }

  const beforeEdges = edgeSet(beforeSnap.links);
  const afterEdges = edgeSet(afterSnap.links);
  const linkAdded = [];
  const linkRemoved = [];
  for (const key of afterEdges) if (!beforeEdges.has(key)) linkAdded.push(splitEdgeKey(key));
  for (const key of beforeEdges) if (!afterEdges.has(key)) linkRemoved.push(splitEdgeKey(key));

  return { added, removed, modified, linkAdded, linkRemoved };
}

function indexByName(pages) {
  const m = new Map();
  for (const p of pages) m.set(p.name, p);
  return m;
}

function edgeSet(links) {
  const s = new Set();
  for (const l of links) s.add(`${l.from}\x1f${l.to}`);
  return s;
}

function splitEdgeKey(key) {
  const [from, to] = key.split('\x1f');
  return { from, to };
}

function arrayEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i += 1) {
    if (sa[i] !== sb[i]) return false;
  }
  return true;
}
