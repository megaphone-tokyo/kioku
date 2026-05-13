// wiki-walker.mjs — Shared vault filesystem walker for wiki / raw-sources / summaries.
//
// §46 LEARN#8b N=3 mandatory refactor (open-issues §46) — Sprint 3 Phase 3 trigger.
// Three call sites converged on the same walk logic:
//   1. health-metrics.mjs#listWikiPages + readPageMeta  (11 metrics 計算用)
//   2. visualizer-data.mjs#walkLiveWikiPages            (first view graph_preview 用)
//   3. lineage-graph.mjs (Phase 3 NEW)                  (raw-sources / summaries / wiki 3 layer)
//
// Unified return shape (per file, when withBody=true the body/text fields are populated):
//   {
//     abs,           string  — absolute path
//     rel,           string  — relative to subDir root, posix slash
//     name,          string  — basename without extension
//     type,          string  — inferPageType(rel, frontmatter)
//     title,         string  — frontmatter.title > body H1 > basename
//     frontmatter?,  object  — parsed YAML frontmatter (only when withFrontmatter)
//     wikilinks?,    string[] — [[X]] targets (only when withWikilinks)
//     body?,         string  — body after frontmatter strip (only when withBody)
//     text?,         string  — raw file content (only when withBody)
//     mtime?,        Date    — fs.stat mtime (only when withMtime)
//   }
//
// Design contract:
//   - Read-only walk. Never writes anywhere in the vault.
//   - Corrupt / unreadable files are skipped silently (matches existing readPageMeta behaviour).
//   - Excluded dirs match existing kioku_list / health-metrics EXCLUDE set (.obsidian /
//     .archive / .trash / templates / .cache) plus dotfile-prefix skip.
//   - subDir nonexistent → returns [] (graceful: empty raw-sources/ in fresh vaults).

import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import { parseFrontmatter } from './frontmatter.mjs';
import { findWikilinks } from './wikilinks.mjs';

export const DEFAULT_EXCLUDE_DIRS = Object.freeze(
  new Set(['.obsidian', '.archive', '.trash', 'templates', '.cache']),
);

// wiki/ subdirectory naming convention. Used by inferPageType when frontmatter.type
// is missing — keeps backwards compat with the previously duplicated DIR_TO_TYPE
// (health-metrics.mjs) and PATH_TO_TYPE (visualizer-data.mjs).
const SUBDIR_TO_TYPE = Object.freeze({
  concepts: 'concept',
  projects: 'project',
  decisions: 'decision',
  summaries: 'summary',
  analyses: 'analysis',
  patterns: 'pattern',
  bugs: 'bug',
  meta: 'meta',
  viz: 'viz',
  people: 'person',
  sources: 'source',
});

// Resolve a wiki page type. Priority: special root files > frontmatter.type > subdir name > 'other'.
// Pass null/undefined frontmatter for raw-source files (no frontmatter expected).
export function inferPageType(rel, frontmatter) {
  if (rel === 'index.md') return 'index';
  if (rel === 'log.md') return 'log';
  if (rel === 'hot.md') return 'hot';
  const fmType = frontmatter && frontmatter.type;
  if (typeof fmType === 'string' && fmType.trim()) return fmType.trim();
  const top = rel.split('/')[0];
  if (SUBDIR_TO_TYPE[top]) return SUBDIR_TO_TYPE[top];
  return 'other';
}

