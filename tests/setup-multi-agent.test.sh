#!/usr/bin/env bash
#
# setup-multi-agent.test.sh — scripts/setup-multi-agent.sh のスモークテスト
#
# 実行: bash tools/claude-brain/tests/setup-multi-agent.test.sh
#
# Test cases (plan/claude/26042303 §Phase C Task C-1):
#   SMA-1: スクリプトが存在し、実行可能
#   SMA-2: skills/ が不在なら fatal error で exit 1
#   SMA-3: 初回実行で 3 agent (codex / opencode / gemini) に symlink 作成
#   SMA-4: 2 回目実行は全て [skip] (冪等性)
#   SMA-5: 既存非 symlink path は [WARN] でスキップ (破壊しない)
#   SMA-6: --uninstall で KIOKU が張った symlink のみ削除
#   SMA-7: --agent=codex で対象 filter が効く
#   SMA-8: --dry-run は実際に symlink を作らない
#
# 方針:
#   - HOME 環境変数は触らない。KIOKU_*_SKILLS_DIR env var で target dir を override
#   - mktemp -d で隔離、trap でクリーンアップ
#   - bats 非依存、自作 assert 関数のみ

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
SETUP_MULTI_AGENT="${REPO_ROOT}/tools/claude-brain/scripts/setup-multi-agent.sh"
SKILLS_SRC="${REPO_ROOT}/tools/claude-brain/skills"

if [[ ! -f "${SETUP_MULTI_AGENT}" ]]; then
  echo "FATAL: setup-multi-agent.sh not found at ${SETUP_MULTI_AGENT}" >&2
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

assert_symlink_to() {
  local link="$1"
  local expected_target="$2"
  local msg="$3"
  if [[ -L "${link}" ]]; then
    local actual
    actual="$(readlink "${link}")"
    if [[ "${actual}" == "${expected_target}" ]]; then
      pass "${msg}"
    else
      fail "${msg} (expected->${expected_target}, actual->${actual})"
    fi
  else
    fail "${msg} (not a symlink: ${link})"
  fi
}

assert_not_exists() {
  local path="$1"
  local msg="$2"
  if [[ ! -e "${path}" && ! -L "${path}" ]]; then
    pass "${msg}"
  else
    fail "${msg} (path still exists: ${path})"
  fi
}

assert_exit_code() {
  local expected="$1"
  local actual="$2"
  local msg="$3"
  if [[ "${expected}" -eq "${actual}" ]]; then
    pass "${msg}"
  else
    fail "${msg} (expected exit=${expected}, actual=${actual})"
  fi
}

# ヘルパー: 隔離された tmp agent skill root を作って script を呼ぶ
run_setup_multi_agent() {
  local codex_dir="$1"; shift
  local opencode_dir="$1"; shift
  local gemini_dir="$1"; shift
  KIOKU_CODEX_SKILLS_DIR="${codex_dir}" \
  KIOKU_OPENCODE_SKILLS_DIR="${opencode_dir}" \
  KIOKU_GEMINI_SKILLS_DIR="${gemini_dir}" \
  bash "${SETUP_MULTI_AGENT}" "$@"
}

# =========================================================================
# SMA-1: スクリプトが実行可能
# =========================================================================
echo "--- SMA-1: script exists and is syntactically valid ---"
bash -n "${SETUP_MULTI_AGENT}" && pass "bash -n syntax check" || fail "bash -n syntax check failed"

# =========================================================================
# SMA-3: 初回実行で 3 agent に symlink 作成
# =========================================================================
echo "--- SMA-3: initial install creates 3 symlinks ---"
T3="${TMPROOT}/sma3"
run_setup_multi_agent "${T3}/codex" "${T3}/opencode" "${T3}/gemini" > /dev/null
assert_symlink_to "${T3}/codex/kioku" "${SKILLS_SRC}" "codex symlink created"
assert_symlink_to "${T3}/opencode/kioku" "${SKILLS_SRC}" "opencode symlink created"
assert_symlink_to "${T3}/gemini/kioku" "${SKILLS_SRC}" "gemini symlink created"

# =========================================================================
# SMA-4: 2 回目実行は冪等 (全て [skip])
# =========================================================================
echo "--- SMA-4: second run is idempotent ---"
out_second=$(run_setup_multi_agent "${T3}/codex" "${T3}/opencode" "${T3}/gemini" 2>&1)
if echo "${out_second}" | grep -qE "created=0.*skipped=3"; then
  pass "second run: created=0 skipped=3"
else
  fail "second run not idempotent (got: $(echo "${out_second}" | grep "created="))"
fi

