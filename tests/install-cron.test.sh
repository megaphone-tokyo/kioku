#!/usr/bin/env bash
#
# install-cron.test.sh — scripts/install/internal/install-cron.sh --apply 冪等化 (PR S6-2) のテスト
#
# 実行: bash tools/claude-brain/tests/install-cron.test.sh
#
# F-number は per-file scope (本ファイル新設のため F1 から採番、LEARN#8a)。
#
# mock crontab: PATH 先頭に fake crontab script を置き、実 user crontab には絶対に触れない。
# mock の state は ${TMPROOT}/crontab.state に保持する。
# MOCK_CRONTAB_FAIL_STDIN=1 で `crontab -` (stdin 書き戻し) だけを失敗させ、
# rollback (backup からの `crontab <file>` 復元) 経路を検証する。
#
# 検証項目:
#   F1  stdout mode (--apply なし): 従来の案内文を出力し、crontab を書き換えない (後方互換 100%)
#   F2  --apply 初回: crontab 未登録状態から ingest / lint entry + marker comment 各 1 行が登録される
#   F3  --apply 冪等性: 2 回実行しても entry / comment は各 1 行のまま (重複 entry を作らない)
#   F4  無関係の既存 entry は --apply 後も保持される
#   F5  同一 script path の stale entry (異なるスケジュール) は dedup され新 entry に置換される
#   F6  書き戻し失敗時: exit 1 + stderr に structured ERROR + crontab は元の内容のまま (rollback)
#   F7  不明な引数は exit 2 + usage
#
# 注意: macOS 標準 bash 3.2 でも動くよう mapfile / associative array を使わない。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
TOOL_ROOT="${REPO_ROOT}/tools/claude-brain"
SCRIPTS_DIR="${TOOL_ROOT}/scripts"
# S6-5: 本体は scripts/install/internal/ 配下 (旧 path は shim、install-hierarchy.test.sh が検証)
SCRIPT="${SCRIPTS_DIR}/install/internal/install-cron.sh"
AUTO_INGEST_ABS="${SCRIPTS_DIR}/auto-ingest.sh"
AUTO_LINT_ABS="${SCRIPTS_DIR}/auto-lint.sh"

TMPROOT="$(mktemp -d)"
trap 'rm -rf "${TMPROOT}"' EXIT

MOCK_BIN="${TMPROOT}/bin"
MOCK_TMPDIR="${TMPROOT}/tmp"
STATE="${TMPROOT}/crontab.state"
TEST_VAULT="${TMPROOT}/vault"
mkdir -p "${MOCK_BIN}" "${MOCK_TMPDIR}"

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
# mock crontab: 実 crontab には一切触れない。state file を crontab の代替にする。
#   crontab -l       → state を出力 (無ければ "no crontab" で exit 1、実 crontab 互換)
#   crontab -        → stdin を state に保存 (MOCK_CRONTAB_FAIL_STDIN=1 なら書かずに exit 1)
#   crontab <file>   → file を state に複製 (rollback の復元経路)
# -----------------------------------------------------------------------------
cat > "${MOCK_BIN}/crontab" <<'MOCK_EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE="${MOCK_CRONTAB_STATE:?MOCK_CRONTAB_STATE not set}"
case "${1:-}" in
  -l)
    if [[ -f "${STATE}" ]]; then
      cat "${STATE}"
    else
      echo "crontab: no crontab for $(whoami)" >&2
      exit 1
    fi
    ;;
  -)
    if [[ "${MOCK_CRONTAB_FAIL_STDIN:-0}" == "1" ]]; then
      echo "crontab: mock stdin write failure" >&2
      exit 1
    fi
    cat > "${STATE}"
    ;;
  "")
    echo "crontab: usage error (mock)" >&2
    exit 1
    ;;
  *)
    cp "$1" "${STATE}"
    ;;
esac
MOCK_EOF
chmod +x "${MOCK_BIN}/crontab"

