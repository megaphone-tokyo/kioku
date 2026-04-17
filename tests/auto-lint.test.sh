#!/usr/bin/env bash
#
# auto-lint.test.sh — scripts/auto-lint.sh のスモークテスト
#
# 実行: bash tools/claude-brain/tests/auto-lint.test.sh
#
# 検証項目 (Phase G.5 / G1〜G5):
#   G1 wiki ページ 0 件 → claude 呼ばず exit 0
#   G2 OBSIDIAN_VAULT が存在しない → exit 1
#   G3 claude コマンドが PATH にない → exit 1
#   G4 wiki ページあり + DRY RUN → lint-report.md が生成される
#   G5 非 git vault → Lint 処理自体は成功 (git は silently skip)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
AUTO_LINT="${REPO_ROOT}/tools/claude-brain/scripts/auto-lint.sh"

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
# stub claude バイナリ
# -----------------------------------------------------------------------------
STUB_DIR="${TMPROOT}/stub-bin"
mkdir -p "${STUB_DIR}"
cat > "${STUB_DIR}/claude" <<'STUB'
#!/usr/bin/env bash
echo "stub-claude called with $# args" >&2
exit 0
STUB
chmod +x "${STUB_DIR}/claude"

# -----------------------------------------------------------------------------
# 有効な vault を作るヘルパー
# -----------------------------------------------------------------------------
make_vault() {
  local name="$1"
  local vault="${TMPROOT}/${name}"
  mkdir -p "${vault}/session-logs" "${vault}/wiki" "${vault}/raw-sources" "${vault}/templates"
  : > "${vault}/CLAUDE.md"
  echo "${vault}"
}

add_wiki_page() {
  local vault="$1"
  local name="$2"
  cat > "${vault}/wiki/${name}.md" <<EOF
---
title: ${name}
tags: [test]
updated: 2026-04-15
---

# ${name}

body
EOF
}

# -----------------------------------------------------------------------------
# Test G2: OBSIDIAN_VAULT が存在しない → exit 1
# -----------------------------------------------------------------------------
echo "test G2: missing OBSIDIAN_VAULT -> exit 1"
set +e
(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${TMPROOT}/does-not-exist" \
  bash "${AUTO_LINT}" >/dev/null 2>&1
)
rc=$?
set -e
assert_eq "1" "${rc}" "G2 exit code 1 when vault missing"

# -----------------------------------------------------------------------------
# Test G3: claude コマンドが PATH にない → exit 1
# -----------------------------------------------------------------------------
echo "test G3: claude not in PATH -> exit 1"
VAULT_G3="$(make_vault vault-g3)"
FAKE_HOME_G3="${TMPROOT}/fake-home-g3"
mkdir -p "${FAKE_HOME_G3}"
set +e
out_g3="$(
  env -i \
    HOME="${FAKE_HOME_G3}" \
    PATH="/usr/bin:/bin" \
    OBSIDIAN_VAULT="${VAULT_G3}" \
    bash "${AUTO_LINT}" 2>&1
)"
rc=$?
set -e
assert_eq "1" "${rc}" "G3 exit code 1 when claude missing"
assert_contains "${out_g3}" "claude command not found" "G3 error message present"

# -----------------------------------------------------------------------------
# Test G1: wiki ページ 0 件 → claude 呼ばず exit 0
# -----------------------------------------------------------------------------
echo "test G1: no wiki pages -> skip"
VAULT_G1="$(make_vault vault-g1)"
# index.md / log.md / lint-report.md はカウント対象外なので置いても 0 扱い
: > "${VAULT_G1}/wiki/index.md"
: > "${VAULT_G1}/wiki/log.md"
set +e
out_g1="$(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_G1}" \
  bash "${AUTO_LINT}" 2>&1
)"
rc=$?
set -e
assert_eq "0" "${rc}" "G1 exit code 0 when wiki empty"
assert_contains "${out_g1}" "no content pages" "G1 skip message present"
if printf '%s' "${out_g1}" | grep -q "stub-claude called"; then
  fail "G1 claude stub should NOT be called"
else
  pass "G1 claude stub was not called"
fi

# -----------------------------------------------------------------------------
# Test G4: wiki ページあり + DRY RUN → lint-report.md が生成される
# -----------------------------------------------------------------------------
echo "test G4: wiki pages present + dry run -> lint-report.md generated"
VAULT_G4="$(make_vault vault-g4)"
add_wiki_page "${VAULT_G4}" "concept-a"
add_wiki_page "${VAULT_G4}" "concept-b"
(cd "${VAULT_G4}" && git init --quiet && git -c user.email=t@test -c user.name=t commit --allow-empty -m init --quiet)

