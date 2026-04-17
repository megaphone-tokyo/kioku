#!/usr/bin/env bash
#
# auto-ingest.test.sh — scripts/auto-ingest.sh のスモークテスト
#
# 実行: bash tools/claude-brain/tests/auto-ingest.test.sh
#
# 検証項目 (Phase F.6 / F1〜F5):
#   F1 未処理ログ 0 件 → claude 呼ばず exit 0
#   F2 OBSIDIAN_VAULT が存在しない → exit 1
#   F3 claude コマンドが PATH にない → exit 1
#   F4 未処理ログあり + DRY RUN → claude を呼ぶ経路に到達する
#   F5 非 git vault → Ingest 処理自体は成功 (git は silently fail)
#
# Phase I (wiki/analyses/ 抽出) の追加ケース:
#   I1 INGEST_PROMPT に wiki/analyses/ への保存指示が含まれる
#   I2 INGEST_PROMPT に kebab-case ファイル名指示と汎用知見優先の指示が含まれる
#   I3 INGEST_PROMPT に「同名ページは更新 (重複禁止)」の指示が含まれる

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
AUTO_INGEST="${REPO_ROOT}/tools/claude-brain/scripts/auto-ingest.sh"

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
# stub claude バイナリ (F1, F4, F5 で使う)
# -----------------------------------------------------------------------------
STUB_DIR="${TMPROOT}/stub-bin"
mkdir -p "${STUB_DIR}"
cat > "${STUB_DIR}/claude" <<'STUB'
#!/usr/bin/env bash
# Test stub: record invocation args, never call real API
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

add_unprocessed_log() {
  local vault="$1"
  local name="$2"
  cat > "${vault}/session-logs/${name}.md" <<EOF
---
type: session-log
session_id: ${name}
ingested: false
---

body
EOF
}

# -----------------------------------------------------------------------------
# Test F2: OBSIDIAN_VAULT が存在しない → exit 1
# -----------------------------------------------------------------------------
echo "test F2: missing OBSIDIAN_VAULT -> exit 1"
set +e
(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${TMPROOT}/does-not-exist" \
  bash "${AUTO_INGEST}" >/dev/null 2>&1
)
rc=$?
set -e
assert_eq "1" "${rc}" "F2 exit code 1 when vault missing"

# -----------------------------------------------------------------------------
# Test F3: claude コマンドが PATH にない → exit 1
# -----------------------------------------------------------------------------
# fake HOME を指すことで、スクリプト内の PATH 補完 ($HOME/.local/bin 等) も
# 実在しないディレクトリになる。このマシンの /usr/local/bin, /opt/homebrew/bin
# には claude がインストールされていないことを前提とする (事前確認済み)。
echo "test F3: claude not in PATH -> exit 1"
VAULT_F3="$(make_vault vault-f3)"
FAKE_HOME_F3="${TMPROOT}/fake-home-f3"
mkdir -p "${FAKE_HOME_F3}"
set +e
out_f3="$(
  env -i \
    HOME="${FAKE_HOME_F3}" \
    PATH="/usr/bin:/bin" \
    OBSIDIAN_VAULT="${VAULT_F3}" \
    bash "${AUTO_INGEST}" 2>&1
)"
rc=$?
set -e
assert_eq "1" "${rc}" "F3 exit code 1 when claude missing"
assert_contains "${out_f3}" "claude command not found" "F3 error message present"

# -----------------------------------------------------------------------------
# Test F1: 未処理ログ 0 件 → claude 呼ばず exit 0
# -----------------------------------------------------------------------------
echo "test F1: no unprocessed logs -> skip"
VAULT_F1="$(make_vault vault-f1)"
# すでに取り込み済みのログ (ingested: true) だけ置く
cat > "${VAULT_F1}/session-logs/already-done.md" <<'EOF'
---
type: session-log
ingested: true
---
EOF
set +e
out_f1="$(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_F1}" \
  bash "${AUTO_INGEST}" 2>&1
)"
rc=$?
set -e
assert_eq "0" "${rc}" "F1 exit code 0 when nothing to ingest"
assert_contains "${out_f1}" "No unprocessed logs" "F1 skip message present"
# stub claude が呼ばれていないことを確認
if printf '%s' "${out_f1}" | grep -q "stub-claude called"; then
  fail "F1 claude stub should NOT be called"
else
  pass "F1 claude stub was not called"
fi

# -----------------------------------------------------------------------------
# Test F4: 未処理ログあり + DRY RUN → claude 呼び出し経路に到達
# -----------------------------------------------------------------------------
echo "test F4: unprocessed logs present + dry run -> reaches ingest call"
VAULT_F4="$(make_vault vault-f4)"
add_unprocessed_log "${VAULT_F4}" "20260415-100000-test-a"
add_unprocessed_log "${VAULT_F4}" "20260415-100100-test-b"
# git init しておくと git pull/push が silently fail するが処理は完走する
(cd "${VAULT_F4}" && git init --quiet && git -c user.email=t@test -c user.name=t commit --allow-empty -m init --quiet)

