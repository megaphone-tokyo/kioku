#!/usr/bin/env bash
#
# install-oneliner.test.sh — scripts/install.sh のスモークテスト (H1 oneline install path)
#
# 実行: bash tools/claude-brain/tests/install-oneliner.test.sh
#
# 検証項目 (handoff §Acceptance criteria の test A-D に対応):
#   A. --help で help text 表示 (Mode 説明 + flag 一覧)
#   B. --dry-run --mode=a で Mode A 案内が出力される (script 自体は破壊しない)
#   C. --dry-run --mode=c で Mode C dispatch chain が dry-run mode で呼ばれる
#   D. smart default 判定が動く (CLI 検出環境別の 4 pattern)
#
# Non-destructive 確認:
#   - ~/.claude/settings.json (test 用 fake HOME) を破壊しないこと
#   - OBSIDIAN_VAULT (test 用 temp dir) のみ書き込みが起きること

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
INSTALL_SH="${REPO_ROOT}/tools/claude-brain/scripts/install.sh"

if [[ ! -f "${INSTALL_SH}" ]]; then
  echo "ERROR: install.sh not found at ${INSTALL_SH}" >&2
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
    fail "$3 (unexpected substring found: $2)"
  else
    pass "$3"
  fi
}

# CLI 検出 sensor を確実に false にするために minimal PATH で sandbox 化:
# /usr/bin と /bin のみを通す。claude / codex / gemini はこれらに無い想定。
# (parent dev env では /opt/homebrew/bin などに claude binary がある場合があるので必須)
SANDBOX_PATH="/usr/bin:/bin"

# -----------------------------------------------------------------------------
# Test A: --help で help text 表示 (Mode 説明 + flag 一覧)
# -----------------------------------------------------------------------------
echo "test A: --help displays usage text"
set +e
output_help="$(bash "${INSTALL_SH}" --help 2>&1)"
rc=$?
set -e
assert_eq "0" "${rc}" "A1: --help exits with 0"
assert_contains "${output_help}" "KIOKU one-line installer" "A2: --help shows installer title"
assert_contains "${output_help}" "Mode A" "A3: --help mentions Mode A"
assert_contains "${output_help}" "Mode C" "A4: --help mentions Mode C"
assert_contains "${output_help}" "--dry-run" "A5: --help mentions --dry-run flag"
assert_contains "${output_help}" "--mode=" "A6: --help mentions --mode= flag"
assert_contains "${output_help}" "OBSIDIAN_VAULT" "A7: --help mentions OBSIDIAN_VAULT"

# -----------------------------------------------------------------------------
# Test B: --dry-run --mode=a が Mode A instruction を表示し非破壊
# -----------------------------------------------------------------------------
echo "test B: --dry-run --mode=a prints Mode A instructions without side-effects"

FAKE_HOME_B="${TMPROOT}/home-b"
mkdir -p "${FAKE_HOME_B}/.claude"
echo '{"hooks":{}}' > "${FAKE_HOME_B}/.claude/settings.json"
orig_hash_b="$(shasum "${FAKE_HOME_B}/.claude/settings.json" | awk '{print $1}')"

set +e
output_b="$(HOME="${FAKE_HOME_B}" PATH="${SANDBOX_PATH}" bash "${INSTALL_SH}" --dry-run --mode=a 2>&1)"
rc=$?
set -e
assert_eq "0" "${rc}" "B1: --dry-run --mode=a exits with 0"
assert_contains "${output_b}" "Mode A" "B2: output mentions Mode A"
assert_contains "${output_b}" "/plugin marketplace add megaphone-tokyo/kioku" "B3: shows marketplace add command"
assert_contains "${output_b}" "/plugin install kioku@megaphone-tokyo" "B4: shows plugin install command"
assert_contains "${output_b}" "dry-run" "B5: indicates dry-run mode"

after_hash_b="$(shasum "${FAKE_HOME_B}/.claude/settings.json" | awk '{print $1}')"
assert_eq "${orig_hash_b}" "${after_hash_b}" "B6: ~/.claude/settings.json untouched"

# -----------------------------------------------------------------------------
# Test C: --dry-run --mode=c で dispatch chain が dry-run mode で動く
# -----------------------------------------------------------------------------
echo "test C: --dry-run --mode=c dispatches subscripts in dry-run mode"

FAKE_HOME_C="${TMPROOT}/home-c"
mkdir -p "${FAKE_HOME_C}/.claude"
echo '{"hooks":{}}' > "${FAKE_HOME_C}/.claude/settings.json"
orig_hash_c="$(shasum "${FAKE_HOME_C}/.claude/settings.json" | awk '{print $1}')"

VAULT_C="${TMPROOT}/vault-c"
mkdir -p "${VAULT_C}"

set +e
output_c="$(HOME="${FAKE_HOME_C}" OBSIDIAN_VAULT="${VAULT_C}" KIOKU_INSTALL_LOCAL=1 PATH="${SANDBOX_PATH}" bash "${INSTALL_SH}" --dry-run --mode=c 2>&1)"
rc=$?
set -e
assert_eq "0" "${rc}" "C1: --dry-run --mode=c exits with 0"
assert_contains "${output_c}" "Mode C dispatch chain" "C2: output shows dispatch chain header"
assert_contains "${output_c}" "setup-vault" "C3: dispatches setup-vault step"
assert_contains "${output_c}" "Mode C dry-run complete" "C4: prints dry-run completion message"
assert_contains "${output_c}" "[dry-run]" "C5: setup-vault.sh dry-run markers present"

# Vault 配下に [created] が dry-run なので実体は作られない
if [[ -d "${VAULT_C}/raw-sources" ]]; then
  fail "C6: vault dirs should NOT exist in dry-run"
