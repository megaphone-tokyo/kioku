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
# kioku リポの .git を復元して、まず next ブランチに切り替える (clean WT を確保)
#
# 重要: rsync より「先に」branch checkout を済ませる。WT を dirty にしてから
# checkout すると「上書きされちゃうよ」と git にアボートされるため。
# -----------------------------------------------------------------------------

cd "${APP_DIR}"
mv .git-kioku .git
trap 'cd "${APP_DIR}" && [[ -d .git ]] && mv .git .git-kioku 2>/dev/null || true' EXIT

# 2026-04-20: リモート最新を fetch してから branch を切り替える。
# これをしないとローカル main / next が origin に対して古い状態で rsync の
# 差分が出たり、最後の `git checkout main` で古い commit に戻って WT が
# 散らかる (feature 2.2 リリース時の WT drift 問題)。fetch 失敗は許容。
git fetch origin --quiet 2>/dev/null || true

# 2026-04-20: rebase-merge 運用で origin/next の履歴が rewrite される
# (kioku main へ rebase-merge 済の commit が origin/main に存在し、ローカル
# next に残る pre-rebase commit と diverge して PR が CONFLICT) ケース + WT が
# parent repo のファイル状態 (feature files を保持) で checkout next が
# untracked conflict で abort するケースの両方を一度に解決するため、
# 「次回 sync の出発点は常に origin/main」という ephemeral next 運用に統一する。
# この後すぐ rsync が WT を親 repo の最新状態で上書きするので、branch reset
# で WT が失われても損失はない (commit 前の未保存変更があった場合を除く)。
# 初回 push は通常 fast-forward、2 回目以降の rebase-merge 後は force-with-lease
# が必要になる (後段の push ロジックでフォールバック)。
if git show-ref --quiet refs/remotes/origin/main 2>/dev/null; then
  # -B: 既存なら reset、無ければ create。--force 相当で WT の untracked も排除しない
  # が、tracked conflict があっても origin/main の内容で上書きされる。
  git checkout -B next origin/main --quiet 2>/dev/null || {
    # WT に untracked + conflicting files がある場合の rescue path:
    # hard reset + clean で強制的にクリーン状態にする (sync の用途上、commit
    # 前の手編集は想定外なので許容)。
    git checkout --force -B next origin/main --quiet
  }
else
  # origin/main が取れない (初回 clone 前 / fetch 失敗) 時は従来挙動に fallback
  if git show-ref --quiet refs/heads/next 2>/dev/null; then
    git checkout next --quiet
  else
    git checkout -b next --quiet
    echo "  [created] next branch"
  fi
fi

# -----------------------------------------------------------------------------
# ファイル同期 (clean な next の上に親リポの最新を被せる → 差分 = 今回の追加分)
# -----------------------------------------------------------------------------

cd "${BRAIN_DIR}"
echo "=== sync-to-app: copying from parent to app/ ==="

# 同期対象ディレクトリ
# mcp/ は Phase M で追加された独立 npm プロジェクト。node_modules/ はユーザーが
# `bash scripts/setup-mcp.sh` で導入するため、rsync 側でも除外する。
# Phase N で追加した build/ と dist/ (MCPB バンドルのビルド成果物) も同様に除外。
for dir in hooks scripts templates skills tests mcp; do
  if [[ -d "${BRAIN_DIR}/${dir}" ]]; then
    rsync -a --delete \
      --exclude='.git*' \
      --exclude='node_modules' \
      --exclude='build' \
      --exclude='dist' \
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
# 差分確認 / commit / push
# -----------------------------------------------------------------------------

cd "${APP_DIR}"
git add -A
if git diff --cached --quiet; then
  echo "=== sync-to-app: no changes to sync ==="
  git checkout main --quiet 2>/dev/null || true
  git merge --ff-only origin/main --quiet 2>/dev/null || true
  exit 0
fi

echo "=== changes to sync ==="
git diff --cached --stat
echo ""

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "=== sync-to-app: DRY RUN — no commit made ==="
  # rsync で持ち込んだ WT 変更を破棄して next の HEAD に戻す
  git reset HEAD --quiet
  git checkout -- .
  git clean -fd >/dev/null
  # dry-run 側も main を ff-only で origin/main に揃えて WT drift を回避
  git checkout main --quiet 2>/dev/null || true
  git merge --ff-only origin/main --quiet 2>/dev/null || true
  exit 0
fi

# コミット + push
git commit -m "sync: update from parent $(date +%Y%m%d-%H%M)" --quiet
# 2026-04-20: 上の reset --hard で local next を origin/main に巻き戻した場合、
# origin/next は古い履歴を持つため fast-forward push は reject される。
# --force-with-lease で "origin/next が想定どおりなら上書き" を明示 (他者の
# 割り込みは検知して abort する安全版 force)。通常 sync では noop。
git push -u origin next --quiet 2>/dev/null \
  || git push --set-upstream origin next --quiet 2>/dev/null \
  || git push --force-with-lease origin next --quiet

echo ""
echo "=== sync-to-app: pushed to next branch ==="
echo ""
echo "Next steps:"
echo "  1. Review: https://github.com/megaphone-tokyo/kioku/compare/main...next"
echo "  2. Merge:  gh pr create --base main --head next --title 'Sync from parent'"
echo "  3. Or:     git checkout main && git merge next && git push"
echo ""

# main に戻す (ローカル main を origin/main に fast-forward して WT drift を回避)
#
# 2026-04-20: ローカル main が origin/main より古いと、ここでの checkout 後に
# kioku の古い commit ツリーが app/ WT に重ねられ、親リポから見ると app/ が
# 「feature ファイルが大量に deleted」の状態になる (v0.3.0 リリース時の実害)。
# fetch は先頭で済ませているので、ff-only merge で安全に追従する。
git checkout main --quiet 2>/dev/null || true
git merge --ff-only origin/main --quiet 2>/dev/null || true
