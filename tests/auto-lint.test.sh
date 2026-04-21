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
# 機能 2.1 (R1: Unicode 不可視文字検出) — LINT_PROMPT への注入を検証
# -----------------------------------------------------------------------------
# 方針: auto-ingest の I1-I3 と同じく stub claude で -p 引数をキャプチャして
# LINT_PROMPT の文字列を検査する。DRY RUN ではプロンプト本文を出力しないため
# 実経路 (stub claude) でテストする。
# -----------------------------------------------------------------------------

CAPTURE_DIR_LINT="${TMPROOT}/capture-lint"
mkdir -p "${CAPTURE_DIR_LINT}"
CAPTURE_FILE_LINT="${CAPTURE_DIR_LINT}/last-prompt.txt"

STUB_CAPTURE_DIR_LINT="${TMPROOT}/stub-capture-bin-lint"
mkdir -p "${STUB_CAPTURE_DIR_LINT}"
cat > "${STUB_CAPTURE_DIR_LINT}/claude" <<STUB
#!/usr/bin/env bash
# Test stub for auto-lint: capture the -p prompt body to a file.
while [[ \$# -gt 0 ]]; do
  case "\$1" in
    -p)
      shift
      printf '%s' "\$1" > "${CAPTURE_FILE_LINT}"
      shift
      ;;
    *)
      shift
      ;;
  esac
done
exit 0
STUB
chmod +x "${STUB_CAPTURE_DIR_LINT}/claude"

# ---------------------------------------------------------------------------
# Test R1-1: wiki に ZWSP を含むページがあると LINT_PROMPT に findings が注入される
# ---------------------------------------------------------------------------
echo "test R1-1: ZWSP in wiki page is reported in LINT_PROMPT"
VAULT_R1A="$(make_vault vault-r1a)"
# ZWSP (U+200B) を含む wiki ページを作る
printf -- '---\ntitle: zwsp-page\nupdated: 2026-04-17\n---\n\nhello\xe2\x80\x8bworld\n' \
  > "${VAULT_R1A}/wiki/zwsp-page.md"
FAKE_HOME_R1A="${TMPROOT}/fake-home-r1a"
mkdir -p "${FAKE_HOME_R1A}"

rm -f "${CAPTURE_FILE_LINT}"
set +e
out_r1a="$(
  env -i \
    HOME="${FAKE_HOME_R1A}" \
    PATH="${STUB_CAPTURE_DIR_LINT}:/usr/bin:/bin:$(dirname "$(command -v node 2>/dev/null || echo /usr/bin/false)")" \
    OBSIDIAN_VAULT="${VAULT_R1A}" \
    bash "${AUTO_LINT}" 2>&1
)"
rc=$?
set -e
assert_eq "0" "${rc}" "R1-1 exit code 0"
if [[ ! -f "${CAPTURE_FILE_LINT}" ]]; then
  fail "R1-1 prompt capture created"
else
  pass "R1-1 prompt capture created"
  captured_r1a="$(cat "${CAPTURE_FILE_LINT}")"
  assert_contains "${captured_r1a}" "R1 pre-scan findings" "R1-1 prompt contains R1 pre-scan section"
  assert_contains "${captured_r1a}" "wiki/zwsp-page.md" "R1-1 findings include the offending page"
  assert_contains "${captured_r1a}" "lines 6" "R1-1 findings include the line number"
fi

# ---------------------------------------------------------------------------
# Test R1-2: RTLO を含むページが検出される
# ---------------------------------------------------------------------------
echo "test R1-2: RTLO (U+202E) is also detected"
VAULT_R1B="$(make_vault vault-r1b)"
# RTLO U+202E = 0xE2 0x80 0xAE
printf -- '---\ntitle: rtlo-page\n---\n\nnormal\xe2\x80\xaereversed\n' \
  > "${VAULT_R1B}/wiki/rtlo-page.md"
FAKE_HOME_R1B="${TMPROOT}/fake-home-r1b"
mkdir -p "${FAKE_HOME_R1B}"

rm -f "${CAPTURE_FILE_LINT}"
set +e
env -i \
  HOME="${FAKE_HOME_R1B}" \
  PATH="${STUB_CAPTURE_DIR_LINT}:/usr/bin:/bin:$(dirname "$(command -v node 2>/dev/null || echo /usr/bin/false)")" \
  OBSIDIAN_VAULT="${VAULT_R1B}" \
  bash "${AUTO_LINT}" >/dev/null 2>&1
rc=$?
set -e
assert_eq "0" "${rc}" "R1-2 exit code 0"
if [[ -f "${CAPTURE_FILE_LINT}" ]]; then
  captured_r1b="$(cat "${CAPTURE_FILE_LINT}")"
  assert_contains "${captured_r1b}" "wiki/rtlo-page.md" "R1-2 RTLO page flagged"
fi

