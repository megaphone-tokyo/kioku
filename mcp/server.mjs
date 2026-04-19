#!/usr/bin/env node
// kioku-mcp — KIOKU local MCP server (stdio)
//
// 環境変数:
//   OBSIDIAN_VAULT  Vault ルート (必須)
//   KIOKU_DEBUG     "1" で stderr にデバッグ出力
//
// Claude Desktop / Claude Code がサブプロセスとして起動する想定。
// stdout は JSON-RPC 専用のため、ログは絶対に console.error 経由のみ使うこと。

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { READ_TOOL_DEF, handleRead } from './tools/read.mjs';
import { LIST_TOOL_DEF, handleList } from './tools/list.mjs';
import { SEARCH_TOOL_DEF, handleSearch } from './tools/search.mjs';
import { WRITE_NOTE_TOOL_DEF, handleWriteNote } from './tools/write-note.mjs';
import { WRITE_WIKI_TOOL_DEF, handleWriteWiki } from './tools/write-wiki.mjs';
import { DELETE_TOOL_DEF, handleDelete } from './tools/delete.mjs';
import { INGEST_PDF_TOOL_DEF, handleIngestPdf } from './tools/ingest-pdf.mjs';

const VAULT = process.env.OBSIDIAN_VAULT;
if (!VAULT) {
  process.stderr.write('[kioku-mcp] OBSIDIAN_VAULT is required.\n');
  process.exit(1);
}

const debug = (msg) => {
  if (process.env.KIOKU_DEBUG === '1') {
    process.stderr.write(`[kioku-mcp] ${msg}\n`);
  }
};

const server = new McpServer(
  { name: 'kioku-wiki', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

function wrap(handler) {
  return async (args) => {
    try {
      const result = await handler(VAULT, args ?? {});
      return {
        content: [
          { type: 'text', text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err) {
      const code = err.code ?? 'internal_error';
      const message = err.message ?? String(err);
      const payload = { error: { code, message } };
      if (err.data) payload.error.data = err.data;
      return {
        isError: true,
        content: [
          { type: 'text', text: JSON.stringify(payload, null, 2) },
        ],
      };
    }
  };
}

function register(toolDef, handler) {
  server.registerTool(
    toolDef.name,
    {
      title: toolDef.title,
      description: toolDef.description,
      inputSchema: toolDef.inputShape,
    },
    (args) => wrap(handler)(args),
  );
}

register(READ_TOOL_DEF, handleRead);
register(LIST_TOOL_DEF, handleList);
register(SEARCH_TOOL_DEF, handleSearch);
register(WRITE_NOTE_TOOL_DEF, handleWriteNote);
register(WRITE_WIKI_TOOL_DEF, handleWriteWiki);
register(DELETE_TOOL_DEF, handleDelete);
register(INGEST_PDF_TOOL_DEF, handleIngestPdf);

// 致命エラーでもプロセスを生かしてエラー応答できるようにする
process.on('uncaughtException', (err) => {
  process.stderr.write(`[kioku-mcp] uncaughtException: ${err.stack ?? err.message}\n`);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[kioku-mcp] unhandledRejection: ${reason?.stack ?? reason}\n`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
debug('connected (stdio)');
