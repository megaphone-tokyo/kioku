// kioku_write_wiki — wiki/ ページの直書き (即時反映)。
// テンプレ準拠 / frontmatter 自動付与 / wikilink 追記 / 排他ロック / 原子書き込み。

import { mkdir, open, readFile, readdir, rename, stat } from 'node:fs/promises';
import { join, dirname, basename, relative, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import { assertInsideWiki } from '../lib/vault-path.mjs';
import { applyMasks } from '../lib/masking.mjs';
import { mergeFrontmatter, parseFrontmatter, serializeFrontmatter } from '../lib/frontmatter.mjs';
import { appendRelatedLink } from '../lib/wikilinks.mjs';
import { withLock } from '../lib/lock.mjs';
import { loadTemplate, VALID_TEMPLATES } from '../lib/templates.mjs';

const MAX_TITLE = 200;
const MAX_BODY = 65536;
const MAX_TAGS = 16;
const MAX_RELATED = 16;

export const WRITE_WIKI_TOOL_DEF = {
  name: 'kioku_write_wiki',
  title: 'Write directly to KIOKU wiki (advanced)',
  description:
    'Direct write to wiki/<path>.md with frontmatter auto-injection. ' +
    'Use ONLY when the user explicitly wants the page to appear immediately AND accepts that template/wikilink integrity is best-effort. ' +
    'PREFER kioku_write_note for normal note-taking — it routes through auto-ingest which preserves wiki coherence.',
  inputShape: {
    path: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9/._ -]+\.md$/)
      .describe('Relative path under wiki/, e.g. "concepts/foo.md".'),
    title: z.string().min(1).max(MAX_TITLE),
    body: z.string().min(1).max(MAX_BODY),
    template: z.enum(['concept', 'project', 'decision', 'freeform']).optional(),
    tags: z.array(z.string().min(1).max(32)).max(MAX_TAGS).optional(),
    related: z.array(z.string().min(1).max(200)).max(MAX_RELATED).optional(),
    mode: z.enum(['create', 'append', 'merge']).optional(),
    source_session: z.string().max(128).optional(),
  },
};

