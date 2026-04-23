#!/usr/bin/env bash
#
# competitor-watch.test.sh — scripts/competitor-watch.sh + install-competitor-watch.sh のスモークテスト
#
# 26042304 meeting §3.5 決定 (競合 watch 仕組み) + アクションアイテム #4。
#
# 実行: bash tools/claude-brain/tests/competitor-watch.test.sh
#
# 検証項目:
#   CW-1 competitor-watch.sh が存在・実行可能・shebang + set -euo pipefail
#   CW-2 OBSIDIAN_VAULT 未設定 → exit 1 + helpful message
#   CW-3 competitors ディレクトリなし → exit 1
#   CW-4 KIOKU_DRY_RUN=1 で正しい frontmatter + ISO-week 形式が出る
#   CW-5 fake competitor dir (mock git repo) → レポートに名前が出現
#   ICW-1 install-competitor-watch.sh が存在・実行可能
#   ICW-2 --uninstall without installed → success (idempotent)
#   ICW-3 OBSIDIAN_VAULT 未設定 (install 時) → exit 1
#   ICW-4 invalid OBSIDIAN_VAULT (shell metacharacters) → exit 1
#   ICW-5 --dry-run でレンダリングされた plist が stdout に出る
#   ICW-6 install → 再 install で [same] 表示 (冪等)
#   ICW-7 --force で差分 plist を上書き
#   ICW-8 --uninstall で plist が削除される
#
# 実 $HOME/Library/LaunchAgents は絶対に触らない:
#   - CLAUDE_LAUNCHAGENTS_DIR を mktemp 先に差し替え
#   - KIOKU_SKIP_LOAD=1 で launchctl bootstrap/bootout をスキップ

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
WATCH_SCRIPT="${REPO_ROOT}/tools/claude-brain/scripts/competitor-watch.sh"
INSTALL_SCRIPT="${REPO_ROOT}/tools/claude-brain/scripts/install-competitor-watch.sh"

TMPROOT="$(mktemp -d)"
trap 'rm -rf "${TMPROOT}"' EXIT

FAKE_VAULT="${TMPROOT}/fake-vault"
FAKE_COMPETITORS="${TMPROOT}/fake-competitors"
FAKE_LA_DIR="${TMPROOT}/fake-LaunchAgents"
mkdir -p "${FAKE_VAULT}" "${FAKE_COMPETITORS}" "${FAKE_LA_DIR}"

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "  ok  $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  NG  $1" >&2; }

# -----------------------------------------------------------------------------
# CW-1: script が存在・実行可能・shebang + set -euo pipefail
# -----------------------------------------------------------------------------

echo "test CW-1: competitor-watch.sh integrity"
if [[ -x "${WATCH_SCRIPT}" ]]; then
  pass "CW-1 is executable"
else
  fail "CW-1 not executable"
fi
if head -1 "${WATCH_SCRIPT}" | grep -q '#!/usr/bin/env bash'; then
  pass "CW-1 has shebang"
else
  fail "CW-1 shebang missing"
fi
if grep -q 'set -euo pipefail' "${WATCH_SCRIPT}"; then
  pass "CW-1 has set -euo pipefail"
else
  fail "CW-1 set -euo pipefail missing"
fi

# -----------------------------------------------------------------------------
# CW-2: OBSIDIAN_VAULT 未設定 → exit 1
# -----------------------------------------------------------------------------

echo "test CW-2: OBSIDIAN_VAULT 未設定 → exit 1"
if out="$(env -i HOME="${HOME}" PATH="${PATH}" bash "${WATCH_SCRIPT}" 2>&1)"; then
  fail "CW-2 expected failure but succeeded"
else
  rc=$?
  if [[ "${rc}" == "1" ]]; then
    pass "CW-2 exits 1"
  else
    fail "CW-2 exit code ${rc} expected 1"
  fi
  if echo "${out}" | grep -qi 'obsidian_vault'; then
    pass "CW-2 error mentions OBSIDIAN_VAULT"
  else
    fail "CW-2 error message unhelpful: ${out}"
  fi
