// mcp/lib/epub-extract.mjs — yauzl ベースの安全な EPUB (ZIP) 展開ヘルパー。
//
// 実装防御層 (meeting 26042202 Agenda 2):
//   層 1: yauzl { validateEntrySizes: true, strictFileNames: true, decodeStrings: true }
//   層 2: 各 entry fileName を path containment check で realpath 検証 (zip-slip)
//   層 3: 累積展開 size cap (maxExtractBytes, default 200MB)
//   層 4: entry count cap (maxEntries, default 5000)
//   層 5: 親側 compressed size pre-check は呼出側の責務 (ingest-document.mjs / extract-epub.mjs)
//   層 7: entry 単位 size cap (entryBytesLimit, default 50MB)
//   E003: symlink entry 全 reject (external file attr の S_IFLNK bit)
//   E014: filename NFKC 正規化 + 制御文字 / RTL override / NUL reject
//   E005 補: nested ZIP/EPUB entry (magic `PK\x03\x04`) は skip + WARN
//
// 提供 API:
//   extractEpubEntries(epubPath, outDir, opts?) → { entries, warnings, totalBytes }
//     entries: [{ name, size, absPath }]   — 展開に成功した entry の一覧 (mimetype 含む)
//     warnings: string[]                    — skip した nested 等の情報
//     totalBytes: number                    — 累積展開 byte 数

import { realpath, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, sep } from 'node:path';
import yauzl from 'yauzl';

const DEFAULT_MAX_ENTRIES = 5000;
const DEFAULT_MAX_EXTRACT_BYTES = 200 * 1024 * 1024;
const DEFAULT_ENTRY_BYTES_LIMIT = 50 * 1024 * 1024;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** S_IFLNK 検出: external file attributes の上位 16bit に 0o120000 マスクをかける */
function isSymlinkAttr(externalFileAttributes) {
  return ((externalFileAttributes >>> 16) & 0o170000) === 0o120000;
}

/**
 * VULN-E014: filename の安全性検証。
 * - NUL byte / 制御文字 (U+0000-U+001F, U+007F) を reject
 * - Bidi override / directional mark (U+202A-U+202E, U+200E-U+200F) を reject
 * - NFKC 正規化されていない名前を reject
 * - 空文字・長すぎるパスを reject
 */
function validateFilename(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw Object.assign(new Error('empty filename'), { code: 'invalid_filename' });
  }
  if (name.length > 1024) {
    throw Object.assign(new Error('filename too long'), { code: 'invalid_filename' });
  }
  if (name.includes('\0')) {
    throw Object.assign(new Error('filename contains NUL'), { code: 'invalid_filename' });
  }
  if (/[\x00-\x1f\x7f\u202a-\u202e\u200e\u200f]/.test(name)) {
    throw Object.assign(new Error('filename contains control or bidi character'), { code: 'invalid_filename' });
  }
  const normalized = name.normalize('NFKC');
  if (normalized !== name) {
    throw Object.assign(new Error('filename is not NFKC normalized'), { code: 'invalid_filename' });
  }
  return normalized;
}

/**
 * zip-slip 防御: outDir を realpath で解決し、name を結合した結果が
 * outDir 境界の内側に収まることを確認する。
 * assertInsideBase は relBase='.' を拒否するため、
 * outDir 自体を realpath base にする独自 containment check を実装する。
 */
async function assertInsideOutDir(outDir, name) {
  const realBase = await realpath(outDir);
  const candidate = join(realBase, name);
  // ENOENT の場合は親を辿って解決する
  let resolved;
  try {
    resolved = await realpath(candidate);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const tail = [];
    let cur = candidate;
    while (true) {
      const idx = cur.lastIndexOf(sep);
      if (idx <= 0) break;
      tail.unshift(cur.substring(idx + 1));
      cur = cur.substring(0, idx);
      try {
        const real = await realpath(cur);
        resolved = join(real, ...tail);
        break;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    if (!resolved) resolved = candidate;
  }
  if (resolved !== realBase && !resolved.startsWith(realBase + sep)) {
    throw Object.assign(new Error(`path outside boundary: ${name}`), { code: 'zip_slip' });
  }
  return resolved;
}

/** yauzl.open を Promise ラップ */
function openZip(path) {
  return new Promise((resolve, reject) => {
    yauzl.open(path, {
      lazyEntries: true,
      autoClose: false,
      validateEntrySizes: true,
      strictFileNames: true,
      decodeStrings: true,
    }, (err, zip) => (err ? reject(err) : resolve(zip)));
  });
}

/** zip.openReadStream を Promise ラップ */
function openReadStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream)));
  });
}

/**
 * yauzl の読み取りストリームを event-based で収集し、chunks の配列として返す。
 * `for await` は yauzl stream が close を emit しないため使用不可。
 *
 * @returns {Promise<{chunks: Buffer[], nested: boolean, running: number}>}
 */
