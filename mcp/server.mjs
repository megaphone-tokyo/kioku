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
import { INGEST_URL_TOOL_DEF, handleIngestUrl } from './tools/ingest-url.mjs';

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

// 2026-04-20 v0.3.4 MCP progress heartbeat (long-running tool timeout 対策):
//   Claude Desktop 等の MCP client は tool call に対して既定 60 秒で
//   timeout を切るが、kioku_ingest_pdf / kioku_ingest_url は PDF fetch +
//   extract-pdf.sh + claude -p summarize の合計で 3-5 分かかりうる。
//   client が send した _meta.progressToken があれば、handler に
//   `sendProgress(message?)` を injection で渡して定期的に
//   `notifications/progress` を送れるようにする。client 側の idle timeout が
//   progress 受信でリセットされ、内部処理が完走するまで待機される。
//
//   progressToken が無い client (旧プロトコル等) は sendProgress を呼ぶと
//   silent no-op するヘルパを返すので、handler 側で分岐不要。
function buildSendProgress(extra) {
  const token = extra?._meta?.progressToken;
  if (token === undefined || token === null || extra?.sendNotification == null) {
    // progressToken が無い = client が progress を要求していない → no-op
    return null;
  }
  let counter = 0;
  return async (message) => {
    counter += 1;
    try {
      await extra.sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken: token,
          progress: counter,
          message: typeof message === 'string' && message.length > 0
            ? message.slice(0, 200) // 長文は 200 char で truncate (誤送防止)
            : undefined,
        },
      });
    } catch {
      // progress 送信失敗は致命ではない (client 側切断等) — silent pass
    }
  };
}

function wrap(handler) {
  return async (args, extra) => {
    const sendProgress = buildSendProgress(extra);
    const injections = sendProgress ? { sendProgress } : {};
    try {
      const result = await handler(VAULT, args ?? {}, injections);
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
    (args, extra) => wrap(handler)(args, extra),
  );
}

register(READ_TOOL_DEF, handleRead);
register(LIST_TOOL_DEF, handleList);
register(SEARCH_TOOL_DEF, handleSearch);
register(WRITE_NOTE_TOOL_DEF, handleWriteNote);
register(WRITE_WIKI_TOOL_DEF, handleWriteWiki);
register(DELETE_TOOL_DEF, handleDelete);
register(INGEST_PDF_TOOL_DEF, handleIngestPdf);
register(INGEST_URL_TOOL_DEF, handleIngestUrl);

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
