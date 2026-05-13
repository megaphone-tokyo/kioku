// lineage-graph.mjs — Sprint 3 Phase 3: Raw-source lineage graph (3 layer model).
//
// Strategic doc §Axis 4 + handoff Phase 3 spec:
//   - 3 layer: raw-sources → summaries → wiki pages
//   - 5 edge types: sha256 / derived_from / filename / wikilink / time
//   - best-effort hint (100% reconstruction より説明可能性優先、PM 答え #5)
//   - 1-2 hop filtering は UI 側 (本 module は全 graph を返す、cap 付き)
//   - 巨大 graph (codex Acceptance L313: 300 node 安定) で性能崩壊しない
//
// Edge confidence ordering (UI で transparency を担保):
//   sha256 (1.00) — deterministic frontmatter 同一 hash
//   derived_from (0.95) — frontmatter explicit reference
//   wikilink (0.85) — author が手で書いた link、ノイズ低い
//   filename (0.70) — slug 類推、convention dependent
//   time (0.40) — mtime proximity heuristic、weakest hint
//
// 出力は HTML inline JSON 埋め込み用に compact 化:
//   - body / text は持たない (P1 absolute contract: page body 漏洩禁止)
//   - frontmatter は lineage に必要な 4 field のみ project (source_sha256/derived_from/source/ingest_at)

import { walkPages } from './wiki-walker.mjs';

export const LINEAGE_SCHEMA_VERSION = 1;
export const DEFAULT_NODE_CAP = 300;
export const TIME_PROXIMITY_SECONDS = 3600; // 1 時間 cross-layer time edge window
export const EDGE_KINDS = Object.freeze(['sha256', 'derived_from', 'filename', 'wikilink', 'time']);
export const EDGE_CONFIDENCE = Object.freeze({
  sha256: 1.0,
  derived_from: 0.95,
  wikilink: 0.85,
  filename: 0.7,
  time: 0.4,
});

// raw-sources/ で扱う file 拡張子 (Phase 2.4 で land 済 ingest path に揃える)
const RAW_SOURCE_EXTENSIONS = ['.md', '.pdf', '.epub', '.docx', '.txt', '.html'];

// frontmatter の lineage-relevant field のみ project して inline JSON を slim 化。
function pickLineageFrontmatter(fm) {
  if (!fm || typeof fm !== 'object') return null;
  const out = {};
  if (typeof fm.source_sha256 === 'string' && fm.source_sha256.length > 0) {
    out.source_sha256 = fm.source_sha256;
  }
  if (fm.derived_from != null) {
    out.derived_from = Array.isArray(fm.derived_from)
      ? fm.derived_from.map(String)
      : String(fm.derived_from);
  }
  if (fm.source != null) {
    out.source = Array.isArray(fm.source) ? fm.source.map(String) : String(fm.source);
  }
  if (typeof fm.ingest_at === 'string' && fm.ingest_at.length > 0) out.ingest_at = fm.ingest_at;
  return Object.keys(out).length > 0 ? out : null;
}

function isoOrNull(d) {
  if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toISOString();
  return null;
}

