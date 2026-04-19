#!/usr/bin/env node
// mask-text.mjs — 秘密情報マスキングと source_type sanitize の薄い CLI / module ラッパー。
//
// CLI モード:
//   cat in.txt | node scripts/mask-text.mjs > out.txt
//   node scripts/mask-text.mjs --sanitize-source-type "; rm -rf /"
//
// Module モード:
//   import { maskText, sanitizeSourceType } from './mask-text.mjs';
//
// extract-pdf.sh は pdftotext の標準出力を本 CLI にパイプしてマスク適用後の
// テキストを chunk MD として書き出す。実処理は ./lib/masking.mjs が担い、
// 本ファイルは stdio の I/O と entry point 判定のみ担当する。
//
// 設計書: tools/claude-brain/plan/claude/26041705_document-ingest-design.md §4.5

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MASK_RULES, maskText, sanitizeSourceType } from './lib/masking.mjs';

export { MASK_RULES, maskText, sanitizeSourceType };

function isMainEntry() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
}

function runCli(argv) {
  const args = argv.slice(2);
  if (args.length >= 2 && args[0] === '--sanitize-source-type') {
    process.stdout.write(sanitizeSourceType(args[1]));
    process.stdout.write('\n');
    return 0;
  }
  const raw = readFileSync(0, 'utf8');
  process.stdout.write(maskText(raw));
  return 0;
}

if (isMainEntry()) {
  try {
    process.exit(runCli(process.argv));
  } catch (err) {
    process.stderr.write(`mask-text: ${err?.message || err}\n`);
    process.exit(1);
  }
}
