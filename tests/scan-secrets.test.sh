#!/usr/bin/env bash
#
# scan-secrets.test.sh — scripts/scan-secrets.sh のスモークテスト
#
# 実行: bash tests/scan-secrets.test.sh
#
# 検証項目:
#   S1 OBSIDIAN_VAULT が存在しない → exit 1
#   S2 session-logs/ が存在しない → exit 1
#   S3 クリーンな session-logs/ (マスク済みのみ) → exit 0 + "no secret-like patterns"
#   S4 生の ghp_ トークンを含むログ → exit 2 + GitHub PAT ヒット検出
#   S5 複数パターン混在 → exit 2 + 全パターンが報告される
#   S6 --json 出力 → total_hits フィールド含む JSON 1 行
#   S7 .md 以外 (.log) のファイルに秘密情報 → ヒットしない (対象外確認)
#   S8 マスク済みプレースホルダ (`sk-ant-***`) → false positive を出さない

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SCAN_SCRIPT="${REPO_ROOT}/scripts/scan-secrets.sh"

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

assert_not_contains() {
  if printf '%s' "$1" | grep -q -F -- "$2"; then
    fail "$3 (substring unexpectedly found: $2)"
  else
    pass "$3"
  fi
}

# -----------------------------------------------------------------------------
# ヘルパー: 有効な vault を作る
# -----------------------------------------------------------------------------
make_vault() {
  local name="$1"
  local vault="${TMPROOT}/${name}"
  mkdir -p "${vault}/session-logs" "${vault}/wiki"
  : > "${vault}/CLAUDE.md"
  printf '%s' "${vault}"
}

add_log() {
  local vault="$1"
  local name="$2"
  local content="$3"
  printf '%s\n' "${content}" > "${vault}/session-logs/${name}.md"
}

# -----------------------------------------------------------------------------
# Test S1: OBSIDIAN_VAULT が存在しない → exit 1
# -----------------------------------------------------------------------------
echo "test S1: missing OBSIDIAN_VAULT -> exit 1"
set +e
(
  OBSIDIAN_VAULT="${TMPROOT}/does-not-exist" \
  bash "${SCAN_SCRIPT}" >/dev/null 2>&1
)
rc=$?
set -e
assert_eq "1" "${rc}" "S1 exit code 1 when vault missing"

# -----------------------------------------------------------------------------
# Test S2: session-logs/ が存在しない → exit 1
# -----------------------------------------------------------------------------
echo "test S2: missing session-logs/ -> exit 1"
VAULT_S2="${TMPROOT}/vault-s2"
mkdir -p "${VAULT_S2}"
: > "${VAULT_S2}/CLAUDE.md"
set +e
(
  OBSIDIAN_VAULT="${VAULT_S2}" \
  bash "${SCAN_SCRIPT}" >/dev/null 2>&1
)
rc=$?
set -e
assert_eq "1" "${rc}" "S2 exit code 1 when session-logs missing"

# -----------------------------------------------------------------------------
# Test S3: クリーンなログ (秘密情報なし) → exit 0 + "no secret-like"
# -----------------------------------------------------------------------------
echo "test S3: clean logs -> exit 0"
VAULT_S3="$(make_vault vault-s3)"
add_log "${VAULT_S3}" "20260101-101010-abcd-test" "# Session
normal text without any secret material, just code discussion."

set +e
out_s3="$(OBSIDIAN_VAULT="${VAULT_S3}" bash "${SCAN_SCRIPT}" 2>&1)"
rc=$?
set -e
assert_eq "0" "${rc}" "S3 exit code 0 when no leaks"
assert_contains "${out_s3}" "no secret-like patterns" "S3 clean message present"

# -----------------------------------------------------------------------------
# Test S4: 生の ghp_ トークン → exit 2 + ヒット検出
# -----------------------------------------------------------------------------
echo "test S4: raw ghp_ token -> exit 2 + detected"
VAULT_S4="$(make_vault vault-s4)"
add_log "${VAULT_S4}" "20260101-102020-efgh-leak" "# Session
oops I pasted: ghp_abcdefghijklmnopqrstuvwxyz0123456789 here"

