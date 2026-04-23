#!/usr/bin/env bash
#
# post-release-sync.sh — parent の app/ snapshot を kioku main の最新 state に揃える
#
# 背景 (2026-04-21 v0.4.0 release 時に顕在化):
#   sync-to-app.sh は kioku `next` に push する。その末尾で `git checkout main
#   && git merge --ff-only origin/main` が走るが、これは push 直後タイミングで
#   kioku PR #N が main に merge される **前**。したがって sync-to-app 終了時点
#   の app/ は「1 世代古い kioku main snapshot」になっている (= parent HEAD と
#   一致しないので次の parent コミットで意図しない diff が出る)。
#
#   この script は kioku `next → main` PR を merge した **後** に別途呼んで、
#   app/ を kioku 最新 main state に揃える。--commit で parent 側 commit + push
#   まで自動化できる。
#
# Usage:
#   bash tools/claude-brain/scripts/post-release-sync.sh             # 同期のみ (手動 commit)
#   bash tools/claude-brain/scripts/post-release-sync.sh --commit    # 同期 + parent commit + push
#   bash tools/claude-brain/scripts/post-release-sync.sh --dry-run   # 実行予定のみ表示
#   bash tools/claude-brain/scripts/post-release-sync.sh --force-sync  # diverge 時 git reset --hard で強制追従 (opt-in)
#   bash tools/claude-brain/scripts/post-release-sync.sh --help      # usage
#
# Diverge 対応:
#   通常は sync-to-app.sh 経由で local main は origin/main に ff-merge される。
#   ただし手動で app/ main に commit を足した直後などで local/origin が diverge
#   すると ff-only merge が fail する (2026-04-21 v0.4.0 post-release docs 運用
#   で実体験)。default は fatal エラー + 手順案内で停止、意図を明示できる場合
#   は --force-sync で `git reset --hard origin/main` で強制追従する。
#
# 前提:
#   - app/.git-kioku が存在 (kioku repo の .git)
#   - origin remote が megaphone-tokyo/kioku を指す (sync-to-app と同じ)
#
# 互換性: sync-to-app.sh の挙動は一切変更しない。本 script は追加的 post-hook。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRAIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
APP_DIR="${BRAIN_DIR}/app"
REPO_ROOT="$(cd "${BRAIN_DIR}/../.." && pwd)"

MODE=sync
FORCE_SYNC=0
for arg in "$@"; do
  case "${arg}" in
    --commit) MODE=commit ;;
    --dry-run) MODE=dry-run ;;
    --force-sync) FORCE_SYNC=1 ;;
    -h|--help)
      sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: ${arg}" >&2
      exit 1
      ;;
  esac
done

# -----------------------------------------------------------------------------
# 前提 check
# -----------------------------------------------------------------------------

if [[ ! -d "${APP_DIR}/.git-kioku" ]]; then
  echo "ERROR: ${APP_DIR}/.git-kioku not found. Is kioku repo initialized?" >&2
  exit 1
fi

cd "${APP_DIR}"

# Crash recovery guard (sync-to-app.sh MED-f1 pattern):
# .git と .git-kioku が両方残っていると次回 mv が破壊的になるので abort。
if [[ -d .git && -d .git-kioku ]]; then
  echo "ERROR: app/.git and app/.git-kioku both exist." >&2
  echo "  This is a leftover from a crashed sync-to-app or post-release-sync run." >&2
  echo "  Manual recovery required: 'rm -rf $(pwd)/.git' (re-clone kioku if needed)." >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# --dry-run: 実行予定のみ表示して exit
# -----------------------------------------------------------------------------

if [[ "${MODE}" == "dry-run" ]]; then
  echo "=== post-release-sync: dry-run (no side effects) ==="
  echo "  would: mv .git-kioku .git"
  echo "  would: git fetch origin --quiet"
  echo "  would: git checkout main --quiet"
  if [[ "${FORCE_SYNC}" -eq 1 ]]; then
    echo "  would: (--force-sync) git reset --hard origin/main if diverged, else git merge --ff-only"
  else
    echo "  would: git merge --ff-only origin/main --quiet (fatal error if diverged; use --force-sync to discard local)"
  fi
  echo "  would: mv .git .git-kioku"
  echo "  would: cd \"${REPO_ROOT}\" && git status --short tools/claude-brain/app/"
  echo "  would: (if --commit) git add / commit / push origin main"
  exit 0
