#!/usr/bin/env bash
#
# install-hierarchy.test.sh — PR S6-5 (Mode gate + install-*.sh 階層化) のテスト
#
# 実行: bash tools/claude-brain/tests/install-hierarchy.test.sh
#
# assertion ID は per-file scope の名前空間 (LEARN#8a、新規 file のため衝突なし):
#   HIER-*    階層化 invariant (新 path 実体 / 旧 path shim / shim の lib source)
#   SHIM-*    旧 path shim の実行 parity (新 path と同 rc / 同 stdout + [DEPRECATED] stderr)
#   GATE-*    install-hooks.sh の Mode gate (block / --force override / 非 Mode A 環境)
#   PARITY-*  mode-detection SHARED LITERAL の install.sh ⇔ lib/install-common.sh 一致
#
# 検証項目:
#   - user 3 本 (install-hooks / -codex / -gemini) が scripts/install/user/ に実在
#   - internal 7 本が scripts/install/internal/ に実在
#   - 旧 path 10 本が shim として残り、[DEPRECATED] を stderr に出して新 path へ透過
#   - shim 経由と新 path 直接実行が同 rc / 同 stdout (非破壊 mode で比較)
#   - shim が lib/install-common.sh を source (security primitive の SSOT)
#   - Mode gate: Mode A 環境 (Claude Code 検出) で --force なし → exit 1 + banner、
#     --force ありで通過、非 Mode A 環境では gate 発火しない
#   - install.sh (curl 一行実行 fallback) と lib の SHARED LITERAL が 1 文字も違わない

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
TOOL_ROOT="${REPO_ROOT}/tools/claude-brain"
SCRIPTS_DIR="${TOOL_ROOT}/scripts"

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

# CLI 検出 sensor を確実に制御するための minimal PATH (install-oneliner.test.sh と同方式)
SANDBOX_PATH="/usr/bin:/bin"

# test 用 HOME / Vault
HOME_NONE="${TMPROOT}/home-none"     # .claude なし → has_claude_code false
HOME_CLAUDE="${TMPROOT}/home-claude" # .claude あり → has_claude_code true (Mode A 環境 mock)
VAULT="${TMPROOT}/vault"
mkdir -p "${HOME_NONE}" "${HOME_CLAUDE}/.claude" "${VAULT}"

USER_SCRIPTS="install-hooks.sh install-hooks-codex.sh install-hooks-gemini.sh"
INTERNAL_SCRIPTS="install-mcp-client.sh install-skills.sh install-cron.sh install-schedule.sh \
install-launchagents.sh install-qmd-daemon.sh install-competitor-watch.sh"

# -----------------------------------------------------------------------------
# HIER-1: 新 path 実体の存在 (user 3 + internal 7)
# -----------------------------------------------------------------------------
echo "test HIER-1: 新 path に実体が存在する"

missing=""
for s in ${USER_SCRIPTS}; do
  [[ -f "${SCRIPTS_DIR}/install/user/${s}" ]] || missing="${missing} user/${s}"
done
for s in ${INTERNAL_SCRIPTS}; do
  [[ -f "${SCRIPTS_DIR}/install/internal/${s}" ]] || missing="${missing} internal/${s}"
done
if [[ -z "${missing// }" ]]; then
  pass "HIER-1 user 3 本 + internal 7 本が新 path に存在"
else
  fail "HIER-1 新 path に無い script:${missing}"
fi

# -----------------------------------------------------------------------------
# HIER-2: 旧 path shim の存在 + 構造 (DEPRECATED echo / exec 透過 / lib source)
# -----------------------------------------------------------------------------
echo "test HIER-2: 旧 path shim の構造 invariant"

bad_shim=""
for s in ${USER_SCRIPTS} ${INTERNAL_SCRIPTS}; do
  shim="${SCRIPTS_DIR}/${s}"
  if [[ ! -f "${shim}" ]]; then
    bad_shim="${bad_shim} ${s}(missing)"
    continue
  fi
  grep -q -F -- '[DEPRECATED]' "${shim}" || bad_shim="${bad_shim} ${s}(no-deprecated)"
  grep -q -E 'exec bash "\$\{SHIM_DIR\}/install/(user|internal)/' "${shim}" || bad_shim="${bad_shim} ${s}(no-exec)"
  grep -q -F -- 'source "${SHIM_DIR}/lib/install-common.sh"' "${shim}" || bad_shim="${bad_shim} ${s}(no-lib-source)"
  bash -n "${shim}" || bad_shim="${bad_shim} ${s}(syntax)"
