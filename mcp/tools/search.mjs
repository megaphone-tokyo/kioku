// kioku_search — Wiki の検索。
// qmd CLI に委譲 (BM25 / vector / hybrid)、qmd 不在時は Node grep の簡易 fallback。

import { readdir, readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { z } from 'zod';

const QMD_TIMEOUT_MS = 5000;
const MAX_LIMIT = 50;
const MAX_QUERY_LEN = 500;
const COLLECTION = 'brain-wiki';
const FALLBACK_MAX_FILES = 500;
const FALLBACK_MAX_BYTES_PER_FILE = 8192;

export const SEARCH_TOOL_DEF = {
  name: 'kioku_search',
  title: 'Search KIOKU wiki',
  description:
    'Search the KIOKU wiki via qmd (BM25/vector/hybrid). Falls back to a simple Node grep if qmd is not installed. ' +
    'For best results when both servers are connected, prefer the dedicated qmd MCP `query` tool — kioku_search is a thin wrapper kept here so wiki search works even without qmd.',
  inputShape: {
    query: z.string().min(1).max(MAX_QUERY_LEN),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    mode: z
      .enum(['lex', 'vec', 'hybrid'])
      .optional()
      .describe('lex=BM25, vec=embedding similarity, hybrid=qmd query (BM25+vec+rerank).'),
  },
};

export async function handleSearch(vault, args) {
  const query = String(args?.query ?? '').trim();
  if (!query) {
    const e = new Error('query is required');
    e.code = 'invalid_params';
    throw e;
  }
  const limit = clamp(args?.limit ?? 10, 1, MAX_LIMIT);
  const mode = args?.mode ?? 'hybrid';

  const qmdResult = await tryQmd(query, limit, mode);
  if (qmdResult) return qmdResult;

  const fallback = await fallbackSearch(vault, query, limit);
  return {
    results: fallback,
    note: 'qmd CLI not available; using Node fallback (case-insensitive substring match).',
  };
}

async function tryQmd(query, limit, mode) {
  const subcommand = mode === 'lex' ? 'search' : mode === 'vec' ? 'vsearch' : 'query';
  const args = [subcommand, '--json', '-n', String(limit), '-c', COLLECTION, query];
  return new Promise((resolve) => {
    const child = spawn('qmd', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, KIOKU_NO_LOG: '1' },
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try { child.kill('SIGTERM'); } catch {}
        resolve(null);
      }
    }, QMD_TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(null); // ENOENT (qmd not installed) など
      }
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stripAnsi(stdout));
        if (!Array.isArray(parsed)) {
          resolve(null);
          return;
        }
        const results = parsed.slice(0, limit).map((row) => ({
          path: stripQmdScheme(row.file),
          title: row.title ?? '',
          score: typeof row.score === 'number' ? row.score : null,
          snippet: typeof row.snippet === 'string' ? row.snippet : '',
        }));
        resolve({ results });
      } catch {
        resolve(null);
      }
    });
  });
}

function stripQmdScheme(file) {
  if (typeof file !== 'string') return '';
  const m = file.match(/^qmd:\/\/[^/]+\/(.*)$/);
  return m ? m[1] : file;
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

async function fallbackSearch(vault, query, limit) {
  let wikiAbs;
  try {
    wikiAbs = await realpath(join(vault, 'wiki'));
  } catch {
    return [];
  }
  const lcQuery = query.toLowerCase();
  const tokens = lcQuery.split(/\s+/).filter(Boolean);
  const hits = [];
  let scanned = 0;

  async function walk(dir) {
    if (scanned >= FALLBACK_MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of entries) {
      if (scanned >= FALLBACK_MAX_FILES) return;
      if (dirent.name.startsWith('.')) continue;
      if (dirent.name === 'templates') continue;
      const childAbs = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(childAbs);
      } else if (dirent.isFile() && dirent.name.endsWith('.md')) {
        scanned++;
        try {
          const handle = await readFile(childAbs);
          const head = handle.subarray(0, FALLBACK_MAX_BYTES_PER_FILE).toString('utf8');
          const lcHead = head.toLowerCase();
          let score = 0;
          for (const t of tokens) {
            if (lcHead.includes(t)) score += 1;
          }
          if (score > 0) {
            const idx = lcHead.indexOf(tokens[0]);
            const snippetStart = Math.max(0, idx - 60);
            const snippet = head.substring(snippetStart, snippetStart + 200).replace(/\s+/g, ' ').trim();
            hits.push({
              path: relative(wikiAbs, childAbs).split(sep).join('/'),
              title: extractTitle(head),
              score,
              snippet,
            });
          }
        } catch {
          // skip
        }
      }
    }
  }

  await walk(wikiAbs);
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

function extractTitle(content) {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : '';
}

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, Math.trunc(x)));
}