fi

# -----------------------------------------------------------------------------
# kioku main の最新 state に app/ を揃える
# -----------------------------------------------------------------------------

# trap を先に仕込んでから rename (失敗時も .git → .git-kioku で戻す)
trap 'cd "${APP_DIR}" && [[ -d .git ]] && mv .git .git-kioku 2>/dev/null || true' EXIT INT TERM HUP
mv .git-kioku .git

echo "=== post-release-sync: fetching + aligning app/ to kioku main ==="
git fetch origin --quiet
git checkout main --quiet

# Diverge 検出: local HEAD が origin/main の祖先でなければ ff-only merge は不能
# (= 手動で app/ main に commit を足した後に remote が別 commit で進んだ場合)
if git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
  # local HEAD が origin/main の祖先 → 普通に FF merge
  git merge --ff-only origin/main --quiet
elif [[ "${FORCE_SYNC}" -eq 1 ]]; then
  # diverge だが --force-sync で明示的に強制追従を許可
  echo "  [force-sync] local main diverged from origin/main; git reset --hard origin/main" >&2
  echo "    (discarded local HEAD: $(git rev-parse --short HEAD))" >&2
  git reset --hard origin/main --quiet
else
  # diverge + --force-sync なし → 手順案内して exit
  local_head="$(git rev-parse --short HEAD)"
  remote_head="$(git rev-parse --short origin/main)"
  echo "ERROR: local app/ main is diverged from origin/main." >&2
  echo "  local HEAD:  ${local_head}" >&2
  echo "  remote HEAD: ${remote_head}" >&2
  echo "" >&2
  echo "  This usually means you manually committed to app/ main (bypassing sync-to-app" >&2
  echo "  → kioku PR → merge flow). If those local commits are already merged into kioku" >&2
  echo "  main via PR (same content, different sha), re-run with --force-sync to discard" >&2
  echo "  local commits and align hard to origin/main." >&2
  echo "" >&2
  echo "  Otherwise resolve the divergence manually (rebase or merge) before re-running." >&2
  exit 1
fi
KIOKU_MAIN_SHA="$(git rev-parse HEAD)"

mv .git .git-kioku
# trap は .git 不在なら noop なので安全

cd "${REPO_ROOT}"

echo ""
echo "  app/ now aligned to kioku main: ${KIOKU_MAIN_SHA:0:7}"
echo ""

# -----------------------------------------------------------------------------
# parent 視点の diff を表示
# -----------------------------------------------------------------------------

echo "=== parent repo diff for tools/claude-brain/app/ ==="
parent_diff="$(git status --short tools/claude-brain/app/ 2>/dev/null)"
if [[ -z "${parent_diff}" ]]; then
  echo "  (no diff — parent app/ snapshot already matches kioku main)"
  echo ""
  echo "=== done ==="
  exit 0
fi
printf '%s\n' "${parent_diff}" | head -20
echo ""

# -----------------------------------------------------------------------------
# --commit mode: parent に auto commit + push
# -----------------------------------------------------------------------------

if [[ "${MODE}" == "commit" ]]; then
  echo "=== committing + pushing ==="
  git add tools/claude-brain/app/
  git commit -m "claude-brain: post-release app/ snapshot sync (kioku main ${KIOKU_MAIN_SHA:0:7})"
  git push origin main
  echo "=== done (committed + pushed) ==="
else
  echo "Next steps (run manually, or re-invoke with --commit):"
  echo "  git add tools/claude-brain/app/"
  echo "  git commit -m 'claude-brain: post-release app/ snapshot sync (kioku main ${KIOKU_MAIN_SHA:0:7})'"
  echo "  git push origin main"
fi
