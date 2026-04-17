#!/usr/bin/env bash
#
# install-launchagents.test.sh — scripts/install-launchagents.sh のスモークテスト (Phase L)
#
# 実行: bash tools/claude-brain/tests/install-launchagents.test.sh
#
# 検証項目:
#   LA1 初回実行で 2 つの plist が作成される (ingest + lint)
#   LA2 2 回目実行で両方 [skip] になる (冪等)
#   LA3 plist 内にプレースホルダ (__FOO__) が残っていない
#   LA4 内容の異なる既存 plist が先にあると WARN + exit 2
#   LA5 --force で既存 plist を上書き
#   LA6 --dry-run で plist が作成されない
#   LA7 OBSIDIAN_VAULT 未設定 → exit 1
#   LA8 --uninstall で plist が削除される
#
# 実 $HOME/Library/LaunchAgents は絶対に触らない:
#   - CLAUDE_LAUNCHAGENTS_DIR を mktemp 先に差し替え
#   - KIOKU_SKIP_LOAD=1 で launchctl bootstrap/bootout をスキップ

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
INSTALL_SCRIPT="${REPO_ROOT}/tools/claude-brain/scripts/install-launchagents.sh"

TMPROOT="$(mktemp -d)"
trap 'rm -rf "${TMPROOT}"' EXIT

FAKE_VAULT="${TMPROOT}/fake-vault"
mkdir -p "${FAKE_VAULT}"

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

run_install() {
  local dest="$1"
  shift
  local out rc
  set +e
  out=$(
    CLAUDE_LAUNCHAGENTS_DIR="${dest}" \
    KIOKU_SKIP_LOAD=1 \
    OBSIDIAN_VAULT="${FAKE_VAULT}" \
    bash "${INSTALL_SCRIPT}" "$@" 2>&1
  )
  rc=$?
  set -e
  printf '%s\n' "${out}"
  return "${rc}"
}

# -----------------------------------------------------------------------------
# LA1 / LA2 / LA3: 初回作成 → 冪等再実行 → プレースホルダ残存チェック
# -----------------------------------------------------------------------------
echo "== LA1/LA2/LA3: create, idempotent, no unresolved placeholders =="

DEST1="${TMPROOT}/dest1"
out1=$(run_install "${DEST1}")
rc1=$?
assert_eq "0" "${rc1}" "LA1: first run exits 0"
assert_contains "${out1}" "[create]  com.kioku.ingest.plist" "LA1: ingest plist created"
assert_contains "${out1}" "[create]  com.kioku.lint.plist" "LA1: lint plist created"

INGEST_PLIST="${DEST1}/com.kioku.ingest.plist"
LINT_PLIST="${DEST1}/com.kioku.lint.plist"

if [[ -f "${INGEST_PLIST}" ]]; then
  pass "LA1: ingest plist file exists"
else
  fail "LA1: ingest plist file missing"
fi
if [[ -f "${LINT_PLIST}" ]]; then
  pass "LA1: lint plist file exists"
else
  fail "LA1: lint plist file missing"
fi

# LA3: プレースホルダが残っていないこと
if ! grep -q '__[A-Z_]*__' "${INGEST_PLIST}"; then
  pass "LA3: no placeholders in ingest plist"
else
  fail "LA3: placeholders still present in ingest plist"
fi
if ! grep -q '__[A-Z_]*__' "${LINT_PLIST}"; then
  pass "LA3: no placeholders in lint plist"
else
  fail "LA3: placeholders still present in lint plist"
fi

# Vault パスが正しく埋め込まれていること
if grep -q -F "${FAKE_VAULT}" "${INGEST_PLIST}"; then
  pass "LA3: OBSIDIAN_VAULT embedded in ingest plist"
else
  fail "LA3: OBSIDIAN_VAULT not found in ingest plist"
fi

# Label が正しいこと
if grep -q -F "<string>com.kioku.ingest</string>" "${INGEST_PLIST}"; then
  pass "LA3: Label correct in ingest plist"
else
  fail "LA3: Label incorrect in ingest plist"
fi

# LA2: 2 回目実行は skip
out2=$(run_install "${DEST1}")
rc2=$?
assert_eq "0" "${rc2}" "LA2: second run exits 0"
assert_contains "${out2}" "[skip]    com.kioku.ingest.plist" "LA2: ingest plist skipped"
assert_contains "${out2}" "[skip]    com.kioku.lint.plist" "LA2: lint plist skipped"

# -----------------------------------------------------------------------------
# LA4: 既存の異なる plist → WARN + exit 2
# -----------------------------------------------------------------------------
echo "== LA4: differing existing plist blocks install =="

DEST4="${TMPROOT}/dest4"
mkdir -p "${DEST4}"
echo "<!-- prior garbage -->" > "${DEST4}/com.kioku.ingest.plist"

