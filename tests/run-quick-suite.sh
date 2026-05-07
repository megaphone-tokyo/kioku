#!/usr/bin/env bash
# run-quick-suite.sh — 日常開発用の軽量 test suite (60 秒以内に完走する目標)
#
# v0.7.2 PR C で導入。codex roadmap §「P0: URL 系テストの安定化」の Acceptance criteria #1
# 「quick suite が 60 秒以内に終わる」を満たす。
#
# 含むもの (KIOKU_SKIP_NETWORKISH_TESTS=1 を強制し、URL/network test を skip):
#   - Hook の Node test (tests/hooks/*.test.mjs)
#   - MCP の Node test (tests/mcp/*.test.mjs) ※ tools-ingest-url.test.mjs は env で skip
#
# 含まないもの (full suite 側、tests/run-full-suite.sh で実行):
#   - URL 系統合 test (url-fetch / url-extract / url-image / robots-check / extract-url.test.sh 等)
#   - Bash test 群 (auto-ingest / install-hooks / setup-vault / doctor / build-mcpb / sync-to-app 等)
#
# 実行: bash tools/claude-brain/tests/run-quick-suite.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_DIR="${SCRIPT_DIR}"

start=${SECONDS}
echo "[run-quick-suite] hooks + mcp の Node test を KIOKU_SKIP_NETWORKISH_TESTS=1 で実行 (target <60s)"

# `node --test` は失敗すると non-zero exit → set -e で stop。pipeline は使わない (output を
# そのまま contributor が見れるように)。glob expand は bash がする。
KIOKU_SKIP_NETWORKISH_TESTS=1 node --test \
  "${TESTS_DIR}/hooks/"*.test.mjs \
  "${TESTS_DIR}/mcp/"*.test.mjs

elapsed=$((SECONDS - start))
echo "[run-quick-suite] OK (${elapsed}s)"
if [[ "${elapsed}" -ge 60 ]]; then
  echo "[run-quick-suite] WARN: ${elapsed}s exceeded 60s budget" >&2
fi