set +e
out_s4="$(OBSIDIAN_VAULT="${VAULT_S4}" bash "${SCAN_SCRIPT}" 2>&1)"
rc=$?
set -e
assert_eq "2" "${rc}" "S4 exit code 2 when leaks found"
assert_contains "${out_s4}" "GitHub personal access token" "S4 ghp_ category reported"
assert_contains "${out_s4}" "WARNING" "S4 warning header present"

# -----------------------------------------------------------------------------
# Test S5: 複数パターン混在 → 全パターンがレポートされる
# -----------------------------------------------------------------------------
echo "test S5: multiple patterns -> all reported"
VAULT_S5="$(make_vault vault-s5)"
add_log "${VAULT_S5}" "20260101-103030-ijkl-multi" "# Session
Anthropic: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789
AWS: AKIAIOSFODNN7EXAMPLE
Google: AIzaSyA-abcdefghijklmnopqrstuvwxyz012
Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig
"

set +e
out_s5="$(OBSIDIAN_VAULT="${VAULT_S5}" bash "${SCAN_SCRIPT}" 2>&1)"
rc=$?
set -e
assert_eq "2" "${rc}" "S5 exit code 2"
assert_contains "${out_s5}" "Anthropic API key" "S5 sk-ant reported"
assert_contains "${out_s5}" "AWS access key" "S5 AKIA reported"
assert_contains "${out_s5}" "Google API key" "S5 AIza reported"
assert_contains "${out_s5}" "Bearer token" "S5 Bearer reported"

# -----------------------------------------------------------------------------
# Test S6: --json 出力 → JSON 1 行
# -----------------------------------------------------------------------------
echo "test S6: --json mode -> structured output"
set +e
out_s6="$(OBSIDIAN_VAULT="${VAULT_S5}" bash "${SCAN_SCRIPT}" --json 2>&1)"
rc=$?
set -e
assert_eq "2" "${rc}" "S6 exit code 2 (leaks present)"
assert_contains "${out_s6}" '"total_hits":' "S6 JSON contains total_hits"
assert_contains "${out_s6}" '"vault":' "S6 JSON contains vault"

# クリーンな vault では total_hits:0
set +e
out_s6b="$(OBSIDIAN_VAULT="${VAULT_S3}" bash "${SCAN_SCRIPT}" --json 2>&1)"
rc=$?
set -e
assert_eq "0" "${rc}" "S6b exit code 0 (no leaks, json)"
assert_contains "${out_s6b}" '"total_hits"' "S6b JSON total_hits present"

# -----------------------------------------------------------------------------
# Test S7: .md 以外 (.log) は対象外
# -----------------------------------------------------------------------------
echo "test S7: non-md files not scanned"
VAULT_S7="$(make_vault vault-s7)"
# session-logs/ 直下の .log は対象外であるべき (errors.log など)
mkdir -p "${VAULT_S7}/session-logs/.KIOKU"
printf 'ghp_abcdefghijklmnopqrstuvwxyz0123456789\n' \
  > "${VAULT_S7}/session-logs/.KIOKU/errors.log"

set +e
out_s7="$(OBSIDIAN_VAULT="${VAULT_S7}" bash "${SCAN_SCRIPT}" 2>&1)"
rc=$?
set -e
assert_eq "0" "${rc}" "S7 exit code 0 (log files not scanned)"
assert_contains "${out_s7}" "no secret-like patterns" "S7 clean message"

# -----------------------------------------------------------------------------
# Test S8: マスク済みプレースホルダは false positive を出さない
# -----------------------------------------------------------------------------
echo "test S8: masked placeholders -> not flagged"
VAULT_S8="$(make_vault vault-s8)"
add_log "${VAULT_S8}" "20260101-104040-mnop-masked" "# Session
Already masked: sk-ant-*** and ghp_*** and AKIA*** and Bearer ***
These should NOT count as leaks."

set +e
out_s8="$(OBSIDIAN_VAULT="${VAULT_S8}" bash "${SCAN_SCRIPT}" 2>&1)"
rc=$?
set -e
assert_eq "0" "${rc}" "S8 exit code 0 (masked placeholders clean)"
assert_contains "${out_s8}" "no secret-like patterns" "S8 clean message"

# -----------------------------------------------------------------------------
# サマリ
# -----------------------------------------------------------------------------
echo
echo "==========================="
echo "  passed: ${PASS}"
echo "  failed: ${FAIL}"
echo "==========================="

if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
