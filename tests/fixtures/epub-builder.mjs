// tests/fixtures/epub-builder.mjs — test 用の悪意 EPUB 生成ヘルパー。
//
// 依存なし (zlib + 自前 ZIP writer)。yauzl と対になる minimal spec だけ実装:
//   - Local file header + central directory + end-of-central-directory
//   - DEFLATE / STORED 両対応
//   - external file attributes に symlink bit (0o120000 << 16) を設定可能
//   - validateEntrySizes 機能の test 用に central dir の uncompressed size を嘘で書ける

import { deflateRawSync, crc32 } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const LFH_SIG = 0x04034b50;
const CD_SIG  = 0x02014b50;
const EOCD_SIG = 0x06054b50;

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff, 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

function crc32buf(buf) {
  if (typeof crc32 === 'function') return crc32(buf);
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    return c >>> 0;
  });
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

export function buildEpub(entries, opts = {}) {
  const forgeSizes = opts.forgeSizes || {};
  const localParts = [];
  const cdParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = entry.name;
    const nameBuf = Buffer.from(name, 'utf8');
    const data = entry.symlink
      ? Buffer.from(entry.symlink, 'utf8')
      : Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const method = entry.compression === 'deflate' ? 8 : 0;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32buf(data);

    const forge = forgeSizes[name] ?? {};
    // LFH に使うサイズ: announced / compressedAnnounced で両方を上書き (後方互換)
    const lfhUncompressed = forge.announced ?? data.length;
    const lfhCompressed   = forge.compressedAnnounced ?? compressed.length;
    // CD にだけ別値を使いたい場合は cdAnnounced / cdCompressedAnnounced で指定する。
    // 省略時は LFH と同じ値を使う (= 従来動作)。
    const cdUncompressed = forge.cdAnnounced ?? lfhUncompressed;
    const cdCompressed   = forge.cdCompressedAnnounced ?? lfhCompressed;
    // 後方互換変数 (LFH 側で参照)
    const announcedUncompressed = lfhUncompressed;
    const announcedCompressed   = lfhCompressed;
    // 非 ASCII または制御文字を含む場合は Language Encoding Flag (bit 11 = 0x0800) を立て、
    // yauzl が UTF-8 として正しくデコードできるようにする (CR/LF/NUL が CP437 で
    // 別の文字に化けることを防ぐ)。
    const gpFlag = /[^\x20-\x7e]/.test(name) ? 0x0800 : 0;

    const lfh = Buffer.concat([
      u32(LFH_SIG),
      u16(20),
      u16(gpFlag),
      u16(method),
      u16(0), u16(0),
      u32(crc),
      u32(announcedCompressed),
      u32(announcedUncompressed),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      compressed,
    ]);
    localParts.push(lfh);

    const extAttr = entry.symlink ? ((0o120777 & 0xffff) << 16) >>> 0 : 0;
    const cd = Buffer.concat([
      u32(CD_SIG),
      u16(20), u16(20),
      u16(gpFlag), u16(method),
      u16(0), u16(0),
      u32(crc),
      u32(cdCompressed),
      u32(cdUncompressed),
      u16(nameBuf.length),
      u16(0), u16(0),
      u16(0), u16(0),
      u32(extAttr),
      u32(offset),
      nameBuf,
    ]);
    cdParts.push(cd);
    offset += lfh.length;
  }

  const cdStart = localParts.reduce((n, b) => n + b.length, 0);
  const cdBuf = Buffer.concat(cdParts);

  const eocd = Buffer.concat([
    u32(EOCD_SIG),
    u16(0), u16(0),
    u16(entries.length), u16(entries.length),
    u32(cdBuf.length),
    u32(cdStart),
    u16(0),
  ]);
  return Buffer.concat([...localParts, cdBuf, eocd]);
}

export async function writeEpubFixture(dir, filename, entries, opts) {
  await mkdir(dir, { recursive: true });
  const p = join(dir, filename);
  await writeFile(p, buildEpub(entries, opts));
  return p;
}