// posix-safe slug: 小文字化 + non-alnum を hyphen + 多重 hyphen 圧縮 + 周辺 hyphen 除去
function slugify(name) {
  if (typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// summary filename 慣習を剥がして対応する raw source slug を推定
//   "rag-pipeline-summary"  → "rag-pipeline"
//   "260424_jwt-notes"      → "260424-jwt"
function summarySlugStem(name) {
  const s = slugify(name);
  return s.replace(/-summary$/, '').replace(/-notes?$/, '').replace(/-memo$/, '');
}

// Layer 判定: 'wiki/summaries/...' → summary、'wiki/...' → wiki、'raw-sources/...' → raw。
function layerForWikiPage(rel) {
  return rel.startsWith('summaries/') ? 'summary' : 'wiki';
}

// nodes / edges のレイアウト:
//   node id: 'wiki:<rel>' or 'raw:<rel>'。rel は subDir-relative posix slash。
function wikiNodeId(rel) { return `wiki:${rel}`; }
function rawNodeId(rel)  { return `raw:${rel}`; }

// Build the lineage graph for a vault.
//
// Returns:
//   {
//     schema_version,
//     generated_at,
//     hint_note,            // "estimated lineage" 注釈 (UI 表記用)
//     nodes,                // [{id, layer, name, path, type, title, mtime, frontmatter?}]
//     edges,                // [{source, target, kind, confidence, hint}]
//     hint_summary,         // {sha256: N, derived_from: N, filename: N, wikilink: N, time: N}
//     totals,               // {nodes: N, raw: N, summary: N, wiki: N, edges: N}
//     truncated,            // boolean (node_cap で削られた場合 true)
//     node_cap,
//   }
export async function buildLineageGraph(vault, options = {}) {
  if (typeof vault !== 'string' || !vault) {
    return emptyLineageResult(options.now);
  }
  const nodeCap = Number.isFinite(options.nodeCap) && options.nodeCap > 0
    ? Math.floor(options.nodeCap)
    : DEFAULT_NODE_CAP;
  const now = options.now instanceof Date ? options.now : new Date();
  const timeWindowSec = Number.isFinite(options.timeProximitySeconds) && options.timeProximitySeconds > 0
    ? options.timeProximitySeconds
    : TIME_PROXIMITY_SECONDS;

  // 1. Walk wiki/ and raw-sources/ in parallel
  const [wikiPages, rawSources] = await Promise.all([
    walkPages(vault, {
      subDir: 'wiki',
      withFrontmatter: true,
      withWikilinks: true,
      withBody: false,
      withMtime: true,
    }),
    walkPages(vault, {
      subDir: 'raw-sources',
      extensions: RAW_SOURCE_EXTENSIONS,
      withFrontmatter: false,
      withWikilinks: false,
      withBody: false,
      withMtime: true,
    }),
  ]);

  // 2. Build node list (raw + wiki, with layer classification)
  const allNodes = [];
  for (const p of rawSources) {
    allNodes.push({
      id: rawNodeId(p.rel),
      layer: 'raw',
      name: p.name,
      path: `raw-sources/${p.rel}`,
      type: 'raw',
      title: p.title,
      mtime: isoOrNull(p.mtime),
    });
  }
  for (const p of wikiPages) {
    const layer = layerForWikiPage(p.rel);
    const fmProjected = pickLineageFrontmatter(p.frontmatter);
    const node = {
      id: wikiNodeId(p.rel),
      layer,
      name: p.name,
      path: `wiki/${p.rel}`,
      type: p.type,
      title: p.title,
      mtime: isoOrNull(p.mtime),
    };
    if (fmProjected) node.frontmatter = fmProjected;
    allNodes.push(node);
  }

  // 3. Cap nodes by recency (newer first), preserve cross-layer balance.
  //    Performance acceptance (300 node 安定) は this cap で担保する。
  const { capped: cappedNodes, dropped } = capNodes(allNodes, nodeCap);
  const includedIds = new Set(cappedNodes.map((n) => n.id));

  // 4. Build edges per kind, only between included nodes.
  const edges = [];
  edges.push(...buildSha256Edges(wikiPages, includedIds));
  edges.push(...buildDerivedFromEdges(wikiPages, includedIds));
  edges.push(...buildFilenameEdges(wikiPages, rawSources, includedIds));
  edges.push(...buildWikilinkEdges(wikiPages, includedIds));
  edges.push(...buildTimeEdges(wikiPages, rawSources, includedIds, timeWindowSec));

  // Deduplicate (kind, source→target) pairs to avoid double-counting same hint.
  const dedupedEdges = dedupeEdges(edges);

  // 5. Hint summary
  const hintSummary = Object.fromEntries(EDGE_KINDS.map((k) => [k, 0]));
  for (const e of dedupedEdges) hintSummary[e.kind] = (hintSummary[e.kind] || 0) + 1;

  const totals = {
    nodes: cappedNodes.length,
    raw: cappedNodes.filter((n) => n.layer === 'raw').length,
    summary: cappedNodes.filter((n) => n.layer === 'summary').length,
    wiki: cappedNodes.filter((n) => n.layer === 'wiki').length,
    edges: dedupedEdges.length,
  };

  return {
    schema_version: LINEAGE_SCHEMA_VERSION,
    generated_at: now.toISOString(),
    hint_note: 'estimated lineage — best-effort heuristics, not a guaranteed reconstruction',
    nodes: cappedNodes,
    edges: dedupedEdges,
    hint_summary: hintSummary,
    totals,
    truncated: dropped > 0,
    node_cap: nodeCap,
  };
}

function emptyLineageResult(now) {
  const ts = now instanceof Date ? now : new Date();
  return {
    schema_version: LINEAGE_SCHEMA_VERSION,
    generated_at: ts.toISOString(),
    hint_note: 'estimated lineage — best-effort heuristics, not a guaranteed reconstruction',
    nodes: [],
    edges: [],
    hint_summary: Object.fromEntries(EDGE_KINDS.map((k) => [k, 0])),
    totals: { nodes: 0, raw: 0, summary: 0, wiki: 0, edges: 0 },
    truncated: false,
    node_cap: DEFAULT_NODE_CAP,
  };
}

// Cap nodes preserving recency. When `dropped > 0`, returns the most recent cap-many
// nodes per layer-weighted distribution (raw + summary prioritized as they are the
// lineage anchors that produced the wiki pages).
function capNodes(nodes, cap) {
  if (nodes.length <= cap) return { capped: nodes, dropped: 0 };
  // Sort by mtime desc (null mtime → oldest).
  const sorted = nodes.slice().sort((a, b) => {
    const aT = a.mtime ? Date.parse(a.mtime) : 0;
    const bT = b.mtime ? Date.parse(b.mtime) : 0;
    return bT - aT;
  });
  return { capped: sorted.slice(0, cap), dropped: nodes.length - cap };
}

// Edge builder: same source_sha256 frontmatter → connect wiki pages pairwise.
function buildSha256Edges(wikiPages, includedIds) {
  const edges = [];
  const groups = new Map(); // sha256 → [wiki node ids]
  for (const p of wikiPages) {
    const sha = p.frontmatter && p.frontmatter.source_sha256;
    if (typeof sha !== 'string' || sha.length === 0) continue;
    const id = wikiNodeId(p.rel);
    if (!includedIds.has(id)) continue;
    const list = groups.get(sha) || [];
    list.push(id);
    groups.set(sha, list);
  }
  for (const [sha, ids] of groups) {
    if (ids.length < 2) continue;
    const sorted = ids.slice().sort();
    const shaShort = sha.length > 10 ? `${sha.slice(0, 8)}…` : sha;
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        edges.push({
          source: sorted[i],
          target: sorted[j],
          kind: 'sha256',
          confidence: EDGE_CONFIDENCE.sha256,
          hint: `same source_sha256 (${shaShort})`,
        });
      }
    }
  }
  return edges;
}

