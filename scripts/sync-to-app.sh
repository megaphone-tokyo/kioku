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
# GitHub-side lock (α): 2026-04-21 NEW-L2 fix (v0.4.0 Tier B#3)
#
# 2 台運用 (MacBook + Mac mini) で cron sync が近接時刻に起動すると、両方が
# 同じ内容で origin/next に push して重複 PR を生む race 条件がある (症状 #1)。
# kioku の origin/next の最終 push 時刻を gh CLI で確認し、閾値秒数以内に
# 他 run が push 済ならこの run は早期 exit して重複 push を避ける。
#
# Config:
#   KIOKU_SYNC_LOCK_MAX_AGE  閾値 (秒)。デフォルト 120。0 を指定すると無効化。
#
# Fail-open:
#   - gh auth 失敗 / network error / rate limit: 全て現状回帰 (guard skip)。
#   - 片方 Mac で gh 無効化の場合、この guard は効かない。trade-off として受容。
#
# Design:
#   - --dry-run では skip (operator が手動検証する時に guard でブロックしない)。
#   - line 72 の `git fetch` 直後に呼び出す。branch checkout より前に入れて、
#     push 予定の branch 作り込みコストを早期回避する。
#   - exit 時は既存 trap (line 65) が .git-kioku を復元する。
#
# Reference: 合意記録 plan/claude/26042104_meeting...md ## Resume session 2
# -----------------------------------------------------------------------------
check_github_side_lock() {
  [[ "${DRY_RUN:-0}" == "1" ]] && return 0
  local max_age="${KIOKU_SYNC_LOCK_MAX_AGE:-120}"
  (( max_age <= 0 )) && return 0

  local last_push_iso last_push_epoch now_epoch age
  last_push_iso="$(gh api repos/megaphone-tokyo/kioku/branches/next \
      --jq .commit.commit.committer.date 2>/dev/null || true)"
  [[ -z "${last_push_iso}" ]] && return 0  # gh 未認証 / network error → fail-open

  last_push_epoch="$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "${last_push_iso}" +%s 2>/dev/null || echo 0)"
  now_epoch="$(date -u +%s)"
  age=$(( now_epoch - last_push_epoch ))

  if (( age >= 0 && age < max_age )); then
    echo "  [skip] origin/next was pushed ${age}s ago (<${max_age}s); another sync likely just completed" >&2
    exit 0
  fi
  return 0
}

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

# 2026-04-20 MED-f1 fix: 前回 crash 中に .git と .git-kioku が両方残ると、
# 次回 `mv .git-kioku .git` が既存 .git を破壊的に上書きし kioku repo の
# history が破損する。script 先頭で両立を detect して abort する。
# 解消手順: rm -rf app/.git (kioku 側はリモートから再 clone で復旧可)
if [[ -d .git && -d .git-kioku ]]; then
  echo "ERROR: app/.git and app/.git-kioku both exist." >&2
  echo "  This is a leftover from a crashed sync-to-app.sh run." >&2
  echo "  Manual recovery required: 'rm -rf $(pwd)/.git' (re-clone kioku from remote if needed)." >&2
  exit 1
fi

# trap を先に仕込んでから rename (rename 失敗時も .git-kioku 側を戻せるように)
trap 'cd "${APP_DIR}" && [[ -d .git ]] && mv .git .git-kioku 2>/dev/null || true' EXIT INT TERM HUP
mv .git-kioku .git

# 2026-04-20: リモート最新を fetch してから branch を切り替える。
# これをしないとローカル main / next が origin に対して古い状態で rsync の
# 差分が出たり、最後の `git checkout main` で古い commit に戻って WT が
# 散らかる (feature 2.2 リリース時の WT drift 問題)。fetch 失敗は許容。
git fetch origin --quiet 2>/dev/null || true