// Title resolution: frontmatter.title → body first H1 → basename (sans extension).
// Body is optional — when omitted the H1 step is skipped.
export function resolvePageTitle(rel, frontmatter, body) {
  const fmTitle = frontmatter && frontmatter.title;
  if (typeof fmTitle === 'string' && fmTitle.trim()) return fmTitle.trim();
  if (typeof body === 'string' && body.length > 0) {
    const h1 = body.match(/^#\s+(.+?)\s*$/m);
    if (h1) return h1[1].trim();
  }
  return stripExtension(basename(rel));
}

function stripExtension(name) {
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return name; // no ext or dotfile only
  return name.slice(0, idx);
}

// Walk a vault subdir recursively, returning page metadata.
//
// vault     — absolute vault path
// options:
//   subDir          — relative to vault (default 'wiki')
//   excludeDirs     — Set of directory names to skip (default DEFAULT_EXCLUDE_DIRS)
//   extensions      — file extensions to collect (default ['.md']); raw-sources lineage
//                     call uses ['.md', '.pdf', '.epub', '.docx', '.txt']
//   withFrontmatter — parse YAML frontmatter (default true; ignored for non-.md files)
//   withWikilinks   — findWikilinks on text (default true; ignored for non-.md files)
//   withBody        — include text + body fields (default false)
//   withMtime       — include fs.stat mtime field (default false)
export async function walkPages(vault, options = {}) {
  if (typeof vault !== 'string' || !vault) return [];

  const subDir = typeof options.subDir === 'string' ? options.subDir : 'wiki';
  const excludeDirs = options.excludeDirs instanceof Set ? options.excludeDirs : DEFAULT_EXCLUDE_DIRS;
  const extensions = Array.isArray(options.extensions) && options.extensions.length > 0
    ? options.extensions
    : ['.md'];
  const extSet = new Set(extensions.map((e) => e.toLowerCase()));
  const withFrontmatter = options.withFrontmatter !== false;
  const withWikilinks = options.withWikilinks !== false;
  const withBody = options.withBody === true;
  const withMtime = options.withMtime === true;

  const rootDir = join(vault, subDir);
  let baseStat;
  try {
    baseStat = await stat(rootDir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  if (!baseStat.isDirectory()) return [];

  const out = [];
  async function walk(absDir) {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      throw err;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      if (excludeDirs.has(ent.name)) continue;
      const abs = join(absDir, ent.name);
      if (ent.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!ent.isFile()) continue;

      const lowerName = ent.name.toLowerCase();
      const dotIdx = lowerName.lastIndexOf('.');
      const ext = dotIdx > 0 ? lowerName.slice(dotIdx) : '';
      if (!extSet.has(ext)) continue;
      const isMarkdown = ext === '.md';

      let text = null;
      let st = null;
      try {
        if (isMarkdown && (withBody || withFrontmatter || withWikilinks)) {
          text = await readFile(abs, 'utf8');
        }
        if (withMtime) {
          st = await stat(abs);
        }
      } catch {
        // Corrupt / unreadable → skip silently (preserves existing readPageMeta contract).
        continue;
      }

      const rel = relative(rootDir, abs).split(sep).join('/');
      const name = stripExtension(basename(rel));

      let frontmatter = null;
      let body = '';
      if (text != null) {
        const parsed = parseFrontmatter(text);
        frontmatter = parsed.data || {};
        body = parsed.body || '';
      }
      const type = inferPageType(rel, frontmatter);
      const title = resolvePageTitle(rel, frontmatter, body);
      const wikilinks = withWikilinks && isMarkdown && text != null ? findWikilinks(text) : null;

      const page = { abs, rel, name, type, title };
      if (withFrontmatter) page.frontmatter = frontmatter || {};
      if (withWikilinks) page.wikilinks = wikilinks || [];
      if (withBody) {
        page.text = text != null ? text : '';
        page.body = body;
      }
      if (withMtime && st) page.mtime = st.mtime;
      out.push(page);
    }
  }
  await walk(rootDir);
  return out;
}

// Convenience: legacy-shape adapter used by health-metrics._internals for back-compat
// (tests/health-metrics.test.mjs invokes healthInternals.listWikiPages).
//
// Returns: [{abs, rel}]  — no metadata, matches the prior listWikiPages signature.
export async function listMarkdownRefs(vault, options = {}) {
  const pages = await walkPages(vault, {
    ...options,
    withFrontmatter: false,
    withWikilinks: false,
    withBody: false,
    withMtime: false,
  });
  return pages.map((p) => ({ abs: p.abs, rel: p.rel }));
}

export const _internals = {
  SUBDIR_TO_TYPE,
  stripExtension,
};
