#!/usr/bin/env bash
#
# post-release-sync.test.sh — v0.4.0 post-release-sync.sh の静的検証
#
# 実行: bash tools/claude-brain/tests/post-release-sync.test.sh
#
# ## 背景
#
# post-release-sync.sh は sync-to-app.sh の後、kioku PR merge 後に呼んで
# app/ を kioku 最新 main state に揃える script。sync-to-app.test.sh と違い
# 関数化していない (main flow を直接書く形) ので、動的実行テストでなく
# 静的 grep 検証で regression 防止する。
#
# 動的 smoke: `bash post-release-sync.sh --dry-run` を運用で回すことで担保。
#
# ## 検証項目
#
#   PRS-S1  script が存在 + shebang + executable bit
#   PRS-S2  `set -euo pipefail` 宣言あり
#   PRS-S3  crash recovery guard (`.git` と `.git-kioku` 両存在で abort)
#   PRS-S4  EXIT/INT/TERM/HUP trap で `.git → .git-kioku` 復元
#   PRS-S5  flag 分岐 (`--commit` / `--dry-run` / `--help`) が存在
#   PRS-S6  bash -n syntax 健全
#   PRS-S7  kioku main 揃え手順 (`git fetch origin` / `git checkout main` /
#           `git merge --ff-only origin/main`) が揃う
#   PRS-S8  --commit mode で `git add` / `git commit` / `git push origin main`
#           分岐が存在
#   PRS-S9  --dry-run mode で副作用なし (mv / git 系を実行しない早期 exit)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
TARGET="${REPO_ROOT}/tools/claude-brain/scripts/post-release-sync.sh"

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
# PRS-S1: 存在 + shebang + executable
# -----------------------------------------------------------------------------
echo "test PRS-S1: script exists, has shebang, is executable"

if [[ -f "${TARGET}" ]]; then
  pass "PRS-S1 script file exists"
else
  fail "PRS-S1 script not found at ${TARGET}"
  echo "FATAL: cannot continue" >&2
  exit 1
fi

if head -1 "${TARGET}" | grep -qE '^#!/usr/bin/env bash'; then
  pass "PRS-S1 shebang (#!/usr/bin/env bash) present"
else
  fail "PRS-S1 shebang missing or incorrect"
fi

if [[ -x "${TARGET}" ]]; then
  pass "PRS-S1 executable bit set"
else
  fail "PRS-S1 executable bit missing (chmod +x needed)"
fi

# -----------------------------------------------------------------------------
# PRS-S2: set -euo pipefail
# -----------------------------------------------------------------------------
echo "test PRS-S2: set -euo pipefail declared"

if grep -qE '^set -euo pipefail' "${TARGET}"; then
  pass "PRS-S2 set -euo pipefail present"
else
  fail "PRS-S2 set -euo pipefail missing"
fi

# -----------------------------------------------------------------------------
# PRS-S3: crash recovery guard
# -----------------------------------------------------------------------------
echo "test PRS-S3: crash recovery guard (.git + .git-kioku 両存在 abort)"

if grep -qE 'if \[\[ -d \.git && -d \.git-kioku \]\]' "${TARGET}"; then
  pass "PRS-S3 guard condition present"
else
  fail "PRS-S3 guard condition missing"
fi

if grep -qF "Manual recovery required" "${TARGET}"; then
  pass "PRS-S3 guard error message present"
else
  fail "PRS-S3 guard error message missing"
fi

# -----------------------------------------------------------------------------
# PRS-S4: EXIT trap で .git-kioku restore
# -----------------------------------------------------------------------------
echo "test PRS-S4: EXIT/INT/TERM/HUP trap で .git → .git-kioku 復元"

if grep -qE "trap '.*mv \.git \.git-kioku" "${TARGET}"; then
  pass "PRS-S4 trap command for restore present"
else
  fail "PRS-S4 trap command missing or malformed"
fi

if grep -qE 'trap .* EXIT INT TERM HUP' "${TARGET}"; then
  pass "PRS-S4 trap signals cover EXIT INT TERM HUP"
else
  fail "PRS-S4 trap signals incomplete"
fi

