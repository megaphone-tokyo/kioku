// kioku_list — Wiki ディレクトリツリーを返す。
// .obsidian/ .archive/ .trash/ templates/ を除外、深さ・件数を上限でクランプ。

import { readdir, realpath, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { assertInsideWiki } from '../lib/vault-path.mjs';

const MAX_DEPTH = 5;
const MAX_ENTRIES = 1000;
const EXCLUDE_DIRS = new Set(['.obsidian', '.archive', '.trash', 'templates']);

export const LIST_TOOL_DEF = {
  name: 'kioku_list',
  title: 'List KIOKU wiki tree',
  description:
    'List Markdown pages and directories under the KIOKU wiki. Returns at most 1000 entries; depth defaults to 3 (max 5).',
  inputShape: {
    subdir: z
      .string()
      .max(256)
      .optional()
      .describe('Subdirectory under wiki/ (default: "" = wiki root).'),
    depth: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .describe('Maximum recursion depth (1-5, default 3).'),
  },
};

export async function handleList(vault, args = {}) {
  const subdir = (args.subdir ?? '').trim();
  const depth = clamp(Number.isInteger(args.depth) ? args.depth : 3, 1, MAX_DEPTH);

  let baseAbs;
  if (subdir === '') {
    try {
      baseAbs = await realpath(join(vault, 'wiki'));
    } catch (err) {
      if (err.code === 'ENOENT') {
        const e = new Error('wiki directory not found');
        e.code = 'dir_not_found';
        throw e;
      }
      throw err;
    }
  } else {
    baseAbs = await assertInsideWiki(vault, subdir);
  }

  let baseStat;
  try {
    baseStat = await stat(baseAbs);
  } catch (err) {
    if (err.code === 'ENOENT') {
      const e = new Error('directory not found');
      e.code = 'dir_not_found';
      throw e;
    }
    throw err;
  }
  if (!baseStat.isDirectory()) {
    const e = new Error('not a directory');
    e.code = 'not_a_dir';
    throw e;
  }

  const entries = [];
  let truncated = false;

  async function walk(absDir, currentDepth) {
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      return;
    }
    let names;
    try {
      names = await readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    names.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of names) {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        return;
      }
      if (EXCLUDE_DIRS.has(dirent.name)) continue;
      if (dirent.name.startsWith('.')) continue;
      const childAbs = join(absDir, dirent.name);
      const rel = relative(baseAbs, childAbs).split(sep).join('/');
      if (dirent.isDirectory()) {
        entries.push({ path: rel, type: 'dir' });
        if (currentDepth < depth) {
          await walk(childAbs, currentDepth + 1);
        }
      } else if (dirent.isFile() && dirent.name.endsWith('.md')) {
        try {
          const st = await stat(childAbs);
          entries.push({
            path: rel,
            type: 'file',
            size: st.size,
            mtime: st.mtime.toISOString(),
          });
        } catch {
          // ignore
        }
      }
    }
  }

  await walk(baseAbs, 1);

  return {
    base: subdir === '' ? '' : subdir,
    entries,
    truncated,
  };
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