done
if [[ -z "${bad_shim// }" ]]; then
  pass "HIER-2 10 shim 全てが [DEPRECATED] echo + exec 透過 + lib source を持つ"
else
  fail "HIER-2 shim invariant 違反:${bad_shim}"
fi

# -----------------------------------------------------------------------------
# SHIM-*: 実行 parity — 旧 path shim 経由と新 path 直接で同 rc / 同 stdout。
# shim stderr にのみ [DEPRECATED] が付く。全 invocation は非破壊 mode
# (stdout 出力 or --dry-run) に限定し、HOME / OBSIDIAN_VAULT は temp に隔離。
#
# install-qmd-daemon.sh は launchctl を実操作する (dry-run なし) ため実行せず、
# HIER-2 の静的 invariant のみで cover する (実 Vault / 実 launchd 汚染禁止)。
# -----------------------------------------------------------------------------
echo "test SHIM-*: shim 経由と新 path 直接の実行 parity"

# strip_volatile: timestamp 系 (backup 名等) を正規化して flaky diff を防ぐ
strip_volatile() {
  sed -e 's/[0-9]\{8\}-[0-9]\{6\}/TIMESTAMP/g'
}

# run_parity <id> <subdir> <script> <env...> -- <args...>
run_parity() {
  local id="$1" subdir="$2" script="$3"
  shift 3
  local envs=()
  while [[ "$1" != "--" ]]; do
    envs+=("$1")
    shift
  done
  shift # drop --

  local new_out="${TMPROOT}/${id}-new.out" new_err="${TMPROOT}/${id}-new.err"
  local old_out="${TMPROOT}/${id}-old.out" old_err="${TMPROOT}/${id}-old.err"
  local new_rc=0 old_rc=0

  env "${envs[@]}" bash "${SCRIPTS_DIR}/install/${subdir}/${script}" "$@" \
    >"${new_out}" 2>"${new_err}" || new_rc=$?
  env "${envs[@]}" bash "${SCRIPTS_DIR}/${script}" "$@" \
    >"${old_out}" 2>"${old_err}" || old_rc=$?

  assert_eq "${new_rc}" "${old_rc}" "${id}a rc parity (new=${new_rc} old=${old_rc}) — ${script}"
  if diff -q <(strip_volatile <"${new_out}") <(strip_volatile <"${old_out}") >/dev/null; then
    pass "${id}b stdout parity — ${script}"
  else
    fail "${id}b stdout が shim 経由と新 path で異なる — ${script}"
  fi
  assert_contains "$(cat "${old_err}")" "[DEPRECATED] scripts/${script} moved to scripts/install/${subdir}/${script}" \
    "${id}c shim stderr に [DEPRECATED] + 移動先 path — ${script}"
  assert_not_contains "$(cat "${new_err}")" "[DEPRECATED]" \
    "${id}d 新 path 直接実行では [DEPRECATED] を出さない — ${script}"
}

# user 3 本: stdout snippet mode (非破壊)。install-hooks.sh は Mode gate を
# 発火させない env (HOME_NONE + sandbox PATH) で。
run_parity "SHIM-1" "user" "install-hooks.sh" \
  HOME="${HOME_NONE}" PATH="${SANDBOX_PATH}" OBSIDIAN_VAULT="${VAULT}" --
run_parity "SHIM-2" "user" "install-hooks-codex.sh" \
  HOME="${HOME_NONE}" PATH="${SANDBOX_PATH}" OBSIDIAN_VAULT="${VAULT}" --
run_parity "SHIM-3" "user" "install-hooks-gemini.sh" \
  HOME="${HOME_NONE}" PATH="${SANDBOX_PATH}" OBSIDIAN_VAULT="${VAULT}" --

# internal 6 本 (qmd-daemon 除く): --dry-run / stdout mode (非破壊)
run_parity "SHIM-4" "internal" "install-mcp-client.sh" \
  HOME="${HOME_NONE}" OBSIDIAN_VAULT="${VAULT}" -- --dry-run
run_parity "SHIM-5" "internal" "install-skills.sh" \
  HOME="${HOME_NONE}" -- --dry-run
run_parity "SHIM-6" "internal" "install-cron.sh" \
  HOME="${HOME_NONE}" OBSIDIAN_VAULT="${VAULT}" --