# run_install_cron [args...] — mock crontab を PATH 先頭に置いて install-cron.sh を実行。
# stdout: ${TMPROOT}/stdout.txt / stderr: ${TMPROOT}/stderr.txt / 戻り値: exit code。
# TMPDIR を test 配下に差し替え、backup file も test 領域に閉じ込める。
run_install_cron() {
  local rc=0
  env PATH="${MOCK_BIN}:${PATH}" \
    MOCK_CRONTAB_STATE="${STATE}" \
    MOCK_CRONTAB_FAIL_STDIN="${MOCK_CRONTAB_FAIL_STDIN:-0}" \
    TMPDIR="${MOCK_TMPDIR}" \
    OBSIDIAN_VAULT="${TEST_VAULT}" \
    bash "${SCRIPT}" "$@" >"${TMPROOT}/stdout.txt" 2>"${TMPROOT}/stderr.txt" || rc=$?
  return "${rc}"
}

# state 内で pattern (fixed string) に一致する行数を数える (state 無しは 0)
count_in_state() {
  if [[ -f "${STATE}" ]]; then
    grep -cF -- "$1" "${STATE}" || true
  else
    echo 0
  fi
}

# -----------------------------------------------------------------------------
# F1: stdout mode (--apply なし) は従来出力 + crontab 不変 (後方互換 100%)
# -----------------------------------------------------------------------------
echo "test F1: stdout mode は非破壊 (後方互換)"

rm -f "${STATE}"
rc=0
run_install_cron || rc=$?
stdout_out="$(cat "${TMPROOT}/stdout.txt")"
assert_eq "0" "${rc}" "F1a --apply なしは exit 0"
assert_contains "${stdout_out}" "claude-brain 自動化 — cron 設定" "F1b 従来の案内 header を出力する"
assert_contains "${stdout_out}" "crontab -e" "F1c 手動追記の案内 (crontab -e) を出力する"
assert_contains "${stdout_out}" "0 7 * * * ${AUTO_INGEST_ABS}" "F1d ingest entry 行を出力する"
assert_contains "${stdout_out}" "0 8 1 * * ${AUTO_LINT_ABS}" "F1e lint entry 行を出力する"
if [[ -f "${STATE}" ]]; then
  fail "F1f stdout mode で crontab が書き換えられた (state file が生成された)"
else
  pass "F1f stdout mode では crontab を書き換えない"
fi

# -----------------------------------------------------------------------------
# F2: --apply 初回 (crontab 未登録) — 2 entry + 2 marker comment が各 1 行
# -----------------------------------------------------------------------------
echo "test F2: --apply 初回で entry が登録される"

rm -f "${STATE}"
rc=0
run_install_cron --apply || rc=$?
assert_eq "0" "${rc}" "F2a --apply 初回は exit 0"
assert_eq "1" "$(count_in_state "${AUTO_INGEST_ABS}")" "F2b ingest entry が 1 行"
assert_eq "1" "$(count_in_state "${AUTO_LINT_ABS}")" "F2c lint entry が 1 行"
assert_eq "1" "$(count_in_state "# claude-brain: 毎日朝7時に自動 Ingest")" "F2d ingest marker comment が 1 行"
assert_eq "1" "$(count_in_state "# claude-brain: 毎月1日 朝8時に自動 Lint")" "F2e lint marker comment が 1 行"
assert_eq "1" "$(count_in_state "0 7 * * * ${AUTO_INGEST_ABS} >> \"\$HOME/kioku-ingest.log\" 2>&1")" \
  "F2f ingest entry はスケジュール + log redirect 込みの期待形"

# -----------------------------------------------------------------------------
# F3: --apply 冪等性 — 2 回目の実行で重複 entry を作らない
# -----------------------------------------------------------------------------
echo "test F3: --apply 2 回実行の冪等性"

lines_after_first="$(wc -l < "${STATE}" | tr -d ' ')"
rc=0
run_install_cron --apply || rc=$?
assert_eq "0" "${rc}" "F3a --apply 2 回目も exit 0"
assert_eq "1" "$(count_in_state "${AUTO_INGEST_ABS}")" "F3b ingest entry は 1 行のまま (重複しない)"
assert_eq "1" "$(count_in_state "${AUTO_LINT_ABS}")" "F3c lint entry は 1 行のまま (重複しない)"
assert_eq "1" "$(count_in_state "# claude-brain: 毎日朝7時に自動 Ingest")" "F3d ingest marker も 1 行のまま"
assert_eq "1" "$(count_in_state "# claude-brain: 毎月1日 朝8時に自動 Lint")" "F3e lint marker も 1 行のまま"
lines_after_second="$(wc -l < "${STATE}" | tr -d ' ')"
assert_eq "${lines_after_first}" "${lines_after_second}" "F3f crontab 全体の行数が 2 回目で増えない"

