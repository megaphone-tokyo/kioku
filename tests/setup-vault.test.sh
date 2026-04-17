#!/usr/bin/env bash
#
# setup-vault.test.sh — scripts/setup-vault.sh のスモークテスト
#
# 実行: bash tests/setup-vault.test.sh
#
# 方針:
#   - 実 Vault を絶対に触らない。全テストは mktemp -d の tmpdir で完結
#   - ネットワークアクセスなし
#   - trap で tmpdir を確実にクリーンアップ
#   - bats に依存せず、自作の簡易アサート関数を使う

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SETUP_VAULT="${REPO_ROOT}/scripts/setup-vault.sh"

if [[ ! -x "${SETUP_VAULT}" && ! -f "${SETUP_VAULT}" ]]; then
  echo "FATAL: setup-vault.sh not found at ${SETUP_VAULT}" >&2
  exit 1
fi

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
  local expected="$1"
  local actual="$2"
  local msg="$3"
  if [[ "${expected}" == "${actual}" ]]; then
    pass "${msg}"
  else
    fail "${msg} (expected=${expected}, actual=${actual})"
  fi
}

assert_file_exists() {
  local path="$1"
  local msg="$2"
  if [[ -f "${path}" ]]; then
    pass "${msg}"
  else
    fail "${msg} (file missing: ${path})"
  fi
}

assert_dir_exists() {
  local path="$1"
  local msg="$2"
  if [[ -d "${path}" ]]; then
    pass "${msg}"
  else
    fail "${msg} (dir missing: ${path})"
  fi
}

# -----------------------------------------------------------------------------
# Test 1: OBSIDIAN_VAULT 未設定なら exit 1
# -----------------------------------------------------------------------------
echo "test: unset OBSIDIAN_VAULT -> exit 1"
set +e
(
  unset OBSIDIAN_VAULT
  bash "${SETUP_VAULT}" >/dev/null 2>&1
)
rc=$?
set -e
assert_eq "1" "${rc}" "exit code 1 when OBSIDIAN_VAULT unset"

# -----------------------------------------------------------------------------
# Test 2: 存在しないパスなら exit 2
# -----------------------------------------------------------------------------
echo "test: nonexistent path -> exit 2"
set +e
OBSIDIAN_VAULT="${TMPROOT}/does-not-exist" bash "${SETUP_VAULT}" >/dev/null 2>&1
rc=$?
set -e
assert_eq "2" "${rc}" "exit code 2 when path does not exist"

# -----------------------------------------------------------------------------
# Test 3: パスがファイルなら exit 2
# -----------------------------------------------------------------------------
echo "test: path is a file -> exit 2"
touch "${TMPROOT}/not-a-dir"
set +e
OBSIDIAN_VAULT="${TMPROOT}/not-a-dir" bash "${SETUP_VAULT}" >/dev/null 2>&1
rc=$?
set -e
assert_eq "2" "${rc}" "exit code 2 when path is a file"

# -----------------------------------------------------------------------------
# Test 4: 空 Vault への初期化
# -----------------------------------------------------------------------------
echo "test: fresh vault initialization"
VAULT="${TMPROOT}/vault-fresh"
mkdir -p "${VAULT}"
OBSIDIAN_VAULT="${VAULT}" bash "${SETUP_VAULT}" >/dev/null
assert_dir_exists "${VAULT}/raw-sources/articles" "raw-sources/articles created"
assert_dir_exists "${VAULT}/session-logs" "session-logs created"
assert_dir_exists "${VAULT}/wiki/concepts" "wiki/concepts created"
assert_dir_exists "${VAULT}/wiki/projects" "wiki/projects created"
assert_dir_exists "${VAULT}/wiki/decisions" "wiki/decisions created"
assert_dir_exists "${VAULT}/wiki/patterns" "wiki/patterns created"
assert_dir_exists "${VAULT}/wiki/bugs" "wiki/bugs created"
assert_dir_exists "${VAULT}/wiki/people" "wiki/people created"
assert_dir_exists "${VAULT}/wiki/summaries" "wiki/summaries created"
assert_dir_exists "${VAULT}/wiki/analyses" "wiki/analyses created"
assert_dir_exists "${VAULT}/templates" "templates dir created"
assert_file_exists "${VAULT}/CLAUDE.md" "CLAUDE.md placed"
assert_file_exists "${VAULT}/.gitignore" ".gitignore placed"
assert_file_exists "${VAULT}/wiki/index.md" "wiki/index.md placed"
assert_file_exists "${VAULT}/wiki/log.md" "wiki/log.md placed"
assert_file_exists "${VAULT}/templates/concept.md" "templates/concept.md placed"
assert_file_exists "${VAULT}/templates/project.md" "templates/project.md placed"
assert_file_exists "${VAULT}/templates/decision.md" "templates/decision.md placed"
assert_file_exists "${VAULT}/templates/source-summary.md" "templates/source-summary.md placed"

