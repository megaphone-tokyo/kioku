#!/usr/bin/env bash
#
# install-hooks.test.sh — scripts/install-hooks.sh のスモークテスト
#
# 実行: bash tests/install-hooks.test.sh
#
# 検証項目:
#   - OBSIDIAN_VAULT 未設定なら exit 1
#   - 破壊的書き換えを行わない (~/.claude/settings.json は触らない)
#   - 出力 JSON スニペットが valid JSON であること
#   - 必要な 5 イベント (SessionStart/UserPromptSubmit/Stop/PostToolUse/SessionEnd) を含むこと
#   - 非 git vault では警告を出すが設定は出力すること
#   - 完備された vault では警告が出ないこと

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALL_HOOKS="${REPO_ROOT}/scripts/install-hooks.sh"

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

extract_json() {
  # 出力から { ... } の最初の JSON ブロックだけを抜く
  sed -n '/^{$/,/^}$/p' <<<"$1"
}

# -----------------------------------------------------------------------------
# Test 1: OBSIDIAN_VAULT unset → exit 1
# -----------------------------------------------------------------------------
echo "test: unset OBSIDIAN_VAULT -> exit 1"
set +e
(
  unset OBSIDIAN_VAULT
  bash "${INSTALL_HOOKS}" >/dev/null 2>&1
)
rc=$?
set -e
assert_eq "1" "${rc}" "exit code 1 when OBSIDIAN_VAULT unset"

# -----------------------------------------------------------------------------
# Test 2: non-git vault → warnings present, exit 0, JSON still emitted
# -----------------------------------------------------------------------------
echo "test: non-git vault produces warnings and still outputs JSON"
mkdir -p "${TMPROOT}/vault-nogit"
set +e
output="$(OBSIDIAN_VAULT="${TMPROOT}/vault-nogit" bash "${INSTALL_HOOKS}" 2>/dev/null)"
rc=$?
set -e
assert_eq "0" "${rc}" "exit code 0 for non-git vault"
assert_contains "${output}" "WARNINGS:" "warnings section present"
assert_contains "${output}" "not inside a git repository" "git repository warning"
assert_contains "${output}" "no .gitignore" ".gitignore warning"

json="$(extract_json "${output}")"
if [[ -z "${json}" ]]; then
  fail "JSON block extracted from output"
else
  pass "JSON block extracted from output"
fi

# -----------------------------------------------------------------------------
# Test 3: extracted JSON is valid and has the 5 required hook events
# -----------------------------------------------------------------------------
echo "test: JSON snippet validity"
tmpjson="${TMPROOT}/snippet.json"
printf '%s' "${json}" > "${tmpjson}"
if node -e "const j=require('${tmpjson}'); const keys=Object.keys(j.hooks||{}); process.exit(['SessionStart','UserPromptSubmit','Stop','PostToolUse','SessionEnd'].every(k=>keys.includes(k))?0:1)"; then
  pass "JSON contains all 5 required hook events"
else
  fail "JSON missing required hook events"
fi

# PostToolUse matcher should include MultiEdit
if node -e "const j=require('${tmpjson}'); const m=j.hooks.PostToolUse[0].matcher; process.exit(/MultiEdit/.test(m)?0:1)"; then
  pass "PostToolUse matcher includes MultiEdit"
else
  fail "PostToolUse matcher missing MultiEdit"
fi

# SessionEnd should have 2 entries (logger + git sync)
if node -e "const j=require('${tmpjson}'); process.exit(j.hooks.SessionEnd.length===2?0:1)"; then
  pass "SessionEnd has two chained entries"
else
  fail "SessionEnd should have two chained entries"
fi

# SessionStart should have 2 entries (git pull + wiki-context-injector)
if node -e "const j=require('${tmpjson}'); process.exit(j.hooks.SessionStart.length===2?0:1)"; then
  pass "SessionStart has two chained entries"
else
  fail "SessionStart should have two chained entries (git pull + injector)"
fi

if node -e "const j=require('${tmpjson}'); const cmds=j.hooks.SessionStart.map(e=>e.hooks[0].command).join(' '); process.exit(/git pull/.test(cmds) && /wiki-context-injector\.mjs/.test(cmds) ? 0 : 1)"; then
  pass "SessionStart includes git pull and wiki-context-injector.mjs"
