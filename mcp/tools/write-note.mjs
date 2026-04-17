// kioku_write_note — Claude Desktop からの「メモを Wiki に保存して」を受けて、
// session-logs/ に mcp-note 形式で書き出す。次回 auto-ingest が拾って wiki/ に構造化する。

import { mkdir, open, rename, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { z } from 'zod';
import { assertInsideSessionLogs } from '../lib/vault-path.mjs';
import { applyMasks } from '../lib/masking.mjs';
import { serializeFrontmatter } from '../lib/frontmatter.mjs';

const MAX_TITLE = 200;
const MAX_BODY = 65536;
const MAX_TAGS = 16;
const MAX_TAG_LEN = 32;
const MAX_SLUG_LEN = 50;

export const WRITE_NOTE_TOOL_DEF = {
  name: 'kioku_write_note',
  title: 'Save a KIOKU note (recommended write tool)',
  description:
    'Append a memo to KIOKU session-logs/. The next auto-ingest cycle will structure it into wiki/. ' +
    'PREFER THIS over kioku_write_wiki for normal note-taking. ' +
    'Use this when the user asks to "save", "remember", or "add to my wiki" without specifying a particular page. ' +
    'Returns the path immediately, but the structured wiki page appears only after the next ingest run.',
  inputShape: {
    title: z.string().min(1).max(MAX_TITLE),
    body: z.string().min(1).max(MAX_BODY),
    tags: z.array(z.string().min(1).max(MAX_TAG_LEN)).max(MAX_TAGS).optional(),
    source: z
      .string()
      .max(64)
      .optional()
      .describe('Origin label, e.g. "claude-desktop". Stored in frontmatter.'),
  },
};

export async function handleWriteNote(vault, args) {
  validate(args);
  // MASK_RULES を title / body / tags すべてに適用 (Desktop でうっかり貼った
  // 秘密が frontmatter / heading / 本文のいずれにも残らないようにする)。
  const title = applyMasks(String(args.title).trim());
  const body = applyMasks(String(args.body));
  const tags = Array.isArray(args.tags)
    ? dedupeStrings(args.tags).map(applyMasks)
    : [];
  const source = (args.source ?? 'claude-desktop').trim() || 'claude-desktop';

  const slug = makeSlug(title);
  const sessionLogsDir = join(vault, 'session-logs');
  await mkdir(sessionLogsDir, { recursive: true, mode: 0o700 });
  const baseName = `${nowStamp()}-mcp-${slug}`;
  const finalName = await pickAvailableName(sessionLogsDir, baseName);

  // 境界チェック (realpath は親ディレクトリ経由で解決される)
  await assertInsideSessionLogs(vault, finalName);

  const finalPath = join(sessionLogsDir, finalName);
  const frontmatter = {
    type: 'mcp-note',
    source,
    created: new Date().toISOString(),
    hostname: hostname(),
    ingested: false,
    related: [],
    tags,
  };
  const content = serializeFrontmatter(frontmatter, `\n# ${title}\n\n${body.replace(/\s+$/, '')}\n`);

  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
  const handle = await open(tmpPath, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
  await rename(tmpPath, finalPath);

  return {
    path: `session-logs/${finalName}`,
    action: 'created',
    note: 'Will be ingested into wiki/ on the next auto-ingest cycle.',
  };
}

function validate(args) {
  if (!args || typeof args !== 'object') {
    const e = new Error('args must be an object');
    e.code = 'invalid_params';
    throw e;
  }
  if (typeof args.title !== 'string' || !args.title.trim()) {
    const e = new Error('title is required');
    e.code = 'invalid_params';
    throw e;
  }
  if (args.title.length > MAX_TITLE) {
    const e = new Error(`title too long (max ${MAX_TITLE})`);
    e.code = 'invalid_params';
    throw e;
  }
  if (typeof args.body !== 'string' || !args.body) {
    const e = new Error('body is required');
    e.code = 'invalid_params';
    throw e;
  }
  if (args.body.length > MAX_BODY) {
    const e = new Error(`body too long (max ${MAX_BODY})`);
    e.code = 'invalid_params';
    throw e;
  }
  if (args.tags !== undefined && !Array.isArray(args.tags)) {
    const e = new Error('tags must be an array');
    e.code = 'invalid_params';
    throw e;
  }
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function makeSlug(title) {
  // ファイル名安全な集合 [A-Za-z0-9_-] と Unicode letter のみ残し、それ以外は - に置換。
  // .. によるトラバーサル文字列、パス区切り、制御文字、引用符すべて落とす。
  const cleaned = title
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  let slug = cleaned;
  if ([...slug].length > MAX_SLUG_LEN) {
    slug = [...slug].slice(0, MAX_SLUG_LEN).join('');
  }
  return slug || 'untitled';
}

async function pickAvailableName(dir, baseName) {
  const candidates = [`${baseName}.md`, ...Array.from({ length: 99 }, (_, i) => `${baseName}-${i + 2}.md`)];
  for (const name of candidates) {
    try {
      await stat(join(dir, name));
    } catch (err) {
      if (err.code === 'ENOENT') return name;
      throw err;
    }
  }
  // 100 ファイル以上の衝突は異常
  const e = new Error('too many filename collisions');
  e.code = 'collision_overflow';
  throw e;
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
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}