fi

# -----------------------------------------------------------------------------
# CW-3: competitors ディレクトリなし → exit 1
# -----------------------------------------------------------------------------

echo "test CW-3: competitors directory not found → exit 1"
if OBSIDIAN_VAULT="${FAKE_VAULT}" KIOKU_COMPETITOR_DIR="${TMPROOT}/nonexistent" \
    bash "${WATCH_SCRIPT}" >/dev/null 2>&1; then
  fail "CW-3 expected failure but succeeded"
else
  rc=$?
  if [[ "${rc}" == "1" ]]; then
    pass "CW-3 exits 1 on missing competitors dir"
  else
    fail "CW-3 exit code ${rc} expected 1"
  fi
fi

# -----------------------------------------------------------------------------
# CW-4: KIOKU_DRY_RUN=1 で frontmatter が stdout に出る
# -----------------------------------------------------------------------------

echo "test CW-4: KIOKU_DRY_RUN=1 outputs valid frontmatter"
out="$(OBSIDIAN_VAULT="${FAKE_VAULT}" KIOKU_DRY_RUN=1 \
  KIOKU_COMPETITOR_DIR="${FAKE_COMPETITORS}" \
  bash "${WATCH_SCRIPT}" 2>&1)"

if echo "${out}" | head -1 | grep -q '^---$'; then
  pass "CW-4 frontmatter opens with ---"
else
  fail "CW-4 no frontmatter opener"
fi
if echo "${out}" | grep -q 'type: competitor-watch'; then
  pass "CW-4 frontmatter has type: competitor-watch"
else
  fail "CW-4 missing type frontmatter"
fi
if echo "${out}" | grep -qE 'iso_week: [0-9]{4}-W[0-9]{2}'; then
  pass "CW-4 iso_week format valid"
else
  fail "CW-4 iso_week format invalid"
fi

# -----------------------------------------------------------------------------
# CW-5: fake competitor dir (mock git) → レポートに name が出現
# -----------------------------------------------------------------------------

echo "test CW-5: fake competitor with mock git"
MOCK_COMP="${FAKE_COMPETITORS}/mock-competitor"
mkdir -p "${MOCK_COMP}"
(
  cd "${MOCK_COMP}"
  git init --quiet
  git -c user.email=t@t -c user.name=t commit --allow-empty -m "initial" --quiet
)

out="$(OBSIDIAN_VAULT="${FAKE_VAULT}" KIOKU_DRY_RUN=1 \
  KIOKU_COMPETITOR_DIR="${FAKE_COMPETITORS}" \
  bash "${WATCH_SCRIPT}" 2>&1)"

if echo "${out}" | grep -q '## mock-competitor'; then
  pass "CW-5 mock-competitor listed in report"
else
  fail "CW-5 mock-competitor missing from report: ${out:0:200}"
fi
if echo "${out}" | grep -q 'File count summary'; then
  pass "CW-5 report includes File count summary"
else
  fail "CW-5 report missing File count summary"
fi

# -----------------------------------------------------------------------------
# ICW-1: install-competitor-watch.sh integrity
# -----------------------------------------------------------------------------

echo "test ICW-1: install-competitor-watch.sh integrity"
if [[ -x "${INSTALL_SCRIPT}" ]]; then
  pass "ICW-1 is executable"
else
  fail "ICW-1 not executable"
fi
if head -1 "${INSTALL_SCRIPT}" | grep -q '#!/usr/bin/env bash'; then
  pass "ICW-1 has shebang"
else
  fail "ICW-1 shebang missing"
fi
if grep -q 'set -euo pipefail' "${INSTALL_SCRIPT}"; then
  pass "ICW-1 has set -euo pipefail"
else
  fail "ICW-1 set -euo pipefail missing"
fi