# 2026-04-21 NEW-L2 (v0.4.0 Tier B#3): cross-machine race guard.
# gh api で origin/next の最終 push 時刻を取り、閾値以内なら早期 exit。
# --dry-run / KIOKU_SYNC_LOCK_MAX_AGE=0 で skip。gh エラーは fail-open。
check_github_side_lock

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
  # 2026-04-20 MED-f2 fix: dirty WT (kioku repo 側で未 commit の手編集) を検知
  # したら `git stash push` で保険を作ってから force checkout する。
  # git stash list で後から復旧可能。
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    local_dirty_stash=1
    # 2026-04-21 NEW-L1 fix: stash message に `$$` (shell PID) を混ぜて 1 秒以内の
    # 連続呼び出しでも message が衝突しないようにする。macOS `date` は `%N`
    # (nanosec) 非対応のため PID で一意化する。`git stash list` で recovery する
    # operator が履歴を区別できる。
    git stash push -u -m "sync-to-app auto-stash $(date +%Y%m%d-%H%M%S)-pid$$" --quiet 2>/dev/null || true
    echo "  [notice] dirty WT detected; uncommitted changes stashed. Recover with: cd $(pwd) && mv .git-kioku .git && git stash list" >&2
  fi
  # -B: 既存なら reset、無ければ create。--force 相当で WT の untracked も排除しない
  # が、tracked conflict があっても origin/main の内容で上書きされる。
  git checkout -B next origin/main --quiet 2>/dev/null || {
    # WT に untracked + conflicting files がある場合の rescue path:
    # hard reset + clean で強制的にクリーン状態にする (sync の用途上、commit
    # 前の手編集は stash 済なので安全に上書きされる)。
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
for dir in hooks scripts templates skills tests mcp docs .claude-plugin; do
  if [[ -d "${BRAIN_DIR}/${dir}" ]]; then
    # 2026-04-20 security-review HIGH-b1 fix:
    # 旧コードは `--exclude='.git*'` だったため、glob が `.gitignore` まで誤爆し
    # `templates/vault/.gitignore` が kioku に **一度も sync されていない**
    # 状態だった (v0.3.0 配布 .mcpb に機能 2.1 / 2.2 で追加された
    # `.cache/`, `.cache/html/`, `.kioku-mcp.lock` エントリが欠落)。
    # 個別 exclude に分離して `.gitignore` は必ず sync 対象にする。
    rsync -a --delete \
      --exclude='.git' \
      --exclude='.git-kioku' \
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
  # 2026-04-20 LOW-f3 fix: DRY_RUN では next (= origin/main + 出発点) に留めて、
  # `main` への切替を行わない。operator が「dry-run 後の branch 状態」から次に
  # 期待する state を予測しやすくするため (旧実装では main checkout + ff merge
  # で局所的な state 変更が意外な結果を招いた)。
  echo "  [dry-run] local next points at origin/main (+ rsync reverted). local main untouched."
  echo "  [dry-run] NOTE: parent repo's app/ working tree now reflects kioku origin/main state,"
  echo "  [dry-run]       which may differ from parent's HEAD (tracked app/). To restore the"
  echo "  [dry-run]       parent-clean view, run: cd $(dirname "${APP_DIR}") && git checkout HEAD -- app/"
  exit 0
fi

# コミット + push
git commit -m "sync: update from parent $(date +%Y%m%d-%H%M)" --quiet
# 2026-04-20: 上の reset --hard で local next を origin/main に巻き戻した場合、
# origin/next は古い履歴を持つため fast-forward push は reject される。
# --force-with-lease で "origin/next が想定どおりなら上書き" を明示 (他者の
# 割り込みは検知して abort する安全版 force)。通常 sync では noop。
# 2026-04-20 LOW-f1 fix: push の 3 段フォールバックが silent failure しないよう、
# 最終段の --force-with-lease が失敗した場合は明示的に ERROR 出して exit 1。
git push -u origin next --quiet 2>/dev/null \
  || git push --set-upstream origin next --quiet 2>/dev/null \
  || {
    echo "=== sync: fast-forward push failed; attempting force-with-lease ===" >&2
    git push --force-with-lease origin next --quiet || {
      echo "ERROR: sync push failed (origin/next may have diverged or network issue)" >&2
      exit 1
    }
  }

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