export async function handleWriteWiki(vault, args) {
  validate(args);
  const path = args.path;
  // MASK_RULES を title / body / tags すべてに適用 (Desktop でうっかり貼った
  // 秘密が frontmatter / heading / 本文のいずれにも残らないようにする)。
  // related[] は他ページへのリンクキーとして使われるので、マスクすると
  // wikilink が壊れる。秘密を related に入れるユースケース自体が想定外で、
  // schema 200 文字制限と組み合わせてリスクを抑える。
  const title = applyMasks(String(args.title).trim());
  const body = applyMasks(String(args.body));
  const template = args.template ?? 'freeform';
  const tagsIn = Array.isArray(args.tags)
    ? dedupeStrings(args.tags).map(applyMasks)
    : [];
  const relatedIn = Array.isArray(args.related) ? dedupeStrings(args.related) : [];
  const mode = args.mode ?? 'create';
  const sourceSession = args.source_session ?? null;

  const abs = await assertInsideWiki(vault, path);

  return withLock(vault, async () => {
    let exists = false;
    try {
      const st = await stat(abs);
      exists = st.isFile();
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    if (mode === 'create' && exists) {
      const e = new Error(`file exists: ${path}`);
      e.code = 'file_exists';
      throw e;
    }

    const nowIso = new Date().toISOString();
    let templateData = { tags: [] };
    let templateBodyStub = '';
    if (template !== 'freeform') {
      const loaded = await loadTemplate(template);
      templateData = loaded.data ?? {};
      templateBodyStub = loaded.body ?? '';
    }

    const warnings = [];
    let action;
    let newContent;
    let existingContent = '';
    let existingFm = {};
    let existingBody = '';
    if (exists) {
      existingContent = await readFile(abs, 'utf8');
      const parsed = parseFrontmatter(existingContent);
      existingFm = parsed.data;
      existingBody = parsed.body;
    }

    if (mode === 'create' || !exists) {
      const fm = {
        title,
        tags: dedupeStrings([...(templateData.tags ?? []), ...tagsIn]),
        created: nowIso,
        updated: nowIso,
        source: 'mcp-write-wiki',
      };
      if (sourceSession) fm.source_session = sourceSession;
      const bodyForFile = template === 'freeform'
        ? `\n# ${title}\n\n${body.replace(/\s+$/, '')}\n`
        : composeFromTemplate(templateBodyStub, body);
      newContent = serializeFrontmatter(fm, bodyForFile);
      action = 'created';
    } else if (mode === 'append') {
      const updatedFm = mergeFrontmatter(existingFm, {
        updated: nowIso,
        source: 'mcp-write-wiki',
        ...(sourceSession ? { source_session: sourceSession } : {}),
      });
      const appendedBody = ensureTrailingNewline(existingBody) +
        `\n## ${nowIso}\n\n${body.replace(/\s+$/, '')}\n`;
      newContent = serializeFrontmatter(updatedFm, appendedBody);
      action = 'appended';
    } else if (mode === 'merge') {
      const updatedFm = mergeFrontmatter(existingFm, {
        tags: dedupeStrings([...(existingFm.tags ?? []), ...(templateData.tags ?? []), ...tagsIn]),
        updated: nowIso,
        source: 'mcp-write-wiki',
        ...(sourceSession ? { source_session: sourceSession } : {}),
      });
      const appendedBody = ensureTrailingNewline(existingBody) +
        `\n## ${nowIso}\n\n${body.replace(/\s+$/, '')}\n`;
      newContent = serializeFrontmatter(updatedFm, appendedBody);
      action = 'merged';
    } else {
      const e = new Error(`unknown mode: ${mode}`);
      e.code = 'invalid_params';
      throw e;
    }

    await mkdir(dirname(abs), { recursive: true, mode: 0o700 });
    await atomicWrite(abs, newContent);

    // related[] のリンク追記 (best-effort)
    if (relatedIn.length > 0) {
      const wikiAbs = await realpath(join(vault, 'wiki'));
      const titleIndex = await buildTitleIndex(wikiAbs);
      for (const target of relatedIn) {
        const targetAbs = titleIndex.get(target);
        if (!targetAbs) {
          warnings.push(`related target not found: ${target}`);
          continue;
        }
        if (targetAbs === abs) continue;
        try {
          const cur = await readFile(targetAbs, 'utf8');
          const updated = appendRelatedLink(cur, title);
          if (updated !== cur) {
            await atomicWrite(targetAbs, updated);
          }
        } catch (err) {
          warnings.push(`failed to update ${relative(wikiAbs, targetAbs)}: ${err.message}`);
        }
      }
    }

    return { path: `wiki/${path}`, action, warnings };
  });
}

function validate(args) {
  if (!args || typeof args !== 'object') {
    const e = new Error('args must be an object');
    e.code = 'invalid_params';
    throw e;
  }
  for (const k of ['path', 'title', 'body']) {
    if (typeof args[k] !== 'string' || !args[k].trim()) {
      const e = new Error(`${k} is required`);
      e.code = 'invalid_params';
      throw e;
    }
  }
  if (args.template && !VALID_TEMPLATES.has(args.template) && args.template !== 'freeform') {
    const e = new Error('invalid template');
    e.code = 'invalid_params';
    throw e;
  }
  if (args.mode && !['create', 'append', 'merge'].includes(args.mode)) {
    const e = new Error('invalid mode');
    e.code = 'invalid_params';
    throw e;
  }
}

function composeFromTemplate(templateBody, userBody) {
  // テンプレ最初の "## <heading>" 直下に user body を差し込む。
  // heading が見つからない場合は末尾に追記。
  const lines = templateBody.split('\n');
  const insertAt = lines.findIndex((l, i) => /^##\s+/.test(l) && i < lines.length);
  if (insertAt === -1) {
    return `${ensureTrailingNewline(templateBody)}\n${userBody.replace(/\s+$/, '')}\n`;
  }
  const head = lines.slice(0, insertAt + 1).join('\n');
  const tail = lines.slice(insertAt + 1).join('\n');
  return `${head}\n\n${userBody.replace(/\s+$/, '')}\n${tail.startsWith('\n') ? tail : '\n' + tail}`;
}

async function buildTitleIndex(wikiAbs) {
  const index = new Map();
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
      } else if (dirent.isFile() && dirent.name.endsWith('.md')) {
        try {
          const head = (await readFile(childAbs, 'utf8')).slice(0, 4096);
          const { data } = parseFrontmatter(head);
          if (typeof data.title === 'string' && data.title) {
            index.set(data.title, childAbs);
          }
          // ファイル名 (拡張子無し) もキーにする
          const stem = basename(dirent.name, '.md');
          if (!index.has(stem)) index.set(stem, childAbs);
        } catch {
          // skip
        }
      }
    }
  }
  await walk(wikiAbs);
  return index;
}

async function atomicWrite(absPath, content) {
  const tmp = `${absPath}.tmp.${process.pid}.${Date.now()}`;
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
  await rename(tmp, absPath);
}

function ensureTrailingNewline(s) {
  if (!s) return '';
  return s.endsWith('\n') ? s : s + '\n';
}

function dedupeStrings(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (typeof x !== 'string') continue;
    const t = x.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}
