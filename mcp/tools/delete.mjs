// kioku_delete — wiki/<path>.md を wiki/.archive/ に移動 (復元可能)。
// wiki/index.md は削除不可。wikilink 参照ありかつ force=false なら reject。

import { mkdir, readdir, readFile, rename, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import { assertInsideWiki } from '../lib/vault-path.mjs';
import { withLock } from '../lib/lock.mjs';
import { findWikilinks } from '../lib/wikilinks.mjs';
import { parseFrontmatter } from '../lib/frontmatter.mjs';

export const DELETE_TOOL_DEF = {
  name: 'kioku_delete',
  title: 'Archive a KIOKU wiki page',
  description:
    'Move a wiki page to wiki/.archive/<orig>-<UTC>.md (recoverable). ' +
    'If other pages contain [[<title>]] / [[<stem>]] references and force=false, the call is rejected with the list of broken links.',
  inputShape: {
    path: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9/._ -]+\.md$/)
      .describe('Relative path under wiki/, e.g. "concepts/foo.md".'),
    force: z.boolean().optional(),
  },
};

export async function handleDelete(vault, args) {
  validate(args);
  const path = args.path;
  const force = args.force === true;

  if (path === 'index.md' || path === 'wiki/index.md') {
    const e = new Error('cannot delete wiki/index.md');
    e.code = 'cannot_delete_index';
    throw e;
  }

  const abs = await assertInsideWiki(vault, path);

  return withLock(vault, async () => {
    let st;
    try {
      st = await stat(abs);
    } catch (err) {
      if (err.code === 'ENOENT') {
        const e = new Error('file not found');
        e.code = 'file_not_found';
        throw e;
      }
      throw err;
    }
    if (!st.isFile()) {
      const e = new Error('not a regular file');
      e.code = 'not_a_file';
      throw e;
    }

    // index.md realpath fallback (パス比較ではなく実体)
    const wikiAbs = await realpath(join(vault, 'wiki'));
    if (abs === join(wikiAbs, 'index.md')) {
      const e = new Error('cannot delete wiki/index.md');
      e.code = 'cannot_delete_index';
      throw e;
    }

    // 削除対象のタイトルとファイル stem を集める
    let title = null;
    try {
      const head = await readFile(abs, 'utf8');
      const { data } = parseFrontmatter(head);
      if (typeof data.title === 'string' && data.title) title = data.title;
    } catch {
      // ignore
    }
    const stem = basename(abs, '.md');
    const targets = new Set([stem]);
    if (title) targets.add(title);

    // wiki/ 全走査で参照を集める
    const brokenLinks = await scanReferences(wikiAbs, abs, targets);

    if (brokenLinks.length > 0 && !force) {
      const e = new Error('broken links detected (use force=true to override)');
      e.code = 'broken_links_detected';
      e.data = { brokenLinks };
      throw e;
    }

    // .archive/<orig dir>/<orig stem>-<UTC>.md に移動
    // wikiAbs (realpath) を起点に組むことで symlink (例: /tmp -> /private/tmp) によるパス不整合を回避
    const archiveDir = join(wikiAbs, '.archive');
    await mkdir(archiveDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const relFromWiki = relative(wikiAbs, abs);
    const archiveSubdir = dirname(relFromWiki);
    const archiveFinalDir = archiveSubdir === '.' ? archiveDir : join(archiveDir, archiveSubdir);
    if (archiveFinalDir !== archiveDir) {
      await mkdir(archiveFinalDir, { recursive: true, mode: 0o700 });
    }
    const archiveName = `${basename(abs, '.md')}-${stamp}.md`;
    const archiveAbs = join(archiveFinalDir, archiveName);

    await rename(abs, archiveAbs);

    return {
      archivedPath: 'wiki/' + relative(wikiAbs, archiveAbs).split(sep).join('/'),
      brokenLinks,
    };
  });
}

function validate(args) {
  if (!args || typeof args !== 'object') {
    const e = new Error('args must be an object');
    e.code = 'invalid_params';
    throw e;
  }
  if (typeof args.path !== 'string' || !args.path.trim()) {
    const e = new Error('path is required');
    e.code = 'invalid_params';
    throw e;
  }
}

async function scanReferences(wikiAbs, targetAbs, targetSet) {
  const out = [];
  const exclude = new Set(['.obsidian', '.archive', '.trash', 'templates']);
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of entries) {
      if (exclude.has(dirent.name)) continue;
      if (dirent.name.startsWith('.')) continue;
      const childAbs = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(childAbs);
      } else if (dirent.isFile() && dirent.name.endsWith('.md') && childAbs !== targetAbs) {
        try {
          const c = await readFile(childAbs, 'utf8');
          // 生 [[<target>]] の出現回数を数える (findWikilinks は dedupe するので別カウント)
          let occ = 0;
          for (const m of c.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
            const target = m[1].split('|')[0].split('#')[0].trim();
            if (targetSet.has(target)) occ++;
          }
          if (occ > 0) {
            out.push({
              sourcePath: 'wiki/' + relative(wikiAbs, childAbs).split(sep).join('/'),
              occurrences: occ,
            });
          }
        } catch {
          // skip unreadable
        }
      }
    }
  }
  await walk(wikiAbs);
  return out;
}