set +e
out_f4="$(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_F4}" \
  KIOKU_DRY_RUN=1 \
  bash "${AUTO_INGEST}" 2>&1
)"
rc=$?
set -e
assert_eq "0" "${rc}" "F4 exit code 0"
assert_contains "${out_f4}" "Found 2 unprocessed log" "F4 counted 2 logs"
assert_contains "${out_f4}" "DRY RUN: would call claude" "F4 reached ingest call (dry run)"
assert_contains "${out_f4}" "Done." "F4 completed"

# -----------------------------------------------------------------------------
# Test F5: 非 git vault → Ingest は成功、git 操作は silent fail
# -----------------------------------------------------------------------------
echo "test F5: non-git vault -> ingest succeeds, git silently fails"
VAULT_F5="$(make_vault vault-f5)"
add_unprocessed_log "${VAULT_F5}" "20260415-110000-test-c"

set +e
out_f5="$(
  PATH="${STUB_DIR}:${PATH}" \
  OBSIDIAN_VAULT="${VAULT_F5}" \
  KIOKU_DRY_RUN=1 \
  bash "${AUTO_INGEST}" 2>&1
)"
rc=$?
set -e
assert_eq "0" "${rc}" "F5 exit code 0 for non-git vault"
assert_contains "${out_f5}" "DRY RUN: would call claude" "F5 ingest path reached"
# git コマンドのエラー出力は 2>/dev/null で潰されているので目視できなくて良い

# -----------------------------------------------------------------------------
# Phase I: wiki/analyses/ 抽出指示が INGEST_PROMPT に含まれることを検証
#
# 方針:
#   claude を stub 化して、argv[2] (プロンプト本文) を一時ファイルに書き出す。
#   そのファイルを grep してプロンプト内容を検査する。
#   DRY RUN ではプロンプト本文を stdout に出さない設計なので、この方式を採る。
# -----------------------------------------------------------------------------
echo "test I1-I3: INGEST_PROMPT contains wiki/analyses/ extraction instructions"

CAPTURE_DIR="${TMPROOT}/capture"
mkdir -p "${CAPTURE_DIR}"
CAPTURE_FILE="${CAPTURE_DIR}/last-prompt.txt"

STUB_CAPTURE_DIR="${TMPROOT}/stub-capture-bin"
mkdir -p "${STUB_CAPTURE_DIR}"
cat > "${STUB_CAPTURE_DIR}/claude" <<STUB
#!/usr/bin/env bash
# Test stub: capture the -p prompt body to a file for inspection.
# argv is: -p <PROMPT> --allowedTools ... --max-turns ...
while [[ \$# -gt 0 ]]; do
  case "\$1" in
    -p)
      shift
      printf '%s' "\$1" > "${CAPTURE_FILE}"
      shift
      ;;
    *)
      shift
      ;;
  esac
done
exit 0
STUB
chmod +x "${STUB_CAPTURE_DIR}/claude"

VAULT_I="$(make_vault vault-i)"
add_unprocessed_log "${VAULT_I}" "20260415-120000-test-i"
(cd "${VAULT_I}" && git init --quiet && git -c user.email=t@test -c user.name=t commit --allow-empty -m init --quiet)

# auto-ingest.sh は PATH の先頭に $HOME/.volta/bin を追加するため、
# 素直に PATH=stub:... すると実マシンの claude に上書きされる可能性がある。
# fake HOME を使って Volta 等の実パスを存在しないディレクトリに追い出し、
# stub のみが見える状態を作る。
FAKE_HOME_I="${TMPROOT}/fake-home-i"
mkdir -p "${FAKE_HOME_I}"

set +e
out_i="$(
  env -i \
    HOME="${FAKE_HOME_I}" \
    PATH="${STUB_CAPTURE_DIR}:/usr/bin:/bin" \
    OBSIDIAN_VAULT="${VAULT_I}" \
    bash "${AUTO_INGEST}" 2>&1
)"
rc=$?
set -e
assert_eq "0" "${rc}" "I exit code 0"

if [[ ! -f "${CAPTURE_FILE}" ]]; then
  fail "I prompt capture file was created"
else
  pass "I prompt capture file was created"
  captured="$(cat "${CAPTURE_FILE}")"

  # I1: wiki/analyses/ への保存指示
  assert_contains "${captured}" "wiki/analyses/" "I1 prompt mentions wiki/analyses/"
  assert_contains "${captured}" "ページとして保存" "I1 prompt instructs to save as a page"

  # I2: kebab-case ファイル名 + 汎用知見優先
  assert_contains "${captured}" "kebab-case" "I2 prompt specifies kebab-case filename"
  assert_contains "${captured}" "汎用的" "I2 prompt prefers generic knowledge"

  # I3: 同名ページは更新 (重複禁止)
  assert_contains "${captured}" "既存ページを更新" "I3 prompt instructs to update existing page"
  assert_contains "${captured}" "重複" "I3 prompt forbids duplicates"
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