run_parity "SHIM-7" "internal" "install-schedule.sh" \
  HOME="${HOME_NONE}" OBSIDIAN_VAULT="${VAULT}" -- --dry-run
run_parity "SHIM-8" "internal" "install-launchagents.sh" \
  HOME="${HOME_NONE}" OBSIDIAN_VAULT="${VAULT}" -- --dry-run
run_parity "SHIM-9" "internal" "install-competitor-watch.sh" \
  HOME="${HOME_NONE}" OBSIDIAN_VAULT="${VAULT}" -- --dry-run

# SHIM-1 の代表 content assert: shim 経由でも snippet が壊れていない
shim_hooks_out="$(HOME="${HOME_NONE}" PATH="${SANDBOX_PATH}" OBSIDIAN_VAULT="${VAULT}" \
  bash "${SCRIPTS_DIR}/install-hooks.sh" 2>/dev/null)"
assert_contains "${shim_hooks_out}" '"SessionStart"' "SHIM-1e shim 経由の snippet に SessionStart event"

# -----------------------------------------------------------------------------
# GATE-*: install-hooks.sh の Mode gate
# -----------------------------------------------------------------------------
echo "test GATE-*: Mode gate (Mode A 環境で --force なしは exit 1)"

NEW_INSTALL_HOOKS="${SCRIPTS_DIR}/install/user/install-hooks.sh"

# GATE-1: Mode A 環境 (HOME に .claude) + --force なし → exit 1 + banner
rc=0
gate_err="$(HOME="${HOME_CLAUDE}" PATH="${SANDBOX_PATH}" OBSIDIAN_VAULT="${VAULT}" \
  bash "${NEW_INSTALL_HOOKS}" 2>&1 >/dev/null)" || rc=$?
assert_eq "1" "${rc}" "GATE-1a Mode A 環境 + --force なしは exit 1"
assert_contains "${gate_err}" "Mode A" "GATE-1b banner が Mode A 環境である旨を表示"
assert_contains "${gate_err}" "/plugin install kioku@megaphone-tokyo" "GATE-1c banner が /plugin install を推奨"
assert_contains "${gate_err}" "--force" "GATE-1d banner が --force override を案内"

# GATE-2: Mode A 環境 + --force → gate 通過、snippet が出る
rc=0
gate_out="$(HOME="${HOME_CLAUDE}" PATH="${SANDBOX_PATH}" OBSIDIAN_VAULT="${VAULT}" \
  bash "${NEW_INSTALL_HOOKS}" --force 2>/dev/null)" || rc=$?
assert_eq "0" "${rc}" "GATE-2a --force で gate を通過し exit 0"
assert_contains "${gate_out}" '"SessionStart"' "GATE-2b --force 時は snippet が出力される"

# GATE-3: 非 Mode A 環境 (claude 不検出) では --force なしでも gate は発火しない
rc=0
nogate_out="$(HOME="${HOME_NONE}" PATH="${SANDBOX_PATH}" OBSIDIAN_VAULT="${VAULT}" \
  bash "${NEW_INSTALL_HOOKS}" 2>/dev/null)" || rc=$?
assert_eq "0" "${rc}" "GATE-3a claude 不検出環境では gate 発火せず exit 0"
assert_contains "${nogate_out}" '"SessionStart"' "GATE-3b snippet が出力される"

# GATE-4: gate は OBSIDIAN_VAULT check より先 (Mode A 環境では vault 未設定でも banner)
rc=0
gate4_err="$(HOME="${HOME_CLAUDE}" PATH="${SANDBOX_PATH}" \
  bash "${NEW_INSTALL_HOOKS}" 2>&1 >/dev/null)" || rc=$?
assert_eq "1" "${rc}" "GATE-4a vault 未設定 + Mode A 環境も exit 1"
assert_contains "${gate4_err}" "/plugin install" "GATE-4b banner が先に出る (vault エラーではない)"
assert_not_contains "${gate4_err}" "OBSIDIAN_VAULT is not set" "GATE-4c OBSIDIAN_VAULT エラーより gate が先"

# GATE-5: --apply も gate 対象 (settings file は無傷)
GATE_SETTINGS="${TMPROOT}/gate-settings.json"
echo '{"hooks":{}}' > "${GATE_SETTINGS}"
orig_hash="$(shasum "${GATE_SETTINGS}" | awk '{print $1}')"
rc=0
HOME="${HOME_CLAUDE}" PATH="${SANDBOX_PATH}" OBSIDIAN_VAULT="${VAULT}" \
  CLAUDE_SETTINGS_FILE="${GATE_SETTINGS}" \
  bash "${NEW_INSTALL_HOOKS}" --apply --yes >/dev/null 2>&1 || rc=$?
