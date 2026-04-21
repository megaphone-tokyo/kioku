#!/usr/bin/env bash
#
# sync-to-app.test.sh — v0.4.0 Tier B#3 GitHub-side lock (α) のテスト
#
# 実行: bash tools/claude-brain/tests/sync-to-app.test.sh
#
# ## 背景
#
# 2 台運用 (MacBook + Mac mini) で cron sync が近接時刻に起動すると、両方が
# 同じ内容で origin/next に push して重複 PR を生む race 条件がある (症状 #1)。
# α = GitHub-side lock: `gh api branches/next` で最終 push 時刻を確認し、閾値
# 以内なら早期 exit (scripts/sync-to-app.sh の check_github_side_lock)。
#
# 合意記録: plan/claude/26042104_meeting_v0-4-0-sync-to-app-race-fix.md
#           ## Resume session 2 — 2026-04-21
#
# ## 検証項目 (動的: 関数を抽出して直接呼ぶ)
#
#   SYN-R1  gh が now timestamp → 早期 exit (skip メッセージ付き)
#   SYN-R1b gh が old timestamp → return 0 (proceed, REACHED_END 到達)
#   SYN-R1c gh コマンド失敗 → return 0 (fail-open)
#   SYN-R5  DRY_RUN=1 → return 0 (dry-run で lock skip)
#   SYN-R6  KIOKU_SYNC_LOCK_MAX_AGE=0 → return 0 (env で無効化)
#
# ## 検証項目 (静的: script 本体の構造 regression 防止)
#
#   SYN-S1  check_github_side_lock() 関数が sync-to-app.sh に定義されている
#   SYN-S2  関数呼び出しが `git fetch origin` の直後 (fetch → checkout の間)
#   SYN-S3  既存 trap (.git-kioku restore) が破壊されていない
#   SYN-S4  KIOKU_SYNC_LOCK_MAX_AGE の env 参照と DRY_RUN チェックが存在
#
# ## 設計メモ
#
# 関数を subshell で呼ぶと、exit 0 は subshell 終了 / return 0 は続く echo 実行、
# で挙動差が観測できる (REACHED_END sentinel)。rsync / git scaffold を避ける
# ための軽量パターン。full-flow integration は 2 台実機 smoke に委譲。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
TOOL_ROOT="${REPO_ROOT}/tools/claude-brain"
TARGET="${TOOL_ROOT}/scripts/sync-to-app.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

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

# -----------------------------------------------------------------------------
# SYN-S1: 関数定義の存在確認 + extract
# -----------------------------------------------------------------------------
echo "test SYN-S1: check_github_side_lock() definition exists in sync-to-app.sh"

if [[ ! -f "${TARGET}" ]]; then
  fail "SYN-S1 sync-to-app.sh not found at ${TARGET}"
  echo "FATAL: cannot continue without target script" >&2
  exit 1
fi

# awk で関数定義 (最初の `}` まで) を取り出す。関数内に nested brace がない前提。
fn_def="$(awk '
  /^check_github_side_lock\(\) \{/ { flag=1 }
  flag { print }
  flag && /^}$/ { exit }
' "${TARGET}")"

if [[ -z "${fn_def}" ]]; then
  fail "SYN-S1 check_github_side_lock() definition not found in ${TARGET}"
  echo "FATAL: cannot continue without function definition" >&2
  exit 1
else
  pass "SYN-S1 function definition extracted ($(printf '%s' "${fn_def}" | wc -l | tr -d ' ') lines)"
fi

# test shell に関数を取り込み
eval "${fn_def}"

# -----------------------------------------------------------------------------
# SYN-S2: 関数呼び出しが git fetch 直後 (fetch → checkout の間) にある
# -----------------------------------------------------------------------------
echo "test SYN-S2: check_github_side_lock is invoked between fetch and checkout"

# `git fetch origin --quiet` 行の次にある (空行/コメントを挟んでも OK) 数行以内に
# `check_github_side_lock` があり、更にそれが `git checkout -B next origin/main`
# より前にあることを確認。
fetch_line="$(grep -n '^git fetch origin --quiet' "${TARGET}" | head -1 | cut -d: -f1)"
call_line="$(grep -n '^check_github_side_lock$' "${TARGET}" | head -1 | cut -d: -f1)"
checkout_line="$(grep -n 'git checkout -B next origin/main' "${TARGET}" | head -1 | cut -d: -f1)"

