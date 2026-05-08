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

# v0.7 Phase D α: kioku_generate_viz が register されていること (V-2)
grep -q 'VISUALIZER_TOOL_DEF' "${SERVER_MJS}" || fail 'VISUALIZER_TOOL_DEF not imported in server.mjs'
grep -q 'handleGenerateViz' "${SERVER_MJS}" || fail 'handleGenerateViz not imported in server.mjs'
grep -q 'register(VISUALIZER_TOOL_DEF' "${SERVER_MJS}" || fail 'VISUALIZER_TOOL_DEF not registered'

# Sprint 2 v0.7.4: kioku_health が register されていること
grep -q 'HEALTH_TOOL_DEF' "${SERVER_MJS}" || fail 'HEALTH_TOOL_DEF not imported in server.mjs'
grep -q 'handleHealth' "${SERVER_MJS}" || fail 'handleHealth not imported in server.mjs'
grep -q 'register(HEALTH_TOOL_DEF' "${SERVER_MJS}" || fail 'HEALTH_TOOL_DEF not registered'

echo "PASS: mcp-server-registration"
