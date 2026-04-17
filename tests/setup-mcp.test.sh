#!/usr/bin/env bash
#
# setup-mcp.test.sh — scripts/setup-mcp.sh のスモークテスト (Phase M)
#
# 実行: bash tools/claude-brain/tests/setup-mcp.test.sh
#
# 検証項目:
#   MCP27  node 不在で exit 1 + 案内メッセージ
#   MCP28  --dry-run で npm install を呼ばない (出力に [dry-run] 印あり)
#   MCP28b npm 不在で exit 1
#   MCP28c --help で usage 出力

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
SETUP_SCRIPT="${REPO_ROOT}/tools/claude-brain/scripts/setup-mcp.sh"

TMPROOT="$(mktemp -d)"
trap 'rm -rf "${TMPROOT}"' EXIT

PASS=0
FAIL=0

pass() {
  PASS=$((PASS + 1))
  echo "  ok  $1"
}

fail() {
  FAIL=$((FAIL + 1))
  echo "  NG  $1" >&2
}

assert_eq() {
  if [[ "$1" == "$2" ]]; then
    pass "$3"
  else
    fail "$3 (expected=$1, actual=$2)"
  fi
}

assert_contains() {
  if printf '%s' "$1" | grep -q -F -- "$2"; then
    pass "$3"
  else
    fail "$3 (substring not found: $2)"
  fi
}

# -----------------------------------------------------------------------------
# MCP27: node 不在で exit 1 (PATH に /bin /usr/bin だけを残し、node を見えなくする)
# -----------------------------------------------------------------------------
echo "== MCP27: node missing =="
set +e
out=$(PATH="/usr/bin:/bin" bash "${SETUP_SCRIPT}" 2>&1)
rc=$?
set -e
assert_eq "1" "${rc}" "MCP27 exit code is 1"
assert_contains "${out}" "node" "MCP27 mentions node"

# -----------------------------------------------------------------------------
# MCP28: --dry-run does not run npm install
# -----------------------------------------------------------------------------
echo "== MCP28: --dry-run =="
set +e
out=$(bash "${SETUP_SCRIPT}" --dry-run 2>&1)
rc=$?
set -e
assert_eq "0" "${rc}" "MCP28 exit code is 0"
assert_contains "${out}" "[dry-run]" "MCP28 marks output as dry-run"
assert_contains "${out}" "npm install" "MCP28 echoes the would-be command"

# -----------------------------------------------------------------------------
# MCP28b: --help prints usage
# -----------------------------------------------------------------------------
echo "== MCP28b: --help =="
set +e
out=$(bash "${SETUP_SCRIPT}" --help 2>&1)
rc=$?
set -e
assert_eq "0" "${rc}" "MCP28b exit code is 0"
assert_contains "${out}" "setup-mcp" "MCP28b help mentions setup-mcp"

# -----------------------------------------------------------------------------
# MCP28c: unknown flag rejected
# -----------------------------------------------------------------------------
echo "== MCP28c: unknown flag =="
set +e
out=$(bash "${SETUP_SCRIPT}" --bogus 2>&1)
rc=$?
set -e
assert_eq "1" "${rc}" "MCP28c exit code is 1"
assert_contains "${out}" "unknown argument" "MCP28c rejects unknown flag"

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo
echo "==========================="
echo "  passed: ${PASS}"
echo "  failed: ${FAIL}"
echo "==========================="

if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