if [[ -z "${fetch_line}" ]]; then
  fail "SYN-S2 'git fetch origin --quiet' not found"
elif [[ -z "${call_line}" ]]; then
  fail "SYN-S2 'check_github_side_lock' call site not found"
elif [[ -z "${checkout_line}" ]]; then
  fail "SYN-S2 'git checkout -B next origin/main' not found"
elif (( call_line > fetch_line && call_line < checkout_line )); then
  pass "SYN-S2 call position ok (fetch@${fetch_line} < call@${call_line} < checkout@${checkout_line})"
else
  fail "SYN-S2 call position wrong (fetch@${fetch_line}, call@${call_line}, checkout@${checkout_line})"
fi

# -----------------------------------------------------------------------------
# SYN-S3: 既存 trap chain (.git-kioku restore) 非破壊
# -----------------------------------------------------------------------------
echo "test SYN-S3: existing trap for .git-kioku restore is preserved"

if grep -qE "trap .*mv \.git \.git-kioku.* EXIT INT TERM HUP" "${TARGET}"; then
  pass "SYN-S3 trap line for .git-kioku restore intact"
else
  fail "SYN-S3 trap for .git-kioku restore not found or malformed (regression?)"
fi

# -----------------------------------------------------------------------------
# SYN-S4: KIOKU_SYNC_LOCK_MAX_AGE env と DRY_RUN skip の参照が関数内に存在
# -----------------------------------------------------------------------------
echo "test SYN-S4: env-var hooks inside check_github_side_lock"

if printf '%s' "${fn_def}" | grep -qE 'KIOKU_SYNC_LOCK_MAX_AGE'; then
  pass "SYN-S4 KIOKU_SYNC_LOCK_MAX_AGE env reference present"
else
  fail "SYN-S4 KIOKU_SYNC_LOCK_MAX_AGE env reference missing"
fi

if printf '%s' "${fn_def}" | grep -qE 'DRY_RUN.*== .1.'; then
  pass "SYN-S4 DRY_RUN=1 skip branch present"
else
  fail "SYN-S4 DRY_RUN=1 skip branch missing"
fi

# -----------------------------------------------------------------------------
# 動的テスト用 gh stub 準備
# -----------------------------------------------------------------------------
# 同じ stub バイナリを 3 モード (now / old / fail) で使い分けるため、mode を
# ファイル (STUB_MODE_FILE) で動的に切替える。
STUB_MODE_FILE="${TMP}/gh-mode"
export STUB_MODE_FILE

mkdir -p "${TMP}/bin"
cat > "${TMP}/bin/gh" <<'STUB'
#!/usr/bin/env bash
# gh stub for sync-to-app.test.sh
# STUB_MODE_FILE で挙動選択 (now/old/fail)
mode="unset"
if [[ -n "${STUB_MODE_FILE:-}" && -f "${STUB_MODE_FILE}" ]]; then
  mode="$(cat "${STUB_MODE_FILE}")"
fi
case "${mode}" in
  now)
    # 現在 UTC ISO-8601 (lock が効く新鮮な push)
    date -u +%Y-%m-%dT%H:%M:%SZ
    ;;
  old)
    # 1 時間前 (閾値 120s より十分古い → proceed)
    # macOS (BSD) と Linux (GNU) 両方で動くよう両構文を試す
    if out="$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"; then
      echo "${out}"
    else
      date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ
    fi
    ;;
  fail)
    # gh auth 切れ / network error 相当
    exit 1
    ;;
  *)
    echo "gh stub: mode '${mode}' not set" >&2
    exit 1
    ;;
esac
STUB
chmod +x "${TMP}/bin/gh"

# PATH 先頭に stub を注入。real gh がシステムにあってもこちらが優先される。
export PATH="${TMP}/bin:${PATH}"