# -----------------------------------------------------------------------------
# F4: 無関係の既存 entry は保持される
# -----------------------------------------------------------------------------
echo "test F4: 無関係 entry の保持"

cat > "${STATE}" <<EOF
# user's own entry
0 1 * * * /usr/local/bin/other-tool run
EOF
rc=0
run_install_cron --apply || rc=$?
assert_eq "0" "${rc}" "F4a 既存 entry ありでも exit 0"
assert_eq "1" "$(count_in_state "/usr/local/bin/other-tool run")" "F4b 無関係 entry が保持される"
assert_eq "1" "$(count_in_state "# user's own entry")" "F4c 無関係 comment も保持される"
assert_eq "1" "$(count_in_state "${AUTO_INGEST_ABS}")" "F4d ingest entry も追記される"
assert_eq "1" "$(count_in_state "${AUTO_LINT_ABS}")" "F4e lint entry も追記される"

# -----------------------------------------------------------------------------
# F5: 同一 script path の stale entry (別スケジュール) は dedup され置換される
# -----------------------------------------------------------------------------
echo "test F5: stale entry の dedup 置換"

cat > "${STATE}" <<EOF
30 6 * * * ${AUTO_INGEST_ABS} >> /tmp/old-ingest.log 2>&1
15 9 2 * * ${AUTO_LINT_ABS} >> /tmp/old-lint.log 2>&1
EOF
rc=0
run_install_cron --apply || rc=$?
assert_eq "0" "${rc}" "F5a stale entry ありでも exit 0"
assert_eq "1" "$(count_in_state "${AUTO_INGEST_ABS}")" "F5b ingest entry は置換後も 1 行のみ"
assert_eq "1" "$(count_in_state "${AUTO_LINT_ABS}")" "F5c lint entry は置換後も 1 行のみ"
assert_eq "0" "$(count_in_state "30 6 * * *")" "F5d 旧スケジュール (30 6) の stale 行は除去される"
assert_eq "0" "$(count_in_state "15 9 2 * *")" "F5e 旧スケジュール (15 9 2) の stale 行は除去される"
assert_eq "1" "$(count_in_state "0 7 * * * ${AUTO_INGEST_ABS}")" "F5f 新スケジュール (0 7) の entry が入る"

# -----------------------------------------------------------------------------
# F6: 書き戻し失敗時の rollback + structured error log
# -----------------------------------------------------------------------------
echo "test F6: crontab 書き戻し失敗時の rollback"

cat > "${STATE}" <<EOF
# pre-existing entry to be protected
5 5 * * * /usr/local/bin/protected-tool run
EOF
cp "${STATE}" "${TMPROOT}/state.before-failure"
rc=0
MOCK_CRONTAB_FAIL_STDIN=1 run_install_cron --apply || rc=$?
stderr_out="$(cat "${TMPROOT}/stderr.txt")"
assert_eq "1" "${rc}" "F6a 書き戻し失敗時は exit 1"
assert_contains "${stderr_out}" "ERROR: [install-cron] crontab write-back failed" \
  "F6b stderr に structured ERROR log (scope prefix + 失敗内容)"
if diff -q "${TMPROOT}/state.before-failure" "${STATE}" >/dev/null 2>&1; then
  pass "F6c crontab は失敗前の内容のまま (rollback / 非破壊)"
else
  fail "F6c crontab が失敗時に書き換わっている (rollback 不成立)"
fi
assert_eq "0" "$(count_in_state "${AUTO_INGEST_ABS}")" "F6d 失敗時に claude-brain entry は追加されない"

# -----------------------------------------------------------------------------
# F7: 不明な引数は exit 2 + usage
# -----------------------------------------------------------------------------
echo "test F7: 不明な引数の reject"

rc=0
run_install_cron --bogus || rc=$?
stderr_out="$(cat "${TMPROOT}/stderr.txt")"
assert_eq "2" "${rc}" "F7a 不明な引数は exit 2"
assert_contains "${stderr_out}" "unknown argument: --bogus" "F7b stderr に unknown argument エラー"
assert_contains "${stderr_out}" "usage:" "F7c stderr に usage を出す"

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