assert_eq "1" "${rc}" "GATE-5a --apply も --force なしなら exit 1"
after_hash="$(shasum "${GATE_SETTINGS}" | awk '{print $1}')"
assert_eq "${orig_hash}" "${after_hash}" "GATE-5b block 時に settings file は無傷"

# GATE-6: shim 経由でも gate は同様に効く (旧 path 互換でも security 挙動は新版)
rc=0
HOME="${HOME_CLAUDE}" PATH="${SANDBOX_PATH}" OBSIDIAN_VAULT="${VAULT}" \
  bash "${SCRIPTS_DIR}/install-hooks.sh" >/dev/null 2>&1 || rc=$?
assert_eq "1" "${rc}" "GATE-6 shim 経由でも Mode gate が効く (exit 1)"

# -----------------------------------------------------------------------------
# PARITY-*: mode-detection SHARED LITERAL の一致
# (install.sh は curl 一行実行で lib に到達できないため fallback block を持つ。
#  S6-3 masking SSOT と同じ SHARED LITERAL 方式で drift を検出する)
# -----------------------------------------------------------------------------
echo "test PARITY-*: mode-detection SHARED LITERAL (install.sh ⇔ lib/install-common.sh)"

MARKER_BEGIN='=== BEGIN SHARED LITERAL (mode-detection SSOT) ==='
MARKER_END='=== END SHARED LITERAL (mode-detection SSOT) ==='

block_install="$(sed -n "/${MARKER_BEGIN}/,/${MARKER_END}/p" "${SCRIPTS_DIR}/install.sh")"
block_lib="$(sed -n "/${MARKER_BEGIN}/,/${MARKER_END}/p" "${SCRIPTS_DIR}/lib/install-common.sh")"

# PARITY-1: 両 block が空でない (marker 消失で diff が空同士 pass する事故を防ぐ)
if [[ -n "${block_install}" && -n "${block_lib}" ]]; then
  pass "PARITY-1 両 file に SHARED LITERAL block が存在"
else
  fail "PARITY-1 SHARED LITERAL block が欠落 (install.sh=$([[ -n "${block_install}" ]] && echo yes || echo no) lib=$([[ -n "${block_lib}" ]] && echo yes || echo no))"
fi

# PARITY-2: block 内に 5 関数が揃っている
missing_fn=""
for fn in has_claude_code has_codex has_gemini has_existing_hooks detect_recommended_mode; do
  printf '%s' "${block_lib}" | grep -q "^${fn}()" || missing_fn="${missing_fn} ${fn}"
done
if [[ -z "${missing_fn// }" ]]; then
  pass "PARITY-2 SHARED LITERAL に mode 判定 5 関数が揃っている"
else
  fail "PARITY-2 SHARED LITERAL に無い関数:${missing_fn}"
fi

# PARITY-3: 1 文字も違わない
if diff <(printf '%s\n' "${block_install}") <(printf '%s\n' "${block_lib}") >/dev/null; then
  pass "PARITY-3 install.sh fallback と lib の SHARED LITERAL が byte 一致"
else
  fail "PARITY-3 SHARED LITERAL が drift (diff あり) — 両方を同時に更新すること"
fi

# PARITY-4: install.sh 単体 (lib 不在の curl 相当) でも mode 判定が動く。
# script 全体を lib の無い temp dir に copy して --dry-run --mode=a を実行する。
CURL_SIM_DIR="${TMPROOT}/curl-sim"
mkdir -p "${CURL_SIM_DIR}"
cp "${SCRIPTS_DIR}/install.sh" "${CURL_SIM_DIR}/install.sh"
rc=0
curl_sim_out="$(HOME="${HOME_NONE}" PATH="${SANDBOX_PATH}" \
  bash "${CURL_SIM_DIR}/install.sh" --dry-run --mode=a 2>&1)" || rc=$?
assert_eq "0" "${rc}" "PARITY-4a lib 不在 (curl 一行実行相当) でも install.sh は exit 0"
assert_contains "${curl_sim_out}" "recommended mode:  a" "PARITY-4b fallback 定義で mode 判定が動く"

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
