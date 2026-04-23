#!/usr/bin/env bash
set -euo pipefail

SERVER_MJS="$(dirname "$0")/../mcp/server.mjs"

fail() { echo "FAIL: $1" >&2; exit 1; }

# 機能 2.4 Phase 1: kioku_ingest_document が register されていること
grep -q 'INGEST_DOCUMENT_TOOL_DEF' "${SERVER_MJS}" || fail 'INGEST_DOCUMENT_TOOL_DEF not imported in server.mjs'
grep -q 'handleIngestDocument' "${SERVER_MJS}" || fail 'handleIngestDocument not imported in server.mjs'
grep -q 'register(INGEST_DOCUMENT_TOOL_DEF' "${SERVER_MJS}" || fail 'INGEST_DOCUMENT_TOOL_DEF not registered'

# 回帰: 既存 alias が残っていること (v0.5〜v0.7 window 維持)
grep -q 'register(INGEST_PDF_TOOL_DEF' "${SERVER_MJS}" || fail 'INGEST_PDF_TOOL_DEF registration (deprecated alias) missing'

# 回帰: ingest-url も引き続き register されていること
grep -q 'register(INGEST_URL_TOOL_DEF' "${SERVER_MJS}" || fail 'INGEST_URL_TOOL_DEF registration missing'

echo "PASS: mcp-server-registration"