// Edge builder: derived_from / source frontmatter explicit references.
// Resolution: 'concepts/jwt' / 'concepts/jwt.md' / 'raw-sources/pdf/foo.pdf' を試行
// (ref が wiki-relative なら wiki:、raw-sources/ prefix が付いていれば raw: に変換)。
function buildDerivedFromEdges(wikiPages, includedIds) {
  const edges = [];
  for (const p of wikiPages) {
    const fm = p.frontmatter || {};
    const refs = collectStringRefs(fm.derived_from).concat(collectStringRefs(fm.source));
    if (refs.length === 0) continue;
    const sourceId = wikiNodeId(p.rel);
    if (!includedIds.has(sourceId)) continue;
    for (const rawRef of refs) {
      const targetId = resolveRefToNodeId(rawRef, includedIds);
      if (!targetId || targetId === sourceId) continue;
      edges.push({
        source: sourceId,
        target: targetId,
        kind: 'derived_from',
        confidence: EDGE_CONFIDENCE.derived_from,
        hint: `frontmatter ref: ${rawRef}`,
      });
    }
  }
  return edges;
}

function collectStringRefs(value) {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) {
    const out = [];
    for (const v of value) {
      if (typeof v === 'string' && v.trim()) out.push(v.trim());
    }
    return out;
  }
  return [];
}

