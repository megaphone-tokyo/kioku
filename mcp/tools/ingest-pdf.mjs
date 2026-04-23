// mcp/tools/ingest-pdf.mjs — 旧 import path 互換の re-export wrapper (Phase 2 split)。
//
// 本体は mcp/tools/ingest/pdf.mjs に移動。kioku_ingest_pdf tool 登録 (deprecated alias) と
// handler は全て ingest/pdf.mjs から re-export する。外部 (server.mjs / ingest-document.mjs /
// tests) の import path を変更しなくても動作する。

export { INGEST_PDF_TOOL_DEF, handleIngestPdf } from './ingest/pdf.mjs';