# -----------------------------------------------------------------------------
# Test 5: 冪等性 — 2 回目の実行で既存ファイルを壊さない
# -----------------------------------------------------------------------------
echo "test: idempotency"
# ユーザー編集を模擬
echo "user-edited content" > "${VAULT}/wiki/index.md"
user_claude_hash_before="$(shasum "${VAULT}/CLAUDE.md" | awk '{print $1}')"
user_index_hash_before="$(shasum "${VAULT}/wiki/index.md" | awk '{print $1}')"

OBSIDIAN_VAULT="${VAULT}" bash "${SETUP_VAULT}" >/dev/null

user_claude_hash_after="$(shasum "${VAULT}/CLAUDE.md" | awk '{print $1}')"
user_index_hash_after="$(shasum "${VAULT}/wiki/index.md" | awk '{print $1}')"

assert_eq "${user_claude_hash_before}" "${user_claude_hash_after}" "CLAUDE.md unchanged on re-run"
assert_eq "${user_index_hash_before}" "${user_index_hash_after}" "user-edited wiki/index.md preserved"

# -----------------------------------------------------------------------------
# Test 6: 既存 CLAUDE.md がある場合 CLAUDE.brain.md に退避
# -----------------------------------------------------------------------------
echo "test: existing CLAUDE.md -> CLAUDE.brain.md"
VAULT2="${TMPROOT}/vault-with-claude"
mkdir -p "${VAULT2}"
echo "my personal CLAUDE" > "${VAULT2}/CLAUDE.md"
original_hash="$(shasum "${VAULT2}/CLAUDE.md" | awk '{print $1}')"

OBSIDIAN_VAULT="${VAULT2}" bash "${SETUP_VAULT}" >/dev/null

after_hash="$(shasum "${VAULT2}/CLAUDE.md" | awk '{print $1}')"
assert_eq "${original_hash}" "${after_hash}" "existing CLAUDE.md not overwritten"
assert_file_exists "${VAULT2}/CLAUDE.brain.md" "CLAUDE.brain.md created as alternative"

# -----------------------------------------------------------------------------
# Test 7: dry-run ではファイルを作らない
# -----------------------------------------------------------------------------
echo "test: dry-run does not write"
VAULT3="${TMPROOT}/vault-dry"
mkdir -p "${VAULT3}"
KIOKU_DRY_RUN=1 OBSIDIAN_VAULT="${VAULT3}" bash "${SETUP_VAULT}" >/dev/null
file_count=$(find "${VAULT3}" -mindepth 1 | wc -l | tr -d ' ')
assert_eq "0" "${file_count}" "dry-run left vault untouched"

# -----------------------------------------------------------------------------
# Test 8: 既存 .gitignore は上書きしない
# -----------------------------------------------------------------------------
echo "test: existing .gitignore preserved"
VAULT4="${TMPROOT}/vault-with-gitignore"
mkdir -p "${VAULT4}"
echo "node_modules/" > "${VAULT4}/.gitignore"
original_gi_hash="$(shasum "${VAULT4}/.gitignore" | awk '{print $1}')"

OBSIDIAN_VAULT="${VAULT4}" bash "${SETUP_VAULT}" >/dev/null

after_gi_hash="$(shasum "${VAULT4}/.gitignore" | awk '{print $1}')"
assert_eq "${original_gi_hash}" "${after_gi_hash}" "existing .gitignore preserved"

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
