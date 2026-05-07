#!/usr/bin/env bash
# run-full-suite.sh — release 前用の全 test suite (URL/network 系含む)
#
# v0.7.2 PR C で導入。codex roadmap §「P0: URL 系テストの安定化」の Acceptance criteria #3
# 「full suite の対象が README / context に明記される」を満たす runbook。
#
# 含むもの:
#   - Node test 全部 (tests/hooks/, tests/mcp/, tests/*.test.mjs)
#     → URL 系統合 test (url-fetch / url-extract / url-image / robots-check) と
#       MCP integration (mcp/tools-ingest-url) も含む
#   - Bash test 全部 (tests/*.test.sh)
#     → setup-vault / install-hooks / install-hooks-gemini / install-hooks-codex /
#        auto-ingest / auto-lint / scan-secrets / doctor / build-mcpb / sync-to-app /
#        post-release-sync / extract-url / extract-pdf / extract-epub / extract-docx 等
#
# 環境前提:
#   - tools/claude-brain/mcp/node_modules/ が install 済 (`cd mcp && npm install`)
#   - 任意で poppler (pdfinfo/pdftotext) — PDF dispatch test の skip 判定に使われる
#
# 実行: bash tools/claude-brain/tests/run-full-suite.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_DIR="${SCRIPT_DIR}"

start=${SECONDS}
echo "[run-full-suite] 全 test suite を実行 (KIOKU_SKIP_NETWORKISH_TESTS は unset、URL test も走る)"

# 失敗カテゴリを収集して最後に報告 (途中失敗で stop せず全カテゴリを走らせる)。
# `set -e` 環境下で `||` を使い node 失敗を非 fatal 化する。
FAIL_LOG=""

# Node test 全カテゴリ (top-level + hooks/ + mcp/)
echo "[run-full-suite] Node test (top-level + hooks/ + mcp/)"
if ! node --test \
  "${TESTS_DIR}/"*.test.mjs \
  "${TESTS_DIR}/hooks/"*.test.mjs \
  "${TESTS_DIR}/mcp/"*.test.mjs; then
  FAIL_LOG="${FAIL_LOG}\n  - Node test (top-level + hooks/ + mcp/)"
fi

# Bash test を 1 本ずつ run。失敗を収集しつつ全部回す。
BASH_TESTS=(
  setup-vault.test.sh
  install-hooks.test.sh
  install-hooks-gemini.test.sh
  install-hooks-codex.test.sh
  install-launchagents.test.sh
  install-mcp-client.test.sh
  install-skills.test.sh
  setup-mcp.test.sh
  setup-multi-agent.test.sh
  setup-qmd.test.sh
  auto-ingest.test.sh
  auto-lint.test.sh
  scan-secrets.test.sh
  doctor.test.sh
  build-mcpb.test.sh
  sync-to-app.test.sh
  post-release-sync.test.sh
  extract-url.test.sh
  extract-pdf.test.sh
  extract-epub.test.sh
  extract-docx.test.sh
  competitor-watch.test.sh
  cron-guard-parity.test.sh
  mcp-server-registration.test.sh
  hooks/no-network-import.test.sh
)

for t in "${BASH_TESTS[@]}"; do
  full="${TESTS_DIR}/${t}"
  if [[ ! -f "${full}" ]]; then
    echo "[run-full-suite] SKIP missing: ${t}"
    continue
  fi
  echo "[run-full-suite] bash ${t}"
  if ! bash "${full}"; then
    FAIL_LOG="${FAIL_LOG}\n  - bash ${t}"
  fi
done

elapsed=$((SECONDS - start))
if [[ -z "${FAIL_LOG}" ]]; then
  echo "[run-full-suite] OK (${elapsed}s)"
else
  printf "[run-full-suite] FAIL (%ss). 失敗カテゴリ:%b\n" "${elapsed}" "${FAIL_LOG}" >&2
  exit 1
fi