# -----------------------------------------------------------------------------
# ICW-2: --uninstall (not installed) → exit 0 (idempotent)
# -----------------------------------------------------------------------------

echo "test ICW-2: --uninstall on fresh state → exit 0"
if CLAUDE_LAUNCHAGENTS_DIR="${FAKE_LA_DIR}" KIOKU_SKIP_LOAD=1 \
    bash "${INSTALL_SCRIPT}" --uninstall >/dev/null 2>&1; then
  pass "ICW-2 uninstall idempotent on fresh state"
else
  fail "ICW-2 uninstall failed on fresh state"
fi

# -----------------------------------------------------------------------------
# ICW-3: OBSIDIAN_VAULT 未設定 (install) → exit 1
# -----------------------------------------------------------------------------

echo "test ICW-3: OBSIDIAN_VAULT 未設定 (install) → exit 1"
if env -i HOME="${HOME}" PATH="${PATH}" CLAUDE_LAUNCHAGENTS_DIR="${FAKE_LA_DIR}" \
    KIOKU_SKIP_LOAD=1 bash "${INSTALL_SCRIPT}" --dry-run >/dev/null 2>&1; then
  fail "ICW-3 expected failure but succeeded"
else
  rc=$?
  if [[ "${rc}" == "1" ]]; then
    pass "ICW-3 exits 1 without OBSIDIAN_VAULT"
  else
    fail "ICW-3 exit code ${rc} expected 1"
  fi
fi

# -----------------------------------------------------------------------------
# ICW-4: invalid OBSIDIAN_VAULT (shell metacharacters) → exit 1
# -----------------------------------------------------------------------------

echo "test ICW-4: invalid OBSIDIAN_VAULT (shell metacharacters) → exit 1"
if OBSIDIAN_VAULT='/tmp/vault;whoami' \
    CLAUDE_LAUNCHAGENTS_DIR="${FAKE_LA_DIR}" KIOKU_SKIP_LOAD=1 \
    bash "${INSTALL_SCRIPT}" --dry-run >/dev/null 2>&1; then
  fail "ICW-4 expected failure but succeeded on ';'"
else
  pass "ICW-4 rejects ';' in OBSIDIAN_VAULT"
fi

if OBSIDIAN_VAULT='/tmp/vault$(whoami)' \
    CLAUDE_LAUNCHAGENTS_DIR="${FAKE_LA_DIR}" KIOKU_SKIP_LOAD=1 \
    bash "${INSTALL_SCRIPT}" --dry-run >/dev/null 2>&1; then
  fail "ICW-4 expected failure but succeeded on '\$()'"
else
  pass "ICW-4 rejects command substitution in OBSIDIAN_VAULT"
fi

# -----------------------------------------------------------------------------
# ICW-5: --dry-run で plist が stdout に出る、書き込みなし
# -----------------------------------------------------------------------------

echo "test ICW-5: --dry-run outputs rendered plist"
out="$(OBSIDIAN_VAULT="${FAKE_VAULT}" \
  CLAUDE_LAUNCHAGENTS_DIR="${FAKE_LA_DIR}" KIOKU_SKIP_LOAD=1 \
  bash "${INSTALL_SCRIPT}" --dry-run 2>&1)"

if echo "${out}" | grep -q '<key>Label</key>'; then
  pass "ICW-5 rendered plist contains <key>Label</key>"
else
  fail "ICW-5 rendered plist missing Label"
fi
if echo "${out}" | grep -q '<string>com.kioku.competitor-watch</string>'; then
  pass "ICW-5 rendered plist contains correct Label value"
else
  fail "ICW-5 rendered plist has wrong Label"
fi
# プレースホルダ残留チェック
if echo "${out}" | grep -qE '__[A-Z_]+__'; then
  fail "ICW-5 placeholder still present in rendered plist"
else
  pass "ICW-5 all placeholders substituted"
fi
# 書き込みなしチェック
if [[ ! -f "${FAKE_LA_DIR}/com.kioku.competitor-watch.plist" ]]; then
  pass "ICW-5 dry-run wrote no file"