# =========================================================================
# SMA-5: 既存非 symlink path は [WARN] でスキップ
# =========================================================================
echo "--- SMA-5: existing non-symlink path is skipped with WARN ---"
T5="${TMPROOT}/sma5"
mkdir -p "${T5}/codex"
# 既存の通常ディレクトリを作る (symlink じゃない)
mkdir "${T5}/codex/kioku"
out5=$(run_setup_multi_agent "${T5}/codex" "${T5}/opencode" "${T5}/gemini" 2>&1 || true)
if echo "${out5}" | grep -q "WARN.*codex.*not a symlink"; then
  pass "non-symlink path triggers WARN"
else
  fail "non-symlink WARN not emitted (got: ${out5})"
fi
# 既存ディレクトリが破壊されていないこと
if [[ -d "${T5}/codex/kioku" && ! -L "${T5}/codex/kioku" ]]; then
  pass "existing directory not clobbered"
else
  fail "existing directory was clobbered"
fi

# =========================================================================
# SMA-6: --uninstall で KIOKU symlink のみ削除
# =========================================================================
echo "--- SMA-6: --uninstall removes only KIOKU-created symlinks ---"
T6="${TMPROOT}/sma6"
# install
run_setup_multi_agent "${T6}/codex" "${T6}/opencode" "${T6}/gemini" > /dev/null
# 別 target を指す symlink を手動で仕込む (KIOKU が作ったものではない)
mkdir -p "${T6}/other"
ln -sfn "${TMPROOT}" "${T6}/other/kioku"
# uninstall (--uninstall フラグ)
run_setup_multi_agent "${T6}/codex" "${T6}/opencode" "${T6}/gemini" --uninstall > /dev/null
# KIOKU symlinks は消えている
assert_not_exists "${T6}/codex/kioku" "uninstall: codex symlink removed"
assert_not_exists "${T6}/opencode/kioku" "uninstall: opencode symlink removed"
assert_not_exists "${T6}/gemini/kioku" "uninstall: gemini symlink removed"
# 関係ない symlink には触らない
if [[ -L "${T6}/other/kioku" ]]; then
  pass "uninstall: unrelated symlink not touched"
else
  fail "uninstall: unrelated symlink was deleted"
fi

# =========================================================================
# SMA-7: --agent=codex で filter が効く
# =========================================================================
echo "--- SMA-7: --agent filter limits target ---"
T7="${TMPROOT}/sma7"
run_setup_multi_agent "${T7}/codex" "${T7}/opencode" "${T7}/gemini" --agent=codex > /dev/null
assert_symlink_to "${T7}/codex/kioku" "${SKILLS_SRC}" "agent=codex: codex linked"
assert_not_exists "${T7}/opencode/kioku" "agent=codex: opencode NOT linked"
assert_not_exists "${T7}/gemini/kioku" "agent=codex: gemini NOT linked"

# =========================================================================
# SMA-8: --dry-run は実際には symlink を作らない
# =========================================================================
echo "--- SMA-8: --dry-run does not create symlinks ---"
T8="${TMPROOT}/sma8"
out8=$(run_setup_multi_agent "${T8}/codex" "${T8}/opencode" "${T8}/gemini" --dry-run 2>&1)
if echo "${out8}" | grep -q "DRY RUN"; then
  pass "dry-run: banner emitted"
else
  fail "dry-run: banner not emitted"
fi
assert_not_exists "${T8}/codex/kioku" "dry-run: no symlink created (codex)"
assert_not_exists "${T8}/opencode/kioku" "dry-run: no symlink created (opencode)"
assert_not_exists "${T8}/gemini/kioku" "dry-run: no symlink created (gemini)"

# =========================================================================
# SMA-2: skills/ 不在で fatal error (最後に実行、SKILLS_SRC を一時的に非表示化)
# =========================================================================
echo "--- SMA-2: missing skills/ src exits 1 ---"
# 別の repo-like tempdir を作って skills/ を置かずに script をコピー実行
T2="${TMPROOT}/sma2-repo"
mkdir -p "${T2}/tools/claude-brain/scripts"
cp "${SETUP_MULTI_AGENT}" "${T2}/tools/claude-brain/scripts/setup-multi-agent.sh"
set +e
(bash "${T2}/tools/claude-brain/scripts/setup-multi-agent.sh" > /dev/null 2>&1)
rc=$?
set -e
assert_exit_code 1 "${rc}" "skills/ missing: exit 1"

# =========================================================================
# Summary
# =========================================================================
echo
echo "===================="
echo "PASS=${PASS} FAIL=${FAIL}"
echo "===================="
if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
exit 0
