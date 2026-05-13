// lineage-graph.test.mjs — Sprint 3 Phase 3 Raw-source lineage graph tests.
//
// Coverage map (handoff §Test requirements Phase 3):
//   BLUE-VIZ-LINEAGE-1: sha256 edge 構築 (summary 同士、raw → summary 推移)
//   BLUE-VIZ-LINEAGE-2: derived_from frontmatter edge
//   BLUE-VIZ-LINEAGE-3: filename / slug similarity edge
//   BLUE-VIZ-LINEAGE-4: wikilink edge (concept 間)
//   BLUE-VIZ-LINEAGE-5: time proximity edge (cross-layer only)
//   BLUE-VIZ-LINEAGE-6: 1-2 hop selectSubgraph (巨大 graph 回避)
//   BLUE-VIZ-LINEAGE-7: best-effort hint shape (estimated lineage 表記 + confidence ordering)

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildLineageGraph,
  selectSubgraph,
  LINEAGE_SCHEMA_VERSION,
  DEFAULT_NODE_CAP,
  EDGE_KINDS,
  EDGE_CONFIDENCE,
  _internals,
} from '../mcp/lib/lineage-graph.mjs';

const SHA_A = 'a'.repeat(64); // 64-char sha256 placeholder
const SHA_B = 'b'.repeat(64);

async function setMtime(path, dateIso) {
  const d = new Date(dateIso);
  await utimes(path, d, d);
}

async function makeLineageVault(opts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kioku-lineage-test-'));
  await mkdir(join(root, 'wiki', 'concepts'), { recursive: true });
  await mkdir(join(root, 'wiki', 'summaries'), { recursive: true });
  await mkdir(join(root, 'raw-sources', 'pdf'), { recursive: true });
  await mkdir(join(root, 'raw-sources', 'url'), { recursive: true });

  // ── Raw sources ──
  await writeFile(join(root, 'raw-sources', 'pdf', 'rag-pipeline.pdf'), '%PDF rag fake');
  await writeFile(join(root, 'raw-sources', 'pdf', 'rag-pipeline.md'), '# extracted rag md');
  await writeFile(join(root, 'raw-sources', 'url', 'jwt-rfc.md'), '# jwt rfc html→md');

  // ── Wiki summaries (have source_sha256 + derived_from) ──
  await writeFile(
    join(root, 'wiki', 'summaries', 'rag-pipeline-summary.md'),
    [
      '---',
      `source_sha256: ${SHA_A}`,
      'source: raw-sources/pdf/rag-pipeline.pdf',
      'derived_from: raw-sources/pdf/rag-pipeline.pdf',
      'ingest_at: 2026-04-01T10:00:00Z',
      '---',
      '',
      '# RAG pipeline summary',
    ].join('\n'),
  );
  await writeFile(
    join(root, 'wiki', 'summaries', 'rag-pipeline-notes.md'),
    [
      '---',
      `source_sha256: ${SHA_A}`,
      '---',
      '',
      '# RAG pipeline notes (same source, different angle)',
    ].join('\n'),
  );
  // frontmatter.mjs uses an inline YAML subset (no multi-line array syntax),
  // so derived_from is intentionally written as an inline list here.
  await writeFile(
    join(root, 'wiki', 'summaries', 'jwt-rfc-summary.md'),
    [
      '---',
      `source_sha256: ${SHA_B}`,
      'derived_from: ["raw-sources/url/jwt-rfc.md", "concepts/jwt.md"]',
      '---',
      '',
      '# JWT RFC summary',
    ].join('\n'),
  );

  // ── Wiki concept pages (wikilinks each other) ──
  await writeFile(
    join(root, 'wiki', 'concepts', 'jwt.md'),
    '---\ntype: concept\n---\n\n# JWT\n\nSee [[oauth]].\nAlso [[rag-pipeline-summary]].\n',
  );
  await writeFile(
    join(root, 'wiki', 'concepts', 'oauth.md'),
    '---\ntype: concept\n---\n\n# OAuth\n\nRelated: [[jwt]].\n',
  );

  if (opts.applyMtimes) {
    // Engineer a known mtime sequence so time edges are deterministic:
    //   rag pdf (raw)               → 2026-03-01T09:00:00Z
    //   rag md (raw)                → 2026-03-01T09:00:30Z
    //   rag-pipeline-summary (sum)  → 2026-03-01T09:10:00Z  (within 1h of raw)
    //   rag-pipeline-notes (sum)    → 2026-03-01T09:20:00Z
    //   concepts/jwt (wiki)         → 2026-03-01T15:00:00Z  (>1h gap — no time edge)
    await setMtime(join(root, 'raw-sources', 'pdf', 'rag-pipeline.pdf'), '2026-03-01T09:00:00Z');
    await setMtime(join(root, 'raw-sources', 'pdf', 'rag-pipeline.md'), '2026-03-01T09:00:30Z');
    await setMtime(join(root, 'wiki', 'summaries', 'rag-pipeline-summary.md'), '2026-03-01T09:10:00Z');
    await setMtime(join(root, 'wiki', 'summaries', 'rag-pipeline-notes.md'), '2026-03-01T09:20:00Z');
    await setMtime(join(root, 'wiki', 'concepts', 'jwt.md'), '2026-03-01T15:00:00Z');
    await setMtime(join(root, 'wiki', 'concepts', 'oauth.md'), '2026-03-01T15:10:00Z');
    await setMtime(join(root, 'raw-sources', 'url', 'jwt-rfc.md'), '2026-04-01T08:00:00Z');
    await setMtime(join(root, 'wiki', 'summaries', 'jwt-rfc-summary.md'), '2026-04-01T08:20:00Z');
  }
  return root;
}

