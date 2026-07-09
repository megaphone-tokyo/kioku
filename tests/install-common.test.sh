#!/usr/bin/env bash
#
# install-common.test.sh — scripts/lib/install-common.sh (PR S6-1) のテスト
#
# 実行: bash tools/claude-brain/tests/install-common.test.sh
#
# F-number は per-file scope (本ファイル新設のため F1 から採番、LEARN#8a)。
#
# 検証項目:
#   F1  正常系: 典型的な vault path (英数字 / '/' / '.' / '_' / 空白 / '-') → exit 0
#   F2  正常系: '..' を含む path は文字種 (charset) 検査上は通る (現行挙動の pinning。
#       validate_vault_path の責務はシェルメタ文字遮断であり、'.' '/' のみの traversal
#       文字列は charset 的に合法 — 挙動変更なしの受け入れ条件を regression guard 化)
#   F3  path traversal + command injection ('$(...)' / バッククォート / ';') → exit 1
#   F4  空文字列 → exit 1
#   F5  特殊文字 (シェルメタ文字 '&' '|' '>' '~' '*' / クォート) → 各 exit 1。
#       改行 / タブは POSIX [:space:] に含まれ charset 合格 (現行挙動の pinning)
#   F6  エラーメッセージは 'ERROR:' prefix に統一 (旧 'error:' 不使用) + ヒント行
#   F7  LOG_PREFIX 定義済み script では prefix がメッセージ先頭に付く
#   F8  LOG_PREFIX 未定義 + set -u でも unbound variable エラーにならない
#   F9  直接実行 guard: bash scripts/lib/install-common.sh → exit 1 + source-only エラー
#   F10 SSOT invariant: scripts/*.sh に inline 'validate_vault_path() {' 定義が 0 件
#   F11 SSOT invariant: 対象 12 script 全てが lib/install-common.sh を source する
#   F12 regex invariant: lib の safe_re が '^[a-zA-Z0-9/._[:space:]-]+$' と 1 文字違わず一致

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
TOOL_ROOT="${REPO_ROOT}/tools/claude-brain"
SCRIPTS_DIR="${TOOL_ROOT}/scripts"
LIB="${SCRIPTS_DIR}/lib/install-common.sh"

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

# run_validate <path> — set -u 下の子プロセスで lib を source して validate を呼ぶ。
# stdout: なし / stderr: ${TMPROOT}/stderr.txt / 戻り値: exit code
run_validate() {
  local input="$1"
  local rc=0
  bash -c 'set -euo pipefail; source "$1"; validate_vault_path "$2"' _ "${LIB}" "${input}" \
    2>"${TMPROOT}/stderr.txt" || rc=$?
  return "${rc}"
}

# -----------------------------------------------------------------------------
# F1: 正常系
# -----------------------------------------------------------------------------
echo "test F1: 正常系 vault path は exit 0"

rc=0
run_validate "/Users/test user/claude-brain/main_vault-01.d" || rc=$?
assert_eq "0" "${rc}" "F1 典型 path (英数字 / '/' / '.' / '_' / 空白 / '-') は exit 0"

# -----------------------------------------------------------------------------
# F2: '..' を含む path は charset 検査上は通る (現行挙動 pinning)
# -----------------------------------------------------------------------------
echo "test F2: '..' を含む path の charset 合格 (現行挙動 pinning)"

rc=0
run_validate "/tmp/vault/../other" || rc=$?
assert_eq "0" "${rc}" "F2 '..' 自体は許可文字のみで構成され exit 0 (挙動変更なし)"

# -----------------------------------------------------------------------------
# F3: path traversal + command injection は exit 1
# -----------------------------------------------------------------------------
echo "test F3: traversal + injection は exit 1"

rc=0
run_validate '/tmp/vault/../$(whoami)' || rc=$?
assert_eq "1" "${rc}" "F3a '\$(...)' command substitution 混入は exit 1"

rc=0
run_validate '/tmp/vault/../`id`' || rc=$?
assert_eq "1" "${rc}" "F3b バッククォート混入は exit 1"

rc=0
run_validate '/tmp/vault; rm -rf /' || rc=$?
assert_eq "1" "${rc}" "F3c ';' 混入は exit 1"

# -----------------------------------------------------------------------------
# F4: 空文字列は exit 1
# -----------------------------------------------------------------------------
echo "test F4: 空文字列は exit 1"

rc=0
run_validate "" || rc=$?
assert_eq "1" "${rc}" "F4 空文字列は exit 1"

# -----------------------------------------------------------------------------
# F5: 特殊文字は exit 1
# -----------------------------------------------------------------------------
echo "test F5: 特殊文字は exit 1"

for bad in '/v&ult' '/va|ult' '/vault>out' '~/vault' '/vault/*' "/vault'q" '/vault"q'; do
  rc=0
  run_validate "${bad}" || rc=$?
  assert_eq "1" "${rc}" "F5 特殊文字 path (${bad}) は exit 1"
done

# 改行 / タブは POSIX [:space:] に含まれるため charset 検査上は合格する
# (現行 regex の挙動 pinning。regex は 1 文字も変えない受け入れ条件のため、
# ここでの拒否強化は S6-1 の scope 外 — 変更する場合は別 PR + regex 変更の合意が必要)
rc=0
run_validate "$(printf '/vault\nx')" || rc=$?
assert_eq "0" "${rc}" "F5 改行は [:space:] に含まれ charset 合格 (現行挙動 pinning)"

# -----------------------------------------------------------------------------
# F6: エラーメッセージは 'ERROR:' prefix + ヒント行
# -----------------------------------------------------------------------------
echo "test F6: エラーメッセージの ERROR: prefix 統一"