else
  fail "SessionStart should include both git pull and wiki-context-injector.mjs"
fi

# -----------------------------------------------------------------------------
# Test 4: fully-configured vault has no warnings
# -----------------------------------------------------------------------------
echo "test: fully configured vault produces no warnings"
FULLVAULT="${TMPROOT}/vault-full"
mkdir -p "${FULLVAULT}"
(
  cd "${FULLVAULT}"
  git init --quiet
)
echo "session-logs/" > "${FULLVAULT}/.gitignore"

set +e
output_full="$(OBSIDIAN_VAULT="${FULLVAULT}" bash "${INSTALL_HOOKS}" 2>/dev/null)"
rc=$?
set -e
assert_eq "0" "${rc}" "exit code 0 for full vault"
if printf '%s' "${output_full}" | grep -q "WARNINGS:"; then
  fail "no warnings expected for fully configured vault"
else
  pass "no warnings for fully configured vault"
fi

# -----------------------------------------------------------------------------
# Test 5: script does not touch ~/.claude/settings.json (non-destructive)
# -----------------------------------------------------------------------------
echo "test: non-destructive (no filesystem side-effects under HOME)"
FAKE_HOME="${TMPROOT}/fake-home"
mkdir -p "${FAKE_HOME}/.claude"
echo '{"hooks":{}}' > "${FAKE_HOME}/.claude/settings.json"
orig_hash="$(shasum "${FAKE_HOME}/.claude/settings.json" | awk '{print $1}')"

HOME="${FAKE_HOME}" OBSIDIAN_VAULT="${FULLVAULT}" bash "${INSTALL_HOOKS}" >/dev/null 2>&1

after_hash="$(shasum "${FAKE_HOME}/.claude/settings.json" | awk '{print $1}')"
assert_eq "${orig_hash}" "${after_hash}" "user settings.json untouched"