function resolveRefToNodeId(ref, includedIds) {
  if (typeof ref !== 'string' || !ref) return null;
  // Strip ./ prefix, normalize backslashes
  const clean = ref.replace(/^\.\//, '').replace(/\\/g, '/').replace(/^wiki\//, '').replace(/^raw-sources\//, '');
  const wantsRaw = /^raw-sources\//.test(ref);
  const candidates = wantsRaw
    ? [rawNodeId(clean), rawNodeId(`${clean}.md`)]
    : [
      wikiNodeId(clean),
      wikiNodeId(clean.endsWith('.md') ? clean : `${clean}.md`),
      rawNodeId(clean),
    ];
  for (const c of candidates) {
    if (includedIds.has(c)) return c;
  }
  return null;
}

// Edge builder: filename / slug 類似で summary ↔ raw-source を接続。
// "<slug>-summary.md" or "<slug>-notes.md" → "<slug>" raw source.
function buildFilenameEdges(wikiPages, rawSources, includedIds) {
  const edges = [];
  const rawByStem = new Map(); // slug → [{rel}]
  for (const r of rawSources) {
    const stem = slugify(r.name);
    if (!stem) continue;
    const list = rawByStem.get(stem) || [];
    list.push(r);
    rawByStem.set(stem, list);
  }
  for (const p of wikiPages) {
    if (p.type !== 'summary') continue;
    const stem = summarySlugStem(p.name);
    if (!stem) continue;
    const sourceId = wikiNodeId(p.rel);
    if (!includedIds.has(sourceId)) continue;
    const matches = rawByStem.get(stem) || [];
    for (const r of matches) {
      const targetId = rawNodeId(r.rel);
      if (!includedIds.has(targetId)) continue;
      edges.push({
        source: sourceId,
        target: targetId,
        kind: 'filename',
        confidence: EDGE_CONFIDENCE.filename,
        hint: `slug match: ${stem}`,
      });
    }
  }
  return edges;
}

// Edge builder: wiki page wikilink [[X]] → target wiki node.
function buildWikilinkEdges(wikiPages, includedIds) {
  const edges = [];
  const byRel = new Map();         // 'concepts/jwt.md' → id
  const byRelNoExt = new Map();    // 'concepts/jwt' → id
  const byBasename = new Map();    // 'jwt' → id (last writer wins acceptable here)
  for (const p of wikiPages) {
    const id = wikiNodeId(p.rel);
    byRel.set(p.rel, id);
    byRelNoExt.set(p.rel.replace(/\.md$/, ''), id);
    byBasename.set(p.name, id);
  }
  for (const p of wikiPages) {
    const sourceId = wikiNodeId(p.rel);
    if (!includedIds.has(sourceId)) continue;
    const wikilinks = Array.isArray(p.wikilinks) ? p.wikilinks : [];
    const seenTargets = new Set();
    for (const target of wikilinks) {
      const t = String(target).trim();
      if (!t) continue;
      let targetId = byRelNoExt.get(t) || byRel.get(t) || byBasename.get(t);
      if (!targetId) {
        const last = t.split('/').pop();
        targetId = byBasename.get(last);
      }
      if (!targetId || targetId === sourceId) continue;
      if (!includedIds.has(targetId)) continue;
      if (seenTargets.has(targetId)) continue; // same page → same target は 1 edge
      seenTargets.add(targetId);
      edges.push({
        source: sourceId,
        target: targetId,
        kind: 'wikilink',
        confidence: EDGE_CONFIDENCE.wikilink,
        hint: `[[${t}]]`,
      });
    }
  }
  return edges;
}

// Edge builder: cross-layer mtime proximity (raw ↔ summary or summary ↔ wiki etc.)。
// Same-layer pairs を skip (wiki-to-wiki proximity はノイズ、authoring session の副作用)。
function buildTimeEdges(wikiPages, rawSources, includedIds, windowSec) {
  const entries = [];
  for (const p of wikiPages) {
    if (!p.mtime) continue;
    const id = wikiNodeId(p.rel);
    if (!includedIds.has(id)) continue;
    entries.push({ id, layer: layerForWikiPage(p.rel), t: p.mtime.getTime() });
  }
  for (const r of rawSources) {
    if (!r.mtime) continue;
    const id = rawNodeId(r.rel);
    if (!includedIds.has(id)) continue;
    entries.push({ id, layer: 'raw', t: r.mtime.getTime() });
  }
  entries.sort((a, b) => a.t - b.t);

  const winMs = windowSec * 1000;
  const edges = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const delta = entries[j].t - entries[i].t;
      if (delta > winMs) break;
      if (entries[i].layer === entries[j].layer) continue;
      const deltaSec = Math.round(delta / 1000);
      edges.push({
        source: entries[i].id,
        target: entries[j].id,
        kind: 'time',
        confidence: EDGE_CONFIDENCE.time,
        hint: `Δ${deltaSec}s mtime proximity (${entries[i].layer}↔${entries[j].layer})`,
      });
    }
  }
  return edges;
}

