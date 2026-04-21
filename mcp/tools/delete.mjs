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
      .regex(/^[\p{L}\p{N}/._ -]+\.md$/u)
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

    // 2026-04-20 HIGH-a1 fix: wiki/ だけでなく raw-sources/ 配下も走査対象にする。
    // 機能 2.2 で `raw-sources/<subdir>/fetched/*.md` が LLM 生成の [[...]] wikilink
    // を持ちうるが、旧実装では wiki/ のみしか走査しないため、fetched 側からのリンクが
    // 残った状態で wiki ページを archive すると broken_links_detected が発火せず
    // silent orphan 化していた。
    const vaultAbs = await realpath(vault);
    const { brokenLinks, skippedLargeFiles, skippedUnreadable } =
      await scanReferences(vaultAbs, wikiAbs, abs, targets);

    if (brokenLinks.length > 0 && !force) {
      const e = new Error('broken links detected (use force=true to override)');
      e.code = 'broken_links_detected';
      e.data = { brokenLinks, skippedLargeFiles, skippedUnreadable };
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
      skippedLargeFiles,
      skippedUnreadable,
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

// 2026-04-20 NEW-M1 fix: scanReferences walker は wiki/ に加え raw-sources/ も
// 舐めるようになった (HIGH-a1 fix) が、`raw-sources/<subdir>/fetched/*.md` は
// attacker-controlled な HTML → Markdown 化 出力を含みうる。size cap なしで
// readFile(..., 'utf8') を回すと、500 本の大きな fetched MD が仕込まれた場合に
// kioku_delete が withLock を長時間掴んで他 MCP 操作をブロックする (DoS 表面拡大)。
// 2MB 超のファイルは scan 対象から外す: wiki/ の通常運用では個別ページがこの
// サイズを超えることはほぼなく、attacker-controlled な巨大 MD だけが弾かれる。
const SCAN_MAX_BYTES = 2_000_000;

async function scanReferences(vaultAbs, wikiAbs, targetAbs, targetSet) {
  // 2026-04-20 HIGH-a1 fix: vault ルートから走査して wiki/ + raw-sources/ の両方を
  // 対象に入れる。session-logs / .cache / .obsidian / node_modules 等は除外。
  const out = [];
  const skipped = [];
  // 2026-04-21 L-2 fix: readFile 失敗を silent catch せず operator 視認性を残す。
  // SCAN_MAX_BYTES (size cap) の先を抜けて readFile が EACCES / EIO / ENOENT
  // (symlink 切れ 等) で落ちたときは skippedUnreadable[] に記録して caller に返す。
  const unreadable = [];
  // ディレクトリ名除外 (トップレベルおよび任意階層)
  const excludeDirs = new Set([
    '.obsidian', '.archive', '.trash', 'templates',
    '.cache', 'session-logs', 'node_modules', '.git',
  ]);
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of entries) {
      if (excludeDirs.has(dirent.name)) continue;
      if (dirent.name.startsWith('.')) continue;
      const childAbs = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(childAbs);
      } else if (dirent.isFile() && dirent.name.endsWith('.md') && childAbs !== targetAbs) {
        try {
          // NEW-M1 fix: size cap を先にチェックする。st.isFile() は readdir 側で
          // 確認済。2MB 超は readFile せず skipped[] に記録して operator 視認性を残す。
          const st = await stat(childAbs);
          if (st.size > SCAN_MAX_BYTES) {
            const relFromVault = relative(vaultAbs, childAbs).split(sep).join('/');
            skipped.push({ sourcePath: relFromVault, size: st.size });
            continue;
          }
          const c = await readFile(childAbs, 'utf8');
          // 生 [[<target>]] の出現回数を数える (findWikilinks は dedupe するので別カウント)
          let occ = 0;
          for (const m of c.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
            const target = m[1].split('|')[0].split('#')[0].trim();
            if (targetSet.has(target)) occ++;
          }
          if (occ > 0) {
            // sourcePath は vault からの相対パス。wiki/ 以外の出所 (例: raw-sources/)
            // は operator が「どこから参照されているか」で判断できるよう prefix を保持。
            const relFromVault = relative(vaultAbs, childAbs).split(sep).join('/');
            const inWiki = childAbs.startsWith(wikiAbs + sep) || childAbs === wikiAbs;
            out.push({
              sourcePath: relFromVault,
              occurrences: occ,
              inWiki,
            });
          }
        } catch (err) {
          // L-2 fix: silent skip せず skippedUnreadable[] に記録。
          // error フィールドは運用側で EACCES / EIO / ENOENT 等を区別できるよう
          // code を優先し、無ければ message 先頭 200 char に truncate する
          // (攻撃者制御の長大 error メッセージで operator 視認性を損なわないため)。
          const relFromVault = relative(vaultAbs, childAbs).split(sep).join('/');
          const errStr = typeof err?.code === 'string' && err.code
            ? err.code
            : String(err?.message ?? 'unknown').slice(0, 200);
          unreadable.push({ sourcePath: relFromVault, error: errStr });
        }
      }
    }
  }
  await walk(vaultAbs);
  return { brokenLinks: out, skippedLargeFiles: skipped, skippedUnreadable: unreadable };
}