rc=0
run_validate '/bad;path' || rc=$?
stderr_out="$(cat "${TMPROOT}/stderr.txt")"
assert_contains "${stderr_out}" "ERROR: OBSIDIAN_VAULT contains unsafe characters:" \
  "F6a stderr は 'ERROR:' prefix で始まる統一メッセージ"
assert_not_contains "${stderr_out}" "error: OBSIDIAN_VAULT" \
  "F6b 旧 'error:' 小文字 prefix を使わない"
assert_contains "${stderr_out}" "Only alphanumerics, /, ., _, space, and - are allowed." \
  "F6c 許可文字のヒント行を含む"

# -----------------------------------------------------------------------------
# F7: LOG_PREFIX 定義済みなら prefix が付く
# -----------------------------------------------------------------------------
echo "test F7: LOG_PREFIX 付与 (cron 系 script 互換)"

rc=0
bash -c 'set -euo pipefail; LOG_PREFIX="[test-prefix]"; source "$1"; validate_vault_path "$2"' \
  _ "${LIB}" '/bad;path' 2>"${TMPROOT}/stderr.txt" || rc=$?
assert_eq "1" "${rc}" "F7a LOG_PREFIX 定義時も exit 1"
assert_contains "$(cat "${TMPROOT}/stderr.txt")" "[test-prefix] ERROR: OBSIDIAN_VAULT contains unsafe characters:" \
  "F7b メッセージ先頭に LOG_PREFIX が付く"

# -----------------------------------------------------------------------------
# F8: LOG_PREFIX 未定義 + set -u で安全
# -----------------------------------------------------------------------------
echo "test F8: LOG_PREFIX 未定義 + set -u"

rc=0
run_validate '/bad;path' || rc=$?
stderr_out="$(cat "${TMPROOT}/stderr.txt")"
assert_eq "1" "${rc}" "F8a set -u + LOG_PREFIX 未定義でも exit 1 (unbound エラーでなく検証エラー)"
assert_not_contains "${stderr_out}" "unbound variable" "F8b 'unbound variable' を出さない"

# -----------------------------------------------------------------------------
# F9: 直接実行 guard
# -----------------------------------------------------------------------------
echo "test F9: source 専用 guard (直接実行は exit 1)"

rc=0
bash "${LIB}" >"${TMPROOT}/stdout.txt" 2>"${TMPROOT}/stderr.txt" || rc=$?
assert_eq "1" "${rc}" "F9a 直接実行は exit 1"
assert_contains "$(cat "${TMPROOT}/stderr.txt")" "source-only library" \
  "F9b source-only エラーメッセージを stderr に出す"

# -----------------------------------------------------------------------------
# F10: SSOT invariant — inline 定義 0 件
# (S6-5: install/{user,internal}/ 階層化後も全 .sh を対象に検査)
# -----------------------------------------------------------------------------
echo "test F10: scripts 配下の .sh に inline 定義が残っていない"

set +e
inline_defs="$(grep -l "validate_vault_path() {" \
  "${SCRIPTS_DIR}"/*.sh \
  "${SCRIPTS_DIR}"/install/user/*.sh \
  "${SCRIPTS_DIR}"/install/internal/*.sh 2>/dev/null | tr '\n' ' ')"
set -e
if [[ -z "${inline_defs// }" ]]; then
  pass "F10 inline validate_vault_path 定義 0 件 (SSOT は lib のみ)"
else
  fail "F10 inline 定義が残存: ${inline_defs}"
fi

# -----------------------------------------------------------------------------
# F11: SSOT invariant — 対象 12 script が lib を source
# (S6-5: install-* 7 本は scripts/install/{user,internal}/ へ移動、source 行の
#  相対 path が異なる。scripts/ 直下に残る 5 本と分けて検査する)
# -----------------------------------------------------------------------------
echo "test F11: 対象 12 script が install-common.sh を source する"

SOURCE_LINE_ROOT='source "$(dirname "${BASH_SOURCE[0]}")/lib/install-common.sh"'
SOURCE_LINE_MOVED='source "$(dirname "${BASH_SOURCE[0]}")/../../lib/install-common.sh"'

root_scripts="auto-ingest.sh auto-lint.sh scan-secrets.sh setup-qmd.sh setup-vault.sh"
moved_scripts="install/user/install-hooks.sh install/user/install-hooks-gemini.sh \
install/user/install-hooks-codex.sh install/internal/install-mcp-client.sh \
install/internal/install-cron.sh install/internal/install-launchagents.sh \
install/internal/install-competitor-watch.sh"

missing=""
for s in ${root_scripts}; do
  if ! grep -q -F -- "${SOURCE_LINE_ROOT}" "${SCRIPTS_DIR}/${s}"; then
    missing="${missing} ${s}"
  fi
done
for s in ${moved_scripts}; do
  if ! grep -q -F -- "${SOURCE_LINE_MOVED}" "${SCRIPTS_DIR}/${s}"; then
    missing="${missing} ${s}"
  fi
done
if [[ -z "${missing// }" ]]; then
  pass "F11 12 script 全てが source 行を持つ (root 5 + moved 7)"
else
  fail "F11 source 行が無い script:${missing}"
fi

# -----------------------------------------------------------------------------
# F12: regex invariant — safe_re は複製時代と 1 文字も違わない
# -----------------------------------------------------------------------------
echo "test F12: lib の safe_re literal が現行 regex と一致"

if grep -q -F -- "local safe_re='^[a-zA-Z0-9/._[:space:]-]+\$'" "${LIB}"; then
  pass "F12 safe_re は '^[a-zA-Z0-9/._[:space:]-]+\$' と一致 (挙動変更なし)"
else
  fail "F12 safe_re literal が期待値と不一致 (挙動変更の疑い)"
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
