#!/usr/bin/env bash
#
# install-skills.test.sh — scripts/install-skills.sh のスモークテスト
#
# 実行: bash tests/install-skills.test.sh
#
# 検証項目:
#   IS1 初回実行で wiki-ingest-all と wiki-ingest の 2 つの symlink が作成される
#   IS2 2 回目実行で両方とも [skip] になる (冪等)
#   IS3 symlink のリンク先が実際の repo skills/ を指している
#   IS4 非 symlink (通常ファイル) が先にあると WARN + exit 2 (--force なし)
#   IS5 --force で非 symlink を上書き
#   IS6 --dry-run で宛先が作成されない
#   IS7 宛先ディレクトリが存在しなくても自動作成される

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALL_SCRIPT="${REPO_ROOT}/scripts/install-skills.sh"
SKILLS_SRC="${REPO_ROOT}/skills"

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

run_install() {
  local dest="$1"
  shift
  local out rc
  set +e
  out=$(CLAUDE_SKILLS_DIR="${dest}" bash "${INSTALL_SCRIPT}" "$@" 2>&1)
  rc=$?
  set -e
  printf '%s\n' "${out}"
  return "${rc}"
}

# -----------------------------------------------------------------------------
# IS1 / IS2 / IS3: 初回作成 → 冪等再実行 → リンク先検証
# -----------------------------------------------------------------------------
echo "== IS1/IS2/IS3: create, idempotent, link target =="

DEST1="${TMPROOT}/dest1"
out1=$(run_install "${DEST1}")
rc1=$?
assert_eq "0" "${rc1}" "IS1: first run exits 0"
assert_contains "${out1}" "[create]  wiki-ingest-all" "IS1: wiki-ingest-all created"
assert_contains "${out1}" "[create]  wiki-ingest" "IS1: wiki-ingest created"

# symlink であること
if [[ -L "${DEST1}/wiki-ingest-all" ]]; then
  pass "IS1: wiki-ingest-all is a symlink"
else
  fail "IS1: wiki-ingest-all is not a symlink"
fi
if [[ -L "${DEST1}/wiki-ingest" ]]; then
  pass "IS1: wiki-ingest is a symlink"
else
  fail "IS1: wiki-ingest is not a symlink"
fi

# IS3: リンク先が repo skills/ を指している
target_all="$(readlink "${DEST1}/wiki-ingest-all")"
target_one="$(readlink "${DEST1}/wiki-ingest")"
assert_eq "${SKILLS_SRC}/wiki-ingest-all" "${target_all}" "IS3: wiki-ingest-all target matches repo"
assert_eq "${SKILLS_SRC}/wiki-ingest" "${target_one}" "IS3: wiki-ingest target matches repo"

# リンク先の SKILL.md が実際に読める
if [[ -f "${DEST1}/wiki-ingest-all/SKILL.md" ]]; then
  pass "IS3: SKILL.md reachable via wiki-ingest-all symlink"
else
  fail "IS3: SKILL.md not reachable via wiki-ingest-all symlink"
fi

# IS2: 2 回目実行は skip
out2=$(run_install "${DEST1}")
rc2=$?
assert_eq "0" "${rc2}" "IS2: second run exits 0"
assert_contains "${out2}" "[skip]    wiki-ingest-all" "IS2: wiki-ingest-all skipped on rerun"
assert_contains "${out2}" "[skip]    wiki-ingest" "IS2: wiki-ingest skipped on rerun"

# -----------------------------------------------------------------------------
# IS4: 非 symlink が先にあると WARN + exit 2
# -----------------------------------------------------------------------------
echo "== IS4: existing non-symlink file blocks install =="

DEST4="${TMPROOT}/dest4"
mkdir -p "${DEST4}"
# 既存の通常ファイルを配置
echo "prior content" > "${DEST4}/wiki-ingest-all"

set +e
out4=$(CLAUDE_SKILLS_DIR="${DEST4}" bash "${INSTALL_SCRIPT}" 2>&1)
rc4=$?
set -e

assert_eq "2" "${rc4}" "IS4: exit 2 when non-symlink exists without --force"
assert_contains "${out4}" "[WARN]" "IS4: WARN printed"
assert_contains "${out4}" "--force" "IS4: --force hint included"

# 既存ファイルが温存されている
if [[ -f "${DEST4}/wiki-ingest-all" ]] && ! [[ -L "${DEST4}/wiki-ingest-all" ]]; then
  content="$(cat "${DEST4}/wiki-ingest-all")"
  assert_eq "prior content" "${content}" "IS4: existing file preserved"
else
  fail "IS4: existing file was altered"
fi

# -----------------------------------------------------------------------------
# IS5: --force で上書き
# -----------------------------------------------------------------------------
echo "== IS5: --force overwrites non-symlink =="

DEST5="${TMPROOT}/dest5"
mkdir -p "${DEST5}"
echo "old stuff" > "${DEST5}/wiki-ingest-all"

out5=$(run_install "${DEST5}" --force)
rc5=$?
assert_eq "0" "${rc5}" "IS5: --force run exits 0"
assert_contains "${out5}" "[force]" "IS5: [force] marker printed"

if [[ -L "${DEST5}/wiki-ingest-all" ]]; then
  pass "IS5: wiki-ingest-all is now a symlink"
else
  fail "IS5: wiki-ingest-all is still a regular file"
fi

# -----------------------------------------------------------------------------
# IS6: --dry-run は宛先を作らない
# -----------------------------------------------------------------------------
echo "== IS6: --dry-run writes nothing =="

DEST6="${TMPROOT}/dest6-does-not-exist"
out6=$(run_install "${DEST6}" --dry-run)
rc6=$?
assert_eq "0" "${rc6}" "IS6: --dry-run exits 0"
assert_contains "${out6}" "DRY RUN" "IS6: DRY RUN marker printed"

if [[ ! -e "${DEST6}" ]]; then
  pass "IS6: destination not created on dry run"
else
  fail "IS6: destination was created on dry run"
fi

# -----------------------------------------------------------------------------
# IS7: 宛先ディレクトリが存在しない初期状態 → mkdir -p で作成
# -----------------------------------------------------------------------------
echo "== IS7: destination auto-created =="

DEST7="${TMPROOT}/nested/deeper/dest7"
out7=$(run_install "${DEST7}")
rc7=$?
assert_eq "0" "${rc7}" "IS7: run with nonexistent dest exits 0"

if [[ -d "${DEST7}" ]]; then
  pass "IS7: destination directory created"
else
  fail "IS7: destination directory not created"
fi

if [[ -L "${DEST7}/wiki-ingest-all" ]]; then
  pass "IS7: symlink created in new directory"
else
  fail "IS7: symlink not created in new directory"
fi

# -----------------------------------------------------------------------------
echo
echo "install-skills tests: PASS=${PASS} FAIL=${FAIL}"
if [[ ${FAIL} -gt 0 ]]; then
  exit 1
fi
