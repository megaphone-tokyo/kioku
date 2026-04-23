// tools/claude-brain/mcp/tools/ingest-document.mjs
// kioku_ingest_document — router (機能 2.4).
//
// 設計書: plan/claude/26042106_meeting_feature-2-4-epub-docx-design-sketch.md 案 Y
// Phase 1 範囲: 既存 handleIngestPdf を PDF/MD 両方で delegate。
// Phase 2: EPUB (yauzl) handler を本 router に追加。
// Phase 3: DOCX (mammoth) handler を本 router に追加。

import { extname } from 'node:path';
import { INGEST_PDF_TOOL_DEF, handleIngestPdf } from './ingest/pdf.mjs';
import { handleIngestEpub } from './ingest/epub.mjs';
import { handleIngestDocx } from './ingest/docx.mjs';

const SUPPORTED_EXTS = new Set(['.pdf', '.md', '.epub', '.docx']);
const FUTURE_EXTS = new Set(); // Phase 3 で DOCX を導入済 → 空

export const INGEST_DOCUMENT_TOOL_DEF = {
  name: 'kioku_ingest_document',
  title: 'Ingest a document (PDF/MD/EPUB/DOCX) into KIOKU Wiki',
  description:
    'Unified ingest entry point for local documents under raw-sources/. ' +
    'Dispatches internally by file extension. ' +
    'Currently supported: .pdf, .md, .epub, .docx. ' +
    'Path must be relative to Vault root (e.g. "raw-sources/books/foo.epub") or an absolute path resolving inside $OBSIDIAN_VAULT/raw-sources/. ' +
    'EPUB: spine 順に章 Markdown を .cache/extracted/ 配下に生成し、2 章以上なら index.md を添える。' +
    'DOCX: 1 ファイル Markdown を .cache/extracted/ 配下に生成し、core.xml metadata を frontmatter + METADATA fence で delimit する。' +
    'status: "extracted" で早期 return (LLM summary は次回 auto-ingest cron 経由)。' +
    'PDF (<=15p, 1 chunk) は extracted_and_summarized を返すまで block。長い PDF は queued_for_summary で早期 return。',
  inputShape: INGEST_PDF_TOOL_DEF.inputShape,
};

export async function handleIngestDocument(vault, args, injections = {}) {
  if (!args || typeof args !== 'object' || typeof args.path !== 'string' || !args.path.trim()) {
    const e = new Error('path is required'); e.code = 'invalid_params'; throw e;
  }
  const ext = extname(String(args.path)).toLowerCase();
  if (FUTURE_EXTS.has(ext)) {
    const e = new Error(`extension ${ext} is planned but not yet implemented`);
    e.code = 'invalid_params'; throw e;
  }
  if (!SUPPORTED_EXTS.has(ext) && ext !== '') {
    const e = new Error(`unsupported extension: ${ext}. Supported: .pdf, .md, .epub, .docx`);
    e.code = 'invalid_params'; throw e;
  }
  if (ext === '.docx') return handleIngestDocx(vault, args, injections);
  if (ext === '.epub') return handleIngestEpub(vault, args, injections);
  // 空拡張子 or .pdf / .md は handleIngestPdf に delegate
  return handleIngestPdf(vault, args, injections);
}