set +e
out4=$(
  CLAUDE_LAUNCHAGENTS_DIR="${DEST4}" \
  KIOKU_SKIP_LOAD=1 \
  OBSIDIAN_VAULT="${FAKE_VAULT}" \
  bash "${INSTALL_SCRIPT}" 2>&1
)
rc4=$?
set -e

assert_eq "2" "${rc4}" "LA4: exit 2 when plist differs without --force"
assert_contains "${out4}" "[WARN]" "LA4: WARN printed"
assert_contains "${out4}" "--force" "LA4: --force hint included"

# 既存ファイルが温存されている (上書きされていない)
content4="$(cat "${DEST4}/com.kioku.ingest.plist")"
assert_eq "<!-- prior garbage -->" "${content4}" "LA4: existing file preserved"

# -----------------------------------------------------------------------------
# LA5: --force で上書き
# -----------------------------------------------------------------------------
echo "== LA5: --force overwrites differing plist =="

DEST5="${TMPROOT}/dest5"
mkdir -p "${DEST5}"
echo "old stuff" > "${DEST5}/com.kioku.ingest.plist"

out5=$(run_install "${DEST5}" --force)
rc5=$?
assert_eq "0" "${rc5}" "LA5: --force run exits 0"
assert_contains "${out5}" "[force]" "LA5: [force] marker printed"

# 中身が plist 形式に置き換わっていること
if grep -q -F "com.kioku.ingest" "${DEST5}/com.kioku.ingest.plist"; then
  pass "LA5: content replaced with real plist"
else
  fail "LA5: content not replaced"
fi

# -----------------------------------------------------------------------------
# LA6: --dry-run は何も書かない
# -----------------------------------------------------------------------------
echo "== LA6: --dry-run writes nothing =="

DEST6="${TMPROOT}/dest6-does-not-exist"
out6=$(run_install "${DEST6}" --dry-run)
rc6=$?
assert_eq "0" "${rc6}" "LA6: --dry-run exits 0"
assert_contains "${out6}" "DRY RUN" "LA6: DRY RUN marker printed"

if [[ ! -f "${DEST6}/com.kioku.ingest.plist" ]]; then
  pass "LA6: ingest plist not created on dry run"
else
  fail "LA6: ingest plist created on dry run"
fi
if [[ ! -f "${DEST6}/com.kioku.lint.plist" ]]; then
  pass "LA6: lint plist not created on dry run"
else
  fail "LA6: lint plist created on dry run"
fi

# -----------------------------------------------------------------------------
# LA7: OBSIDIAN_VAULT 未設定 → exit 1
# -----------------------------------------------------------------------------
echo "== LA7: missing OBSIDIAN_VAULT fails =="

DEST7="${TMPROOT}/dest7"
set +e
out7=$(
  env -i \
    HOME="${HOME}" \
    PATH="/usr/bin:/bin" \
    CLAUDE_LAUNCHAGENTS_DIR="${DEST7}" \
    KIOKU_SKIP_LOAD=1 \
    bash "${INSTALL_SCRIPT}" 2>&1
)
rc7=$?
set -e

assert_eq "1" "${rc7}" "LA7: exit 1 when OBSIDIAN_VAULT unset"
assert_contains "${out7}" "OBSIDIAN_VAULT" "LA7: error mentions OBSIDIAN_VAULT"

# -----------------------------------------------------------------------------
# LA8: --uninstall で plist 削除
# -----------------------------------------------------------------------------
echo "== LA8: --uninstall removes plists =="

DEST8="${TMPROOT}/dest8"
out8a=$(run_install "${DEST8}")
rc8a=$?
assert_eq "0" "${rc8a}" "LA8: install before uninstall exits 0"

if [[ -f "${DEST8}/com.kioku.ingest.plist" ]]; then
  pass "LA8: plist exists before uninstall"
else
  fail "LA8: plist missing before uninstall"
fi

out8b=$(run_install "${DEST8}" --uninstall)
rc8b=$?
assert_eq "0" "${rc8b}" "LA8: --uninstall exits 0"
assert_contains "${out8b}" "[removed]" "LA8: [removed] marker printed"

if [[ ! -f "${DEST8}/com.kioku.ingest.plist" ]]; then
  pass "LA8: ingest plist removed"
else
  fail "LA8: ingest plist still present after uninstall"
fi
if [[ ! -f "${DEST8}/com.kioku.lint.plist" ]]; then
  pass "LA8: lint plist removed"
else
  fail "LA8: lint plist still present after uninstall"
fi

# -----------------------------------------------------------------------------
echo
echo "install-launchagents tests: PASS=${PASS} FAIL=${FAIL}"
if [[ ${FAIL} -gt 0 ]]; then
  exit 1
fi