# -----------------------------------------------------------------------------
# PRS-S5: flag 分岐 (--commit / --dry-run / --help)
# -----------------------------------------------------------------------------
echo "test PRS-S5: CLI flag branches"

for flag in '--commit' '--dry-run'; do
  if grep -qF -e "${flag})" "${TARGET}"; then
    pass "PRS-S5 flag ${flag} branch present"
  else
    fail "PRS-S5 flag ${flag} branch missing"
  fi
done

# --help は -h|--help の形式で OK (-F -e で flag 終了を明示)
if grep -qF -e '-h|--help' "${TARGET}" || grep -qF -e '--help|-h' "${TARGET}"; then
  pass "PRS-S5 flag --help branch present"
else
  fail "PRS-S5 flag --help branch missing"
fi

# -----------------------------------------------------------------------------
# PRS-S6: bash -n syntax
# -----------------------------------------------------------------------------
echo "test PRS-S6: bash -n syntax check"

if bash -n "${TARGET}" 2>/dev/null; then
  pass "PRS-S6 bash -n syntax OK"
else
  fail "PRS-S6 bash -n syntax error"
fi

# -----------------------------------------------------------------------------
# PRS-S7: kioku main 揃え手順 (fetch → checkout → ff-only merge)
# -----------------------------------------------------------------------------
echo "test PRS-S7: kioku main alignment sequence"

if grep -qE 'git fetch origin' "${TARGET}"; then
  pass "PRS-S7 git fetch origin present"
else
  fail "PRS-S7 git fetch origin missing"
fi

if grep -qE 'git checkout main' "${TARGET}"; then
  pass "PRS-S7 git checkout main present"
else
  fail "PRS-S7 git checkout main missing"
fi

if grep -qE 'git merge --ff-only origin/main' "${TARGET}"; then
  pass "PRS-S7 git merge --ff-only origin/main present"
else
  fail "PRS-S7 git merge --ff-only origin/main missing"
fi

# -----------------------------------------------------------------------------
# PRS-S8: --commit mode で git add / commit / push の分岐
# -----------------------------------------------------------------------------
echo "test PRS-S8: --commit mode auto-commit sequence"

# --commit mode 内に "git add tools/claude-brain/app/" / "git commit -m" /
# "git push origin main" があること
if grep -qE 'git add tools/claude-brain/app/' "${TARGET}"; then
  pass "PRS-S8 git add tools/claude-brain/app/ present"
else
  fail "PRS-S8 git add command missing"
fi

if grep -qE 'git commit -m .*post-release app/ snapshot sync' "${TARGET}"; then
  pass "PRS-S8 git commit with descriptive message present"
else
  fail "PRS-S8 git commit message missing or malformed"
fi

if grep -qE 'git push origin main' "${TARGET}"; then
  pass "PRS-S8 git push origin main present"
else
  fail "PRS-S8 git push command missing"
fi

# -----------------------------------------------------------------------------
# PRS-S9: --dry-run mode は早期 exit (副作用なし)
# -----------------------------------------------------------------------------
echo "test PRS-S9: --dry-run exits before side effects"

# dry-run セクション内で trap / mv / git fetch が起きていないことを確認
# (dry-run 分岐の exit 0 が先に走る)
awk '
  /MODE == "dry-run"/ { flag=1 }
  flag { print }
  flag && /^exit 0$/ { exit }
' "${TARGET}" > /tmp/prs-dryrun-block.$$.txt

if [[ -s /tmp/prs-dryrun-block.$$.txt ]]; then
  if grep -qE '^mv \.git-kioku \.git' /tmp/prs-dryrun-block.$$.txt; then
    fail "PRS-S9 dry-run block contains actual mv (should be echo only)"
  else
    pass "PRS-S9 dry-run block performs no actual mv"
  fi

  if grep -qE '^git fetch origin' /tmp/prs-dryrun-block.$$.txt; then
    fail "PRS-S9 dry-run block contains actual git fetch (should be echo only)"
  else
    pass "PRS-S9 dry-run block performs no actual git fetch"
  fi
fi
rm -f /tmp/prs-dryrun-block.$$.txt

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
