#!/usr/bin/env node
// scripts/extract-epub.mjs — Category A override 用 EPUB 抽出 CLI。
//
// 契約 (extract-pdf.sh と統一):
//   usage: extract-epub.mjs <epub-path> <output-dir> <subdir-prefix>
//   exit 0  正常終了
//   exit 2  EPUB が不正 / 読めない
//   exit 3  章が 0 件 (spine 空)
//   exit 4  compressed size > KIOKU_DOC_MAX_INPUT_BYTES
//   exit 5  EPUB が $OBSIDIAN_VAULT/raw-sources/ 外
//   exit 64 引数不正 (count / prefix `-` / 拡張子)
//
// 防御:
//   VULN-E007 — ANTHROPIC_/CLAUDE_/XDG_ prefix env の値長さを 4KB でガード
//   VULN-E008 — argv[1] の正規表現検証 + 先頭 `-`/`--` reject + `execSync` 不使用
//   VULN-E009 — 起動時に $OBSIDIAN_VAULT/.cache/epub/ の 24h+ dir を rm -rf

import { readdir, stat, rm } from 'node:fs/promises';
import { join, extname, relative, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const LOG = '[extract-epub]';

function die(code, msg) { console.error(`${LOG} ${msg}`); process.exit(code); }

// Error codes that represent a corrupt / malicious EPUB structure (exit 2).
const INVALID_EPUB_CODES = new Set([
  'zip_slip', 'entry_count_exceeded', 'entry_bytes_exceeded',
  'extract_bytes_exceeded', 'symlink_rejected', 'invalid_filename',
  'xxe_rejected', 'invalid_container', 'invalid_opf', 'invalid_xml',
]);

// --- VULN-E007: 長すぎる prefix env は打ち切る ---
for (const [k, v] of Object.entries(process.env)) {
  if (
    (k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_') || k.startsWith('XDG_')) &&
    typeof v === 'string' &&
    v.length > 4096
  ) {
    delete process.env[k];
    console.error(`${LOG} WARN: dropped ${k} (length ${v.length} > 4KB)`);
  }
}

// --- VULN-E009: 起動時 GC (.cache/epub/ の 24h+ dir) ---
async function gcStaleCaches(vault) {
  const cacheBase = join(vault, '.cache', 'epub');
  let entries;
  try { entries = await readdir(cacheBase); } catch { return; }
  const now = Date.now();
  for (const name of entries) {
    const p = join(cacheBase, name);
    try {
      const st = await stat(p);
      if (now - st.mtimeMs > 24 * 3600 * 1000) {
        await rm(p, { recursive: true, force: true });
      }
    } catch { /* ignore per-entry errors */ }
  }
}

const vault = process.env.OBSIDIAN_VAULT;
if (vault) {
  // GC は argv 検証前に走らせる (F4 test 要求: 引数エラーでも GC が観測できること)
  await gcStaleCaches(vault);
}

// --- VULN-E008: argv 検証 ---
const argv = process.argv.slice(2);
if (argv.length !== 3) die(64, `usage: extract-epub.mjs <epub-path> <output-dir> <subdir-prefix>`);
const [epubPath, outDir, subdirPrefix] = argv;
if (epubPath.startsWith('-')) die(64, `epub-path must not start with "-": ${epubPath}`);
// vault-path.mjs SAFE_PATH_RE と整合させ \p{L}\p{N} を許可 (日本語/中国語 filename)
if (!/^[\p{L}\p{N}_./\- ]+\.epub$/u.test(epubPath)) die(64, `invalid epub path shape: ${epubPath}`);
if (outDir.startsWith('-')) die(64, `out-dir must not start with "-": ${outDir}`);
if (subdirPrefix.startsWith('-')) die(64, `subdir-prefix must not start with "-": ${subdirPrefix}`);
if (extname(epubPath).toLowerCase() !== '.epub') die(2, `not a .epub file: ${epubPath}`);

if (!vault) die(1, 'OBSIDIAN_VAULT env is required');

// --- 動的 import (argv 検証後) ---
const { handleIngestEpub } = await import('../mcp/tools/ingest/epub.mjs');

// If epubPath is absolute (e.g., from auto-ingest.sh find) and inside the vault, convert to relative.
// handleIngestEpub + assertInsideRawSources expects vault-relative form like "raw-sources/books/foo.epub".
let callerPath = epubPath;
if (isAbsolute(epubPath)) {
  callerPath = relative(vault, epubPath);
  if (callerPath.startsWith('..') || isAbsolute(callerPath)) {
    die(5, `EPUB outside vault: ${epubPath}`);
  }
}

try {
  const result = await handleIngestEpub(vault, { path: callerPath }, {
    extractOverrides: {
      maxEntries: Number(process.env.KIOKU_DOC_MAX_ENTRIES ?? 5000),
      maxExtractBytes: Number(process.env.KIOKU_DOC_MAX_EXTRACT_BYTES ?? 200 * 1024 * 1024),
      entryBytesLimit: Number(process.env.KIOKU_DOC_MAX_ENTRY_BYTES ?? 50 * 1024 * 1024),
    },
  });
  if (!result.chunks || result.chunks.length === 0) die(3, 'no chapters extracted (spine empty or all skipped)');
  console.log(`${LOG} Extracted ${result.chunks.length} chunks from ${epubPath}`);
  process.exit(0);
} catch (err) {
  if (err.code === 'invalid_request' && err.message.includes('max input')) die(4, err.message);
  if (err.code === 'invalid_request') die(2, err.message);
  if (err.code === 'invalid_params') die(2, err.message);
  if (err.code === 'absolute_path' || err.code === 'path_outside_boundary') die(5, err.message);
  if (INVALID_EPUB_CODES.has(err.code)) die(2, err.message);
  // yauzl throws raw Error (no .code) for corrupt/non-zip files — map to exit 2 (invalid epub)
  if (!err.code && err.message && (
    err.message.includes('not a zip file') ||
    err.message.includes('End of central directory') ||
    err.message.includes('truncated')
  )) die(2, err.message);
  die(1, `unexpected error: ${err.message}`);
}