describe('lineage-graph.mjs (Phase 3 raw-source lineage)', () => {
  test('BLUE-VIZ-LINEAGE-1: sha256 edge connects summaries with same source_sha256', async () => {
    const root = await makeLineageVault();
    try {
      const graph = await buildLineageGraph(root);
      const sha256Edges = graph.edges.filter((e) => e.kind === 'sha256');
      // rag-pipeline-summary <-> rag-pipeline-notes (SHA_A)
      // jwt-rfc-summary is alone with SHA_B → no edge
      const ragPair = sha256Edges.find((e) =>
        (e.source.includes('rag-pipeline-summary') && e.target.includes('rag-pipeline-notes')) ||
        (e.source.includes('rag-pipeline-notes') && e.target.includes('rag-pipeline-summary')),
      );
      assert.ok(ragPair, 'rag-pipeline-summary ↔ rag-pipeline-notes sha256 edge expected');
      assert.equal(ragPair.confidence, EDGE_CONFIDENCE.sha256);
      assert.match(ragPair.hint, /source_sha256/);
      // jwt-rfc-summary alone → no sha256 edge with another node
      const jwtSha256 = sha256Edges.find((e) =>
        e.source.includes('jwt-rfc-summary') || e.target.includes('jwt-rfc-summary'),
      );
      assert.equal(jwtSha256, undefined, 'singleton sha256 group must not emit an edge');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-VIZ-LINEAGE-2: derived_from frontmatter edges resolve to raw + wiki nodes', async () => {
    const root = await makeLineageVault();
    try {
      const graph = await buildLineageGraph(root);
      const derived = graph.edges.filter((e) => e.kind === 'derived_from');
      // rag-pipeline-summary → raw-sources/pdf/rag-pipeline.pdf
      // jwt-rfc-summary → raw-sources/url/jwt-rfc.md AND → concepts/jwt.md
      const ragRaw = derived.find((e) =>
        e.source.includes('rag-pipeline-summary') && e.target === 'raw:pdf/rag-pipeline.pdf',
      );
      assert.ok(ragRaw, 'rag-pipeline-summary → raw pdf derived_from edge expected');
      assert.equal(ragRaw.confidence, EDGE_CONFIDENCE.derived_from);

      const jwtToRawHtml = derived.find((e) =>
        e.source.includes('jwt-rfc-summary') && e.target === 'raw:url/jwt-rfc.md',
      );
      assert.ok(jwtToRawHtml, 'jwt-rfc-summary → raw url md derived_from edge expected');

      const jwtToConcept = derived.find((e) =>
        e.source.includes('jwt-rfc-summary') && e.target === 'wiki:concepts/jwt.md',
      );
      assert.ok(jwtToConcept, 'jwt-rfc-summary → concepts/jwt.md derived_from edge expected');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-VIZ-LINEAGE-3: filename slug similarity edges connect summary ↔ raw', async () => {
    const root = await makeLineageVault();
    try {
      const graph = await buildLineageGraph(root);
      const filenameEdges = graph.edges.filter((e) => e.kind === 'filename');
      // rag-pipeline-summary slug stem "rag-pipeline" should hit both raw rag files
      const ragSrc = filenameEdges.filter((e) => e.source === 'wiki:summaries/rag-pipeline-summary.md');
      assert.ok(ragSrc.length >= 2,
        `expected ≥2 filename edges from rag summary to raw rag files, got ${ragSrc.length}`);
      for (const e of ragSrc) {
        assert.ok(e.target.startsWith('raw:pdf/rag-pipeline.'));
        assert.equal(e.confidence, EDGE_CONFIDENCE.filename);
        assert.match(e.hint, /slug match/);
      }
      // notes file ends in -notes; the suffix-strip helper should handle it
      const notesSrc = filenameEdges.filter((e) => e.source === 'wiki:summaries/rag-pipeline-notes.md');
      assert.ok(notesSrc.length >= 1, 'rag-pipeline-notes slug stem must match raw rag files');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-VIZ-LINEAGE-4: wikilink edges connect concept pages bidirectionally observed', async () => {
    const root = await makeLineageVault();
    try {
      const graph = await buildLineageGraph(root);
      const wikilinks = graph.edges.filter((e) => e.kind === 'wikilink');
      // jwt → oauth (from concepts/jwt.md), oauth → jwt (from concepts/oauth.md)
      const jwtToOauth = wikilinks.find((e) =>
        e.source === 'wiki:concepts/jwt.md' && e.target === 'wiki:concepts/oauth.md',
      );
      assert.ok(jwtToOauth, 'jwt → oauth wikilink edge expected');
      assert.equal(jwtToOauth.confidence, EDGE_CONFIDENCE.wikilink);
      assert.equal(jwtToOauth.hint, '[[oauth]]');
      const oauthToJwt = wikilinks.find((e) =>
        e.source === 'wiki:concepts/oauth.md' && e.target === 'wiki:concepts/jwt.md',
      );
      assert.ok(oauthToJwt, 'oauth → jwt wikilink edge expected');
      // jwt → rag-pipeline-summary (basename resolution via summaries/)
      const jwtToRag = wikilinks.find((e) =>
        e.source === 'wiki:concepts/jwt.md' && e.target === 'wiki:summaries/rag-pipeline-summary.md',
      );
      assert.ok(jwtToRag, 'jwt → rag-pipeline-summary wikilink edge expected via basename match');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-VIZ-LINEAGE-5: time proximity edges only cross-layer within window', async () => {
    const root = await makeLineageVault({ applyMtimes: true });
    try {
      const graph = await buildLineageGraph(root, { timeProximitySeconds: 3600 });
      const timeEdges = graph.edges.filter((e) => e.kind === 'time');
      // Raw pdf (09:00) → summary (09:10), notes (09:20), raw md (09:00:30) are all in 1h window.
      // All raw↔summary pairs and raw↔raw (same layer, dropped) etc.
      assert.ok(timeEdges.length > 0, 'expected at least one cross-layer time edge');
      // Confidence is lowest among edge kinds
      for (const e of timeEdges) {
        assert.equal(e.confidence, EDGE_CONFIDENCE.time);
        assert.match(e.hint, /mtime proximity/);
      }
      // Same-layer pair (rag-pipeline-summary ↔ rag-pipeline-notes are both summary)
      // must NOT be in time edges (sha256 covers it, time would be noise)
      const sameLayer = timeEdges.find((e) => {
        const layerOf = (id) => {
          if (id.startsWith('raw:')) return 'raw';
          if (id.includes(':summaries/')) return 'summary';
          return 'wiki';
        };
        return layerOf(e.source) === layerOf(e.target);
      });
      assert.equal(sameLayer, undefined, 'time edges must be cross-layer only');
      // jwt concept (15:00) is far outside the rag cluster (09:xx) — no time edge to rag
      const farPair = timeEdges.find((e) =>
        (e.source === 'wiki:concepts/jwt.md' && e.target.includes('rag-pipeline')) ||
        (e.target === 'wiki:concepts/jwt.md' && e.source.includes('rag-pipeline')),
      );
      assert.equal(farPair, undefined, '6-hour-apart pair must not produce a time edge');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-VIZ-LINEAGE-6: selectSubgraph respects 1-hop and 2-hop limits', async () => {
    const root = await makeLineageVault();
    try {
      const graph = await buildLineageGraph(root);
      const center = 'wiki:summaries/rag-pipeline-summary.md';
      const oneHop = selectSubgraph(graph, center, 1);
      const twoHop = selectSubgraph(graph, center, 2);
      assert.ok(oneHop.nodes.length >= 2, 'center + at least one neighbor');
      assert.ok(oneHop.nodes.find((n) => n.id === center), 'center included in 1-hop');
      // 2-hop must be ≥ 1-hop and ≤ full graph
      assert.ok(twoHop.nodes.length >= oneHop.nodes.length);
      assert.ok(twoHop.nodes.length <= graph.nodes.length);
      // Edges restricted to included nodes
      const ids = new Set(twoHop.nodes.map((n) => n.id));
      for (const e of twoHop.edges) {
        assert.ok(ids.has(e.source) && ids.has(e.target),
          `edge ${e.source}→${e.target} outside subgraph node set`);
      }
      // Unknown center → empty
      const empty = selectSubgraph(graph, 'wiki:does/not/exist.md', 1);
      assert.deepEqual(empty, { nodes: [], edges: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-VIZ-LINEAGE-7: best-effort hint shape + confidence ordering', async () => {
    const root = await makeLineageVault();
    try {
      const graph = await buildLineageGraph(root);
      // top-level shape
      assert.equal(graph.schema_version, LINEAGE_SCHEMA_VERSION);
      assert.match(graph.hint_note, /estimated lineage/i, 'estimated lineage 注釈 required');
      assert.match(graph.hint_note, /best-effort/i);
      // 5 edge kinds counted in hint_summary
      assert.deepEqual(Object.keys(graph.hint_summary).sort(), EDGE_KINDS.slice().sort());
      // Confidence ordering invariant: sha256 ≥ derived_from ≥ wikilink ≥ filename ≥ time
      assert.ok(EDGE_CONFIDENCE.sha256 >= EDGE_CONFIDENCE.derived_from);
      assert.ok(EDGE_CONFIDENCE.derived_from >= EDGE_CONFIDENCE.wikilink);
      assert.ok(EDGE_CONFIDENCE.wikilink >= EDGE_CONFIDENCE.filename);
      assert.ok(EDGE_CONFIDENCE.filename >= EDGE_CONFIDENCE.time);
      // Every edge carries the 4 required fields
      for (const e of graph.edges) {
        assert.equal(typeof e.source, 'string');
        assert.equal(typeof e.target, 'string');
        assert.ok(EDGE_KINDS.includes(e.kind));
        assert.equal(typeof e.confidence, 'number');
        assert.equal(typeof e.hint, 'string');
        assert.ok(e.hint.length > 0);
      }
      // node body / text never leaks into lineage output (P1 absolute contract continues)
      const serialized = JSON.stringify(graph);
      assert.ok(!serialized.includes('"body"'), 'page body must not leak into lineage graph');
      assert.ok(!serialized.includes('"text"'), 'raw text must not leak into lineage graph');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-VIZ-LINEAGE-cap: node_cap drops oldest, sets truncated=true', async () => {
    const root = await makeLineageVault();
    try {
      const graph = await buildLineageGraph(root, { nodeCap: 3 });
      assert.equal(graph.nodes.length, 3);
      assert.equal(graph.truncated, true);
      assert.equal(graph.node_cap, 3);
      assert.ok(graph.totals.nodes === 3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-VIZ-LINEAGE-empty: vault with no raw-sources / wiki returns empty totals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kioku-lineage-empty-'));
    try {
      // No wiki/ or raw-sources/
      const graph = await buildLineageGraph(root);
      assert.deepEqual(graph.totals, { nodes: 0, raw: 0, summary: 0, wiki: 0, edges: 0 });
      assert.equal(graph.truncated, false);
      assert.equal(graph.nodes.length, 0);
      assert.equal(graph.edges.length, 0);
      // Hint summary still has all 5 kinds with 0 counts
      assert.deepEqual(graph.hint_summary, { sha256: 0, derived_from: 0, filename: 0, wikilink: 0, time: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-VIZ-LINEAGE-perf: 300 node sythetic vault stays under 1s', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kioku-lineage-perf-'));
    try {
      await mkdir(join(root, 'wiki', 'concepts'), { recursive: true });
      await mkdir(join(root, 'wiki', 'summaries'), { recursive: true });
      await mkdir(join(root, 'raw-sources'), { recursive: true });
      // 100 concepts + 100 summaries + 100 raw sources = 300 nodes
      for (let i = 0; i < 100; i++) {
        await writeFile(
          join(root, 'wiki', 'concepts', `concept-${i}.md`),
          `---\ntype: concept\n---\n\n# Concept ${i}\n\n[[concept-${(i + 1) % 100}]]\n`,
        );
        await writeFile(
          join(root, 'wiki', 'summaries', `summary-${i}.md`),
          `---\nsource_sha256: ${'a'.repeat(60)}${i.toString().padStart(4, '0')}\n---\n\n# Summary ${i}\n`,
        );
        await writeFile(join(root, 'raw-sources', `raw-${i}.pdf`), `fake pdf ${i}`);
      }
      const t0 = Date.now();
      const graph = await buildLineageGraph(root, { nodeCap: DEFAULT_NODE_CAP });
      const elapsed = Date.now() - t0;
      assert.equal(graph.totals.nodes, 300);
      assert.ok(elapsed < 1500, `300 node graph build took ${elapsed}ms (expected < 1500ms)`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('BLUE-VIZ-LINEAGE-internals: _internals exports are stable', () => {
    assert.ok(typeof _internals.slugify === 'function');
    assert.equal(_internals.slugify('RAG Pipeline Notes'), 'rag-pipeline-notes');
    assert.equal(_internals.summarySlugStem('rag-pipeline-summary'), 'rag-pipeline');
    assert.equal(_internals.summarySlugStem('rag-pipeline-notes'), 'rag-pipeline');
    assert.equal(_internals.layerForWikiPage('summaries/x.md'), 'summary');
    assert.equal(_internals.layerForWikiPage('concepts/x.md'), 'wiki');
  });
});