// Same (kind, source, target) は最初のものだけ残す (sha256 と derived_from が同 pair に
// 共起した場合は両方残す — kind 違いは別の hint として価値があるため)。
function dedupeEdges(edges) {
  const seen = new Set();
  const out = [];
  for (const e of edges) {
    const key = `${e.kind}|${e.source}|${e.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

// Return a 1-2 hop subgraph centered on a node id. Intended as a runtime helper for
// UI integration (HTML embeds the full graph and may call this client-side via a
// JS port, or server-side for pre-rendered previews).
//
// hops: 1 or 2 (default 1)
// Returns {nodes, edges} — same shapes as buildLineageGraph output.
export function selectSubgraph(graph, centerId, hops = 1) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return { nodes: [], edges: [] };
  }
  const maxHops = hops === 2 ? 2 : 1;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  if (!nodeById.has(centerId)) return { nodes: [], edges: [] };

  const adj = new Map();
  for (const e of graph.edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.source).push(e);
    adj.get(e.target).push(e);
  }

  const visited = new Map(); // id → hop depth
  visited.set(centerId, 0);
  const queue = [[centerId, 0]];
  while (queue.length > 0) {
    const [id, depth] = queue.shift();
    if (depth >= maxHops) continue;
    const neighbors = adj.get(id) || [];
    for (const e of neighbors) {
      const next = e.source === id ? e.target : e.source;
      if (visited.has(next)) continue;
      visited.set(next, depth + 1);
      queue.push([next, depth + 1]);
    }
  }

  const includedIds = new Set(visited.keys());
  const subNodes = graph.nodes.filter((n) => includedIds.has(n.id));
  const subEdges = graph.edges.filter((e) => includedIds.has(e.source) && includedIds.has(e.target));
  return { nodes: subNodes, edges: subEdges };
}

// Test 用 internals (test 以外から import しないこと)
export const _internals = {
  pickLineageFrontmatter,
  slugify,
  summarySlugStem,
  layerForWikiPage,
  capNodes,
  buildSha256Edges,
  buildDerivedFromEdges,
  buildFilenameEdges,
  buildWikilinkEdges,
  buildTimeEdges,
  dedupeEdges,
  resolveRefToNodeId,
  RAW_SOURCE_EXTENSIONS,
};