else
  pass "C6: vault dirs not created in dry-run"
fi

after_hash_c="$(shasum "${FAKE_HOME_C}/.claude/settings.json" | awk '{print $1}')"
assert_eq "${orig_hash_c}" "${after_hash_c}" "C7: ~/.claude/settings.json untouched"

# OBSIDIAN_VAULT 未設定で Mode C を呼ぶと exit 1
echo "test C8: --mode=c requires OBSIDIAN_VAULT"
set +e
(
  unset OBSIDIAN_VAULT
  HOME="${FAKE_HOME_C}" PATH="${SANDBOX_PATH}" bash "${INSTALL_SH}" --dry-run --mode=c >/dev/null 2>&1
)
rc=$?
set -e
assert_eq "1" "${rc}" "C8: Mode C without OBSIDIAN_VAULT exits with 1"

# -----------------------------------------------------------------------------
# Test D: smart default 判定 が 4 pattern で適切な mode を返す
# -----------------------------------------------------------------------------
echo "test D: smart default mode detection across 4 environment patterns"

# common: --dry-run + --yes で interactive prompt を skip + 副作用 0
# stdout の "recommended mode:  X" を grep して判定する

# Pattern D1: no Claude / Codex / Gemini (何もない HOME) → Mode A 推奨
FAKE_HOME_D1="${TMPROOT}/home-d1"
mkdir -p "${FAKE_HOME_D1}"
set +e
output_d1="$(HOME="${FAKE_HOME_D1}" PATH="${SANDBOX_PATH}" bash "${INSTALL_SH}" --dry-run --mode=a 2>&1)"
rc=$?
set -e
assert_eq "0" "${rc}" "D1.0: nothing detected, --dry-run exits 0"
assert_contains "${output_d1}" "recommended mode:  a" "D1: nothing detected → Mode A recommended"

# Pattern D2: Claude only (.claude dir exists) → Mode A 推奨
FAKE_HOME_D2="${TMPROOT}/home-d2"
mkdir -p "${FAKE_HOME_D2}/.claude"
set +e
output_d2="$(HOME="${FAKE_HOME_D2}" PATH="${SANDBOX_PATH}" bash "${INSTALL_SH}" --dry-run --mode=a 2>&1)"
rc=$?
set -e
assert_eq "0" "${rc}" "D2.0: claude detected, --dry-run exits 0"
assert_contains "${output_d2}" "claude code: yes" "D2.a: claude code detected"
assert_contains "${output_d2}" "recommended mode:  a" "D2: claude only → Mode A recommended"

# Pattern D3: Codex only (.codex dir exists、.claude なし) → Mode C 推奨
FAKE_HOME_D3="${TMPROOT}/home-d3"
mkdir -p "${FAKE_HOME_D3}/.codex"
set +e
output_d3="$(HOME="${FAKE_HOME_D3}" PATH="${SANDBOX_PATH}" bash "${INSTALL_SH}" --dry-run --mode=a 2>&1)"
rc=$?
set -e
assert_eq "0" "${rc}" "D3.0: codex detected, --dry-run exits 0"
assert_contains "${output_d3}" "codex cli:   yes" "D3.a: codex cli detected"
assert_contains "${output_d3}" "claude code: no" "D3.b: claude code NOT detected"
assert_contains "${output_d3}" "recommended mode:  c" "D3: codex only → Mode C recommended"

# Pattern D4: 既存 hooks が ~/.claude/settings.json に設定済 → Mode A 推奨 + warning
FAKE_HOME_D4="${TMPROOT}/home-d4"
mkdir -p "${FAKE_HOME_D4}/.claude"
cat > "${FAKE_HOME_D4}/.claude/settings.json" <<'JSON'
{
  "hooks": {
    "SessionStart": [
      {"hooks": [{"type": "command", "command": "echo existing"}]}
    ]
  }
}
JSON

if command -v jq >/dev/null 2>&1; then
  set +e
  output_d4="$(HOME="${FAKE_HOME_D4}" PATH="${SANDBOX_PATH}" bash "${INSTALL_SH}" --dry-run --mode=a 2>&1)"
  rc=$?
  set -e
  assert_eq "0" "${rc}" "D4.0: existing hooks, --dry-run exits 0"
  assert_contains "${output_d4}" "existing hooks (~/.claude/settings.json):  yes" "D4.a: existing hooks detected"
  assert_contains "${output_d4}" "既存 hooks が見つかりました" "D4.b: warning shown for existing hooks"
else
  echo "  --  D4 skipped (jq not installed; existing-hooks detection is jq-gated by design)"
fi

# -----------------------------------------------------------------------------
# Test E: 不正な argument は exit 1
# -----------------------------------------------------------------------------
echo "test E: invalid argument rejected"
set +e
bash "${INSTALL_SH}" --unknown-flag >/dev/null 2>&1
rc=$?
set -e
assert_eq "1" "${rc}" "E1: unknown flag exits with 1"

set +e
bash "${INSTALL_SH}" --mode=xyz >/dev/null 2>&1
rc=$?
set -e
assert_eq "1" "${rc}" "E2: invalid mode value exits with 1"

# -----------------------------------------------------------------------------
# Test F: bash -n syntax OK (regression guard、handoff Acceptance criteria 1 番)
# -----------------------------------------------------------------------------
echo "test F: bash -n syntax check"
set +e
bash -n "${INSTALL_SH}"
rc=$?
set -e
assert_eq "0" "${rc}" "F1: bash -n install.sh passes"

# -----------------------------------------------------------------------------
# 結果集計
# -----------------------------------------------------------------------------
echo ""
echo "results: ${PASS} passed, ${FAIL} failed"

if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
exit 0