# -----------------------------------------------------------------------------
# 動的テストヘルパ: subshell で関数呼び出し、exit/return を REACHED_END で判定
# -----------------------------------------------------------------------------
# exit 0 → subshell 終了、REACHED_END 出ない
# return 0 → 続く echo 実行、REACHED_END 出る
# stdout/stderr は 2>&1 でマージして一括観測。
call_and_capture() {
  ( check_github_side_lock 2>&1; echo "REACHED_END" )
}

# -----------------------------------------------------------------------------
# SYN-R1: gh が now timestamp → 早期 exit (skip メッセージ)
# -----------------------------------------------------------------------------
echo "test SYN-R1: exits early when origin/next was just pushed"
echo "now" > "${STUB_MODE_FILE}"
unset DRY_RUN KIOKU_SYNC_LOCK_MAX_AGE
out="$(call_and_capture)"

if echo "${out}" | grep -q "REACHED_END"; then
  fail "SYN-R1 function returned instead of exiting (output: ${out})"
else
  pass "SYN-R1 function exited early (REACHED_END not emitted)"
fi

if echo "${out}" | grep -qF '[skip] origin/next was pushed'; then
  pass "SYN-R1 skip message emitted to stderr"
else
  fail "SYN-R1 skip message not found (output: ${out})"
fi

# -----------------------------------------------------------------------------
# SYN-R1b: gh が old timestamp → return 0 (proceed)
# -----------------------------------------------------------------------------
echo "test SYN-R1b: proceeds when origin/next push is stale (>threshold)"
echo "old" > "${STUB_MODE_FILE}"
unset DRY_RUN KIOKU_SYNC_LOCK_MAX_AGE
out="$(call_and_capture)"

if echo "${out}" | grep -q "REACHED_END"; then
  pass "SYN-R1b function returned (script would proceed to checkout)"
else
  fail "SYN-R1b function exited but was expected to proceed (output: ${out})"
fi

# -----------------------------------------------------------------------------
# SYN-R1c: gh が失敗 → fail-open (proceed)
# -----------------------------------------------------------------------------
echo "test SYN-R1c: fails open when gh returns non-zero (auth/network error)"
echo "fail" > "${STUB_MODE_FILE}"
unset DRY_RUN KIOKU_SYNC_LOCK_MAX_AGE
out="$(call_and_capture)"

if echo "${out}" | grep -q "REACHED_END"; then
  pass "SYN-R1c function fail-open succeeded (proceed despite gh error)"
else
  fail "SYN-R1c function exited when it should fail-open (output: ${out})"
fi

# -----------------------------------------------------------------------------
# SYN-R5: DRY_RUN=1 → 即 return 0 (gh を呼ばず)
# -----------------------------------------------------------------------------
echo "test SYN-R5: --dry-run skips lock check without calling gh"
# gh を "now" モードに設定: もし gh が呼ばれていたら SYN-R1 と同じ skip exit になる。
# REACHED_END が出れば DRY_RUN 分岐で早期 return できている証拠。
echo "now" > "${STUB_MODE_FILE}"
unset KIOKU_SYNC_LOCK_MAX_AGE
out="$(
  export DRY_RUN=1
  check_github_side_lock 2>&1
  echo "REACHED_END"
)"

if echo "${out}" | grep -q "REACHED_END"; then
  pass "SYN-R5 function returned early under DRY_RUN=1"
else
  fail "SYN-R5 function exited despite DRY_RUN=1 (output: ${out})"
fi

# -----------------------------------------------------------------------------
# SYN-R6: KIOKU_SYNC_LOCK_MAX_AGE=0 → guard 無効化 (proceed)
# -----------------------------------------------------------------------------
echo "test SYN-R6: KIOKU_SYNC_LOCK_MAX_AGE=0 disables the guard"
echo "now" > "${STUB_MODE_FILE}"
unset DRY_RUN
out="$(
  export KIOKU_SYNC_LOCK_MAX_AGE=0
  check_github_side_lock 2>&1
  echo "REACHED_END"
)"

if echo "${out}" | grep -q "REACHED_END"; then
  pass "SYN-R6 function returned early with KIOKU_SYNC_LOCK_MAX_AGE=0"
else
  fail "SYN-R6 function exited despite KIOKU_SYNC_LOCK_MAX_AGE=0 (output: ${out})"
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