# -----------------------------------------------------------------------------
# Test 6: --apply writes merged settings.json with backup (#3)
# -----------------------------------------------------------------------------
if command -v jq >/dev/null 2>&1; then
  echo "test: --apply merges into target settings.json"
  APPLY_TARGET="${TMPROOT}/apply-settings.json"
  cat > "${APPLY_TARGET}" <<'JSON'
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {"type": "command", "command": "echo existing-user-hook"}
        ]
      }
    ]
  },
  "unrelated": {"keep": true}
}
JSON

  set +e
  out_apply="$(
    CLAUDE_SETTINGS_FILE="${APPLY_TARGET}" \
    OBSIDIAN_VAULT="${FULLVAULT}" \
    bash "${INSTALL_HOOKS}" --apply --yes 2>&1
  )"
  rc=$?
  set -e
  assert_eq "0" "${rc}" "--apply exit code 0"
  assert_contains "${out_apply}" "applied." "apply completion message present"

  # Backup file exists
  backup_files=("${APPLY_TARGET}".bak.*)
  if [[ -f "${backup_files[0]}" ]]; then
    pass "--apply created a timestamped backup"
  else
    fail "--apply did not create a backup"
  fi

  # Unrelated keys preserved
  if jq -e '.unrelated.keep == true' "${APPLY_TARGET}" >/dev/null 2>&1; then
    pass "--apply preserved unrelated top-level keys"
  else
    fail "--apply lost unrelated top-level keys"
  fi

  # Existing user hook preserved (UserPromptSubmit should now have 2 entries)
  user_len=$(jq '.hooks.UserPromptSubmit | length' "${APPLY_TARGET}")
  assert_eq "2" "${user_len}" "--apply appended to existing UserPromptSubmit array (preserved user's entry)"

  # SessionStart has 2 (git pull + injector)
  ss_len=$(jq '.hooks.SessionStart | length' "${APPLY_TARGET}")
  assert_eq "2" "${ss_len}" "--apply SessionStart has 2 entries"

  # SessionEnd has 2 (logger + git sync)
  se_len=$(jq '.hooks.SessionEnd | length' "${APPLY_TARGET}")
  assert_eq "2" "${se_len}" "--apply SessionEnd has 2 entries"

  # -----------------------------------------------------------------------------
  # Test 7: --apply is idempotent (run twice -> no duplication)
  # -----------------------------------------------------------------------------
  echo "test: --apply is idempotent"
  CLAUDE_SETTINGS_FILE="${APPLY_TARGET}" \
  OBSIDIAN_VAULT="${FULLVAULT}" \
  bash "${INSTALL_HOOKS}" --apply --yes >/dev/null 2>&1

  user_len2=$(jq '.hooks.UserPromptSubmit | length' "${APPLY_TARGET}")
  assert_eq "2" "${user_len2}" "second --apply: UserPromptSubmit still 2 (no duplication)"

  ss_len2=$(jq '.hooks.SessionStart | length' "${APPLY_TARGET}")
  assert_eq "2" "${ss_len2}" "second --apply: SessionStart still 2"

  se_len2=$(jq '.hooks.SessionEnd | length' "${APPLY_TARGET}")
  assert_eq "2" "${se_len2}" "second --apply: SessionEnd still 2"

  pt_len2=$(jq '.hooks.PostToolUse | length' "${APPLY_TARGET}")
  assert_eq "1" "${pt_len2}" "second --apply: PostToolUse still 1"

  # -----------------------------------------------------------------------------
  # Test 8: --apply refuses invalid JSON target
  # -----------------------------------------------------------------------------
  echo "test: --apply refuses corrupt settings.json"
  BADTARGET="${TMPROOT}/bad-settings.json"
  echo "{this is not json" > "${BADTARGET}"
  set +e
  (
    CLAUDE_SETTINGS_FILE="${BADTARGET}" \
    OBSIDIAN_VAULT="${FULLVAULT}" \
    bash "${INSTALL_HOOKS}" --apply --yes >/dev/null 2>&1
  )
  rc=$?
  set -e
  assert_eq "2" "${rc}" "--apply exits 2 on invalid target JSON"

  # -----------------------------------------------------------------------------
  # Test 9: --apply creates target file if missing
  # -----------------------------------------------------------------------------
  echo "test: --apply creates missing target"
  MISSING_TARGET="${TMPROOT}/new-dir/settings.json"
  set +e
  (
    CLAUDE_SETTINGS_FILE="${MISSING_TARGET}" \
    OBSIDIAN_VAULT="${FULLVAULT}" \
    bash "${INSTALL_HOOKS}" --apply --yes >/dev/null 2>&1
  )
  rc=$?
  set -e
  assert_eq "0" "${rc}" "--apply exit 0 when target missing"
  if [[ -f "${MISSING_TARGET}" ]] && jq -e '.hooks.SessionStart | length == 2' "${MISSING_TARGET}" >/dev/null 2>&1; then
    pass "--apply created new target with our hooks"
  else
    fail "--apply failed to create new target"
  fi
else
  echo "skip: jq not found, skipping --apply tests"
fi

# -----------------------------------------------------------------------------
# Test: スペース入りパスでの JSON 有効性 (OSS-003)
# -----------------------------------------------------------------------------
echo "test: space in vault path produces valid JSON"
SPACE_VAULT="${TMPROOT}/vault with spaces/my vault"
mkdir -p "${SPACE_VAULT}"
cd "${SPACE_VAULT}" && git init -q && echo 'session-logs/' > .gitignore && cd "${TMPROOT}"

set +e
space_output="$(OBSIDIAN_VAULT="${SPACE_VAULT}" bash "${INSTALL_HOOKS}" 2>/dev/null)"
rc=$?
set -e
assert_eq "0" "${rc}" "exit code 0 for space-in-path vault"

space_json="$(extract_json "${space_output}")"
if [[ -n "${space_json}" ]]; then
  pass "JSON block extracted from space-in-path output"
else
  fail "JSON block not found in space-in-path output"
fi

# JSON が valid か検証
space_tmpjson="${TMPROOT}/space-snippet.json"
printf '%s' "${space_json}" > "${space_tmpjson}"
if node -e "require('${space_tmpjson}'); process.exit(0)" 2>/dev/null; then
  pass "space-in-path JSON is valid"
else
  fail "space-in-path JSON is invalid"
fi

# コマンド内のパスがクォートされていてシェルとして機能するか
if node -e "const j=require('${space_tmpjson}'); const c=j.hooks.UserPromptSubmit[0].hooks[0].command; process.exit(c.includes(\"'\")?0:1)" 2>/dev/null; then
  pass "space-in-path: script path is quoted in command"
else
  fail "space-in-path: script path is not quoted"
fi

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