set +e
out_g4="$(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_G4}" \
  KIOKU_DRY_RUN=1 \
  bash "${AUTO_LINT}" 2>&1
)"
rc=$?
set -e
assert_eq "0" "${rc}" "G4 exit code 0"
assert_contains "${out_g4}" "Found 2 wiki page" "G4 counted 2 pages"
assert_contains "${out_g4}" "DRY RUN: would call claude" "G4 reached lint call (dry run)"
if [[ -f "${VAULT_G4}/wiki/lint-report.md" ]]; then
  pass "G4 lint-report.md exists"
else
  fail "G4 lint-report.md was not created"
fi

# -----------------------------------------------------------------------------
# Test G5: 非 git vault → Lint は成功、git 操作は silent skip
# -----------------------------------------------------------------------------
echo "test G5: non-git vault -> lint succeeds, git skipped"
VAULT_G5="$(make_vault vault-g5)"
add_wiki_page "${VAULT_G5}" "concept-c"

set +e
out_g5="$(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_G5}" \
  KIOKU_DRY_RUN=1 \
  bash "${AUTO_LINT}" 2>&1
)"
rc=$?
set -e
assert_eq "0" "${rc}" "G5 exit code 0 for non-git vault"
assert_contains "${out_g5}" "DRY RUN: would call claude" "G5 lint path reached"
assert_contains "${out_g5}" "DRY RUN: skipping git" "G5 dry-run git skip notice present"

# -----------------------------------------------------------------------------
# Test G6: 自己診断セクションの max_turns 検知 (#4)
# 偽の ingest ログに "max turns" を仕込み、WARNING が出ることを確認
# -----------------------------------------------------------------------------
echo "test G6: self-diagnostics detects max_turns in ingest log"
VAULT_G6="$(make_vault vault-g6)"
add_wiki_page "${VAULT_G6}" "concept-d"
FAKE_INGEST_LOG="${TMPROOT}/fake-ingest-g6.log"
cat > "${FAKE_INGEST_LOG}" <<'LOG'
[auto-ingest 20260101-0700] Processing 2 logs...
Error: reached max turns without completing the task.
LOG

set +e
out_g6="$(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_G6}" \
  KIOKU_DRY_RUN=1 \
  KIOKU_INGEST_LOG="${FAKE_INGEST_LOG}" \
  bash "${AUTO_LINT}" 2>&1
)"
rc=$?
set -e
assert_eq "0" "${rc}" "G6 exit code 0"
assert_contains "${out_g6}" "self-diagnostics" "G6 diagnostics header present"
assert_contains "${out_g6}" "[#4] WARNING" "G6 max_turns warning present"

# -----------------------------------------------------------------------------
# Test G7: 自己診断セクションの OK パス (#4 無事 / #5 スキップ or 本文 / #6 OK)
# ingest ログに max_turns が無ければ OK メッセージ
# -----------------------------------------------------------------------------
echo "test G7: self-diagnostics OK path"
VAULT_G7="$(make_vault vault-g7)"
add_wiki_page "${VAULT_G7}" "concept-e"
FAKE_INGEST_LOG_CLEAN="${TMPROOT}/fake-ingest-g7.log"
printf '[auto-ingest 20260101-0700] OK: processed 3 logs.\n' > "${FAKE_INGEST_LOG_CLEAN}"

set +e
out_g7="$(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_G7}" \
  KIOKU_DRY_RUN=1 \
  KIOKU_INGEST_LOG="${FAKE_INGEST_LOG_CLEAN}" \
  bash "${AUTO_LINT}" 2>&1
)"
rc=$?
set -e
assert_eq "0" "${rc}" "G7 exit code 0"
assert_contains "${out_g7}" "[#4] OK" "G7 max_turns OK"
assert_contains "${out_g7}" "[#6] OK" "G7 scan-secrets OK"

# -----------------------------------------------------------------------------
# Test G8: 自己診断の #6 が session-logs/ に漏れを検出できる
# -----------------------------------------------------------------------------
echo "test G8: self-diagnostics detects secret leak via scan-secrets"
VAULT_G8="$(make_vault vault-g8)"
add_wiki_page "${VAULT_G8}" "concept-f"
cat > "${VAULT_G8}/session-logs/20260101-090000-test-leak.md" <<'LEAK'
---
type: session-log
---
oops: ghp_abcdefghijklmnopqrstuvwxyz0123456789
LEAK

set +e
out_g8="$(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_G8}" \
  KIOKU_DRY_RUN=1 \
  KIOKU_INGEST_LOG="${TMPROOT}/nonexistent-g8.log" \
  bash "${AUTO_LINT}" 2>&1
)"
rc=$?
set -e
assert_eq "0" "${rc}" "G8 exit code 0 (auto-lint itself still succeeds)"
assert_contains "${out_g8}" "[#6] WARNING" "G8 scan-secrets warning present"
assert_contains "${out_g8}" "GitHub personal access token" "G8 leak category reported"

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