else
  fail "ICW-5 dry-run unexpectedly wrote plist"
fi

# -----------------------------------------------------------------------------
# ICW-6: install → 再 install で [same] 表示 (冪等)
# -----------------------------------------------------------------------------

echo "test ICW-6: install twice is idempotent"
OBSIDIAN_VAULT="${FAKE_VAULT}" \
  CLAUDE_LAUNCHAGENTS_DIR="${FAKE_LA_DIR}" KIOKU_SKIP_LOAD=1 \
  bash "${INSTALL_SCRIPT}" >/dev/null 2>&1

out2="$(OBSIDIAN_VAULT="${FAKE_VAULT}" \
  CLAUDE_LAUNCHAGENTS_DIR="${FAKE_LA_DIR}" KIOKU_SKIP_LOAD=1 \
  bash "${INSTALL_SCRIPT}" 2>&1)"

if echo "${out2}" | grep -q '\[same\]'; then
  pass "ICW-6 second install shows [same]"
else
  fail "ICW-6 second install did not show [same]: ${out2:0:200}"
fi

# -----------------------------------------------------------------------------
# ICW-7: --force で差分 plist を上書き
# -----------------------------------------------------------------------------

echo "test ICW-7: --force overwrites differing plist"
# 既存 plist を書き換えて差分を作る
echo '<?xml version="1.0"?><plist><dict><key>stale</key><true/></dict></plist>' \
  > "${FAKE_LA_DIR}/com.kioku.competitor-watch.plist"

# --force なしは exit 2
if OBSIDIAN_VAULT="${FAKE_VAULT}" \
    CLAUDE_LAUNCHAGENTS_DIR="${FAKE_LA_DIR}" KIOKU_SKIP_LOAD=1 \
    bash "${INSTALL_SCRIPT}" >/dev/null 2>&1; then
  fail "ICW-7 expected exit 2 without --force"
else
  rc=$?
  if [[ "${rc}" == "2" ]]; then
    pass "ICW-7 exits 2 on diff without --force"
  else
    fail "ICW-7 exit ${rc} expected 2"
  fi
fi

# --force で上書き成功
if OBSIDIAN_VAULT="${FAKE_VAULT}" \
    CLAUDE_LAUNCHAGENTS_DIR="${FAKE_LA_DIR}" KIOKU_SKIP_LOAD=1 \
    bash "${INSTALL_SCRIPT}" --force >/dev/null 2>&1; then
  pass "ICW-7 --force succeeds"
else
  fail "ICW-7 --force unexpectedly failed"
fi

if grep -q 'com.kioku.competitor-watch' "${FAKE_LA_DIR}/com.kioku.competitor-watch.plist"; then
  pass "ICW-7 plist content now contains correct Label"
else
  fail "ICW-7 plist content did not update"
fi

# -----------------------------------------------------------------------------
# ICW-8: --uninstall で plist が削除される
# -----------------------------------------------------------------------------

echo "test ICW-8: --uninstall removes plist"
if OBSIDIAN_VAULT="${FAKE_VAULT}" \
    CLAUDE_LAUNCHAGENTS_DIR="${FAKE_LA_DIR}" KIOKU_SKIP_LOAD=1 \
    bash "${INSTALL_SCRIPT}" --uninstall >/dev/null 2>&1; then
  if [[ ! -f "${FAKE_LA_DIR}/com.kioku.competitor-watch.plist" ]]; then
    pass "ICW-8 plist removed after --uninstall"
  else
    fail "ICW-8 plist still present after --uninstall"
  fi
else
  fail "ICW-8 --uninstall failed"
fi

# -----------------------------------------------------------------------------
# サマリ
# -----------------------------------------------------------------------------

echo ""
echo "==========================="
echo "  passed: ${PASS}"
echo "  failed: ${FAIL}"
echo "==========================="

if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
