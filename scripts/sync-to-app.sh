#!/usr/bin/env bash
#
# sync-to-app.sh — 親リポの変更を app/ (kioku 公開リポ) に同期する
#
# 親リポの hooks/, scripts/, templates/, skills/, tests/, SECURITY*.md, LICENSE を
# app/ にコピーし、kioku リポの next ブランチにコミット・push する。
# main への反映は手動で PR またはマージを行う。
#
# Usage:
#   bash tools/claude-brain/scripts/sync-to-app.sh           # 同期 + commit + push
#   bash tools/claude-brain/scripts/sync-to-app.sh --dry-run  # 差分確認のみ
#
# 前提:
#   - app/.git-kioku が存在すること (kioku リポの .git)
#   - kioku リポに next ブランチが存在すること (初回は自動作成)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRAIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP_DIR="${BRAIN_DIR}/app"
REPO_ROOT="$(cd "${BRAIN_DIR}/../.." && pwd)"

DRY_RUN=0
for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
  esac
done

# -----------------------------------------------------------------------------
# 前提チェック
# -----------------------------------------------------------------------------

if [[ ! -d "${APP_DIR}/.git-kioku" ]]; then
  echo "ERROR: app/.git-kioku not found. Is kioku repo initialized?" >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# ファイル同期
# -----------------------------------------------------------------------------

echo "=== sync-to-app: copying from parent to app/ ==="

# 同期対象ディレクトリ
# mcp/ は Phase M で追加された独立 npm プロジェクト。node_modules/ はユーザーが
# `bash scripts/setup-mcp.sh` で導入するため、rsync 側でも除外する。
for dir in hooks scripts templates skills tests mcp; do
  if [[ -d "${BRAIN_DIR}/${dir}" ]]; then
    rsync -a --delete \
      --exclude='.git*' \
      --exclude='node_modules' \
      "${BRAIN_DIR}/${dir}/" "${APP_DIR}/${dir}/"
    echo "  [synced] ${dir}/"
  fi
done

# 同期対象ファイル
for file in SECURITY.md SECURITY.ja.md; do
  if [[ -f "${BRAIN_DIR}/${file}" ]]; then
    cp "${BRAIN_DIR}/${file}" "${APP_DIR}/${file}"
    echo "  [synced] ${file}"
  fi
done

# LICENSE (リポルートから)
if [[ -f "${REPO_ROOT}/LICENSE" ]]; then
  cp "${REPO_ROOT}/LICENSE" "${APP_DIR}/LICENSE"
  echo "  [synced] LICENSE"
fi

echo ""

# -----------------------------------------------------------------------------
# kioku リポの .git を復元して操作
# -----------------------------------------------------------------------------

cd "${APP_DIR}"
mv .git-kioku .git
trap 'cd "${APP_DIR}" && mv .git .git-kioku' EXIT

# next ブランチに切り替え (なければ作成)
if git show-ref --quiet refs/heads/next 2>/dev/null; then
  git checkout next --quiet
else
  git checkout -b next --quiet
  echo "  [created] next branch"
fi

# 差分確認
git add -A
if git diff --cached --quiet; then
  echo "=== sync-to-app: no changes to sync ==="
  git checkout main --quiet 2>/dev/null || true
  exit 0
fi

echo "=== changes to sync ==="
git diff --cached --stat
echo ""

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "=== sync-to-app: DRY RUN — no commit made ==="
  git reset HEAD --quiet
  git checkout main --quiet 2>/dev/null || true
  exit 0
fi

# コミット + push
git commit -m "sync: update from parent $(date +%Y%m%d-%H%M)" --quiet
git push -u origin next --quiet 2>/dev/null || git push --set-upstream origin next --quiet

echo ""
echo "=== sync-to-app: pushed to next branch ==="
echo ""
echo "Next steps:"
echo "  1. Review: https://github.com/megaphone-tokyo/kioku/compare/main...next"
echo "  2. Merge:  gh pr create --base main --head next --title 'Sync from parent'"
echo "  3. Or:     git checkout main && git merge next && git push"
echo ""

# main に戻す
git checkout main --quiet 2>/dev/null || true