function collectStream(stream, name, entryBytesLimit, totalBytesRef, maxExtractBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let running = 0;
    let firstFourChecked = false;
    let settled = false;

    function settle(fn) {
      if (settled) return;
      settled = true;
      fn();
    }

    stream.on('error', (err) => {
      // stream.destroy() によって生じた "stream destroyed" エラーは settled 後に無視する
      if (settled) return;
      settle(() => reject(Object.assign(
        new Error(`size mismatch or read error for ${name}: ${err.message}`),
        { code: 'size_mismatch' },
      )));
    });

    stream.on('data', (chunk) => {
      if (settled) return;

      // E005 補: nested ZIP/EPUB 検出 (先頭 4 byte が PK magic)
      if (!firstFourChecked) {
        firstFourChecked = true;
        if (chunk.length >= 4 && chunk.subarray(0, 4).equals(ZIP_MAGIC)) {
          // settle を先に呼んでから destroy する。destroy は同期的に error を emit
          // することがあるため、settled フラグを先に立てて error ハンドラを無効化する。
          settle(() => resolve({ chunks: [], nested: true, running: 0 }));
          stream.destroy();
          return;
        }
      }

      running += chunk.length;

      // 層 7: entry bytes cap
      if (running > entryBytesLimit) {
        // settle を先に呼んでから destroy する。destroy は同期的に error を emit
        // することがあるため、settled フラグを先に立てて error ハンドラを無効化する。
        settle(() => reject(Object.assign(
          new Error(`entry ${name} exceeded entryBytesLimit during streaming`),
          { code: 'entry_bytes_exceeded' },
        )));
        stream.destroy();
        return;
      }

      totalBytesRef.value += chunk.length;

      // 層 3: 累積 bytes cap
      if (totalBytesRef.value > maxExtractBytes) {
        // settle を先に呼んでから destroy する (nested-ZIP path と同じ ordering)
        settle(() => reject(Object.assign(
          new Error(`total extract size exceeded ${maxExtractBytes}`),
          { code: 'extract_bytes_exceeded' },
        )));
        stream.destroy();
        return;
      }

      chunks.push(chunk);
    });

    stream.on('end', () => {
      settle(() => resolve({ chunks, nested: false, running }));
    });
  });
}

/**
 * EPUB (ZIP) ファイルを outDir に安全に展開する。
 *
 * @param {string} epubPath - 展開対象の EPUB ファイルパス
 * @param {string} outDir   - 展開先ディレクトリ (存在しない場合は作成)
 * @param {{
 *   maxEntries?: number,
 *   maxExtractBytes?: number,
 *   entryBytesLimit?: number,
 * }} [opts]
 * @returns {Promise<{ entries: Array<{name:string,size:number,absPath:string}>, warnings: string[], totalBytes: number }>}
 */
export async function extractEpubEntries(epubPath, outDir, opts = {}) {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxExtractBytes = opts.maxExtractBytes ?? DEFAULT_MAX_EXTRACT_BYTES;
  const entryBytesLimit = opts.entryBytesLimit ?? DEFAULT_ENTRY_BYTES_LIMIT;

  await mkdir(outDir, { recursive: true });

  const zip = await openZip(epubPath);
  const entries = [];
  const warnings = [];
  // mutable reference to share totalBytes across entry handlers
  const totalBytesRef = { value: 0 };
  let count = 0;

  try {
    await new Promise((resolve, reject) => {
      zip.on('error', (err) => {
        // yauzl が strictFileNames/validateFileName で path traversal を検出した場合に
        // "invalid relative path" エラーを emit する。zip_slip に変換して伝搬する。
        if (/invalid relative path|invalid file name|path traversal/i.test(err.message)) {
          reject(Object.assign(
            new Error(`path traversal detected by yauzl: ${err.message}`),
            { code: 'zip_slip' },
          ));
        } else {
          reject(err);
        }
      });
      zip.on('end', resolve);

      zip.on('entry', (entry) => {
        // async IIFE で entry を処理し、エラーは reject に流す
        (async () => {
          count++;

          // 層 4: entry count cap
          if (count > maxEntries) {
            throw Object.assign(
              new Error(`entry count exceeded ${maxEntries}`),
              { code: 'entry_count_exceeded' },
            );
          }

          const name = validateFilename(entry.fileName);

          // ディレクトリエントリはスキップ
          if (name.endsWith('/')) {
            zip.readEntry();
            return;
          }

          // E003: symlink reject
          if (isSymlinkAttr(entry.externalFileAttributes ?? 0)) {
            throw Object.assign(
              new Error(`symlink entry rejected: ${name}`),
              { code: 'symlink_rejected' },
            );
          }

          // 層 7: central dir が announce した uncompressedSize で pre-check
          if (entry.uncompressedSize > entryBytesLimit) {
            throw Object.assign(
              new Error(`entry ${name} announced size ${entry.uncompressedSize} > limit ${entryBytesLimit}`),
              { code: 'entry_bytes_exceeded' },
            );
          }

          // 層 2: zip-slip 防御 (realpath containment check)
          const absOut = await assertInsideOutDir(outDir, name);
          await mkdir(dirname(absOut), { recursive: true });

          const stream = await openReadStream(zip, entry);
          const { chunks, nested, running } = await collectStream(
            stream, name, entryBytesLimit, totalBytesRef, maxExtractBytes,
          );

          if (nested) {
            warnings.push(`nested ZIP/EPUB entry skipped: ${name}`);
            zip.readEntry();
            return;
          }

          await writeFile(absOut, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 });
          entries.push({ name, size: running, absPath: absOut });
          zip.readEntry();
        })().catch(reject);
      });

      zip.readEntry();
    });
  } finally {
    try { zip.close(); } catch { /* ignore */ }
  }

  return { entries, warnings, totalBytes: totalBytesRef.value };
}