# ---------------------------------------------------------------------------
# Test R1-2b (security review LOW-1): ファイル名にバッククォートが含まれていても
#            LINT_PROMPT の findings セクションが破壊されない (self-injection 対策)
# ---------------------------------------------------------------------------
echo "test R1-2b: backtick in filename is sanitized (self-injection defense)"
VAULT_R1D="$(make_vault vault-r1d)"
# Filename contains a backtick (rare but legal on macOS/Linux). Content has ZWSP.
# Writing via printf so the literal backtick ends up in the filename.
EVIL_NAME=$'evil`page.md'
printf -- '---\ntitle: evil\n---\n\nhi\xe2\x80\x8bthere\n' \
  > "${VAULT_R1D}/wiki/${EVIL_NAME}"
FAKE_HOME_R1D="${TMPROOT}/fake-home-r1d"
mkdir -p "${FAKE_HOME_R1D}"

rm -f "${CAPTURE_FILE_LINT}"
set +e
env -i \
  HOME="${FAKE_HOME_R1D}" \
  PATH="${STUB_CAPTURE_DIR_LINT}:/usr/bin:/bin:$(dirname "$(command -v node 2>/dev/null || echo /usr/bin/false)")" \
  OBSIDIAN_VAULT="${VAULT_R1D}" \
  bash "${AUTO_LINT}" >/dev/null 2>&1
rc=$?
set -e
assert_eq "0" "${rc}" "R1-2b exit code 0"
if [[ -f "${CAPTURE_FILE_LINT}" ]]; then
  captured_r1d="$(cat "${CAPTURE_FILE_LINT}")"
  # findings 行に生の backtick が含まれていないこと (サニタイズで ? に置換される)
  # → codefence ` wiki/evil`page.md ` を脱出できない
  if printf '%s' "${captured_r1d}" | grep -Fq 'wiki/evil`page.md'; then
    fail "R1-2b raw backtick in filename leaked to prompt"
  else
    pass "R1-2b backtick sanitized (not leaked as raw \`)"
  fi
  assert_contains "${captured_r1d}" "wiki/evil?page.md" "R1-2b sanitized filename present with ? replacement"
fi

# ---------------------------------------------------------------------------
# Test R1-3: 不可視文字なし → LINT_PROMPT に「該当なし」と書かれる
# ---------------------------------------------------------------------------
echo "test R1-3: no invisible chars -> prompt mentions '該当なし'"
VAULT_R1C="$(make_vault vault-r1c)"
add_wiki_page "${VAULT_R1C}" "clean-page"
FAKE_HOME_R1C="${TMPROOT}/fake-home-r1c"
mkdir -p "${FAKE_HOME_R1C}"

rm -f "${CAPTURE_FILE_LINT}"
set +e
env -i \
  HOME="${FAKE_HOME_R1C}" \
  PATH="${STUB_CAPTURE_DIR_LINT}:/usr/bin:/bin:$(dirname "$(command -v node 2>/dev/null || echo /usr/bin/false)")" \
  OBSIDIAN_VAULT="${VAULT_R1C}" \
  bash "${AUTO_LINT}" >/dev/null 2>&1
rc=$?
set -e
assert_eq "0" "${rc}" "R1-3 exit code 0"
if [[ -f "${CAPTURE_FILE_LINT}" ]]; then
  captured_r1c="$(cat "${CAPTURE_FILE_LINT}")"
  assert_contains "${captured_r1c}" "R1 pre-scan findings" "R1-3 prompt still has R1 section header"
  assert_contains "${captured_r1c}" "該当なし" "R1-3 prompt records '該当なし' when no findings"
fi

# -----------------------------------------------------------------------------
# G6 (v0.4.0 Tier A#2, 2026-04-21): detached HEAD ガード
# rebase 中断・detached checkout 状態で auto-lint が走ると、guard 無しでは
# git commit が detached HEAD 先端に積まれて push 失敗でローカル drift する。
# guard (git symbolic-ref -q HEAD) で git 書き込みを丸ごと skip + WARN することを検証。
# -----------------------------------------------------------------------------
echo "test G6: detached HEAD state -> skip git commit/push + WARN"
VAULT_G6="$(make_vault vault-g6)"
add_wiki_page "${VAULT_G6}" "page-g6"
(
  cd "${VAULT_G6}" && \
  git init --quiet && \
  git config user.email t@test && \
  git config user.name t && \
  echo 'session-logs/' > .gitignore && \
  git add .gitignore && \
  git commit -m init --quiet && \
  git checkout --detach --quiet
)
# auto-lint は lint-report.md を書くので、DRY RUN でない本走行時は wiki/ に
# 変更が出て `git add wiki/lint-report.md` が空でなくなる想定。
# guard が無ければ detached HEAD 先端に commit が積まれてしまう。
before_sha_g6="$(cd "${VAULT_G6}" && git rev-parse HEAD)"

set +e
out_g6="$(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_G6}" \
  bash "${AUTO_LINT}" 2>&1
)"
rc=$?
set -e

after_sha_g6="$(cd "${VAULT_G6}" && git rev-parse HEAD)"

assert_eq "0" "${rc}" "G6 exit 0 (non-destructive fail-safe)"
assert_contains "${out_g6}" "detached HEAD" "G6 stderr mentions detached HEAD"
assert_contains "${out_g6}" "Recovery:" "G6 stderr provides recovery hint"
assert_eq "${before_sha_g6}" "${after_sha_g6}" "G6 HEAD unchanged (guard prevented commit in detached state)"

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
