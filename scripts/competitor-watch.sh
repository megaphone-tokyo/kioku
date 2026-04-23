#!/usr/bin/env bash
#
# competitor-watch.sh — tools/claude-brain/competitors/*/ を週次監視
#
# 概要:
#   tools/claude-brain/competitors/ 配下の各リポジトリを fetch + ff-only pull し、
#   直近 7 日のコミットとタグを週次レポートとして Vault の
#   wiki/meta/competitor-watch/<ISO-week>.md に書き出す。
#
# 用途: 26042304 meeting §3.5 決定、SWOT Threats タイムウィンドウ (2026 Q2 末)
#   対策として、競合 claude-obsidian の release 動向を後手に回らないよう週次監視。
#
# 環境変数:
#   OBSIDIAN_VAULT         Vault ルート (必須)
#   KIOKU_DRY_RUN          "1" の場合、Vault への書き込みをスキップ (stdout のみ)
#   KIOKU_DEBUG            "1" の場合、stderr に詳細ログ
#   KIOKU_COMPETITOR_DIR   (テスト用) competitors ディレクトリの override
#
# 終了コード:
#   0  正常終了
#   1  OBSIDIAN_VAULT 未設定 / competitors ディレクトリなし
#   2  Vault 書き込み不能
#
# LaunchAgent 登録: install-competitor-watch.sh --apply 経由
#   毎週月曜 AM 9:00 に実行される
#
# ネットワーク方針: Hook スクリプトではないため git fetch は許容。ただし
#   pull は --ff-only のみで、force-push / rewrite 履歴には追従しない
#   (攻撃者による競合リポ compromise 経由の書き換え防止)。

set -euo pipefail

# -----------------------------------------------------------------------------
# 定数 + 環境変数
# -----------------------------------------------------------------------------

VAULT="${OBSIDIAN_VAULT:-}"
if [[ -z "${VAULT}" ]]; then
  echo "ERROR: OBSIDIAN_VAULT is not set" >&2
  echo "Hint: export OBSIDIAN_VAULT=\"\${HOME}/claude-brain/main-claude-brain\"" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPETITORS_DIR="${KIOKU_COMPETITOR_DIR:-${SCRIPT_DIR}/../competitors}"

if [[ ! -d "${COMPETITORS_DIR}" ]]; then
  echo "ERROR: competitors directory not found: ${COMPETITORS_DIR}" >&2
  exit 1
fi

COMPETITORS_DIR_ABS="$(cd "${COMPETITORS_DIR}" && pwd)"

# ISO 8601 week (GNU date と BSD date で差があるが GNU は %G-W%V、BSD は %Y-%U 代替)
# macOS BSD date でも `date '+%G-W%V'` が後期 BSD で動作することを確認済 (darwin 25.x)
ISO_WEEK="$(date '+%G-W%V')"
GENERATED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

OUTPUT_DIR="${VAULT}/wiki/meta/competitor-watch"
OUTPUT_FILE="${OUTPUT_DIR}/${ISO_WEEK}.md"

DRY_RUN="${KIOKU_DRY_RUN:-0}"
DEBUG="${KIOKU_DEBUG:-0}"

log_debug() {
  if [[ "${DEBUG}" == "1" ]]; then
    echo "[debug] $*" >&2
  fi
}

# -----------------------------------------------------------------------------
# Vault ディレクトリ確保 (dry-run では skip)
# -----------------------------------------------------------------------------

if [[ "${DRY_RUN}" == "1" ]]; then
  log_debug "DRY_RUN=1, skipping vault write"
  OUTPUT_FILE="/dev/stdout"
else
  if ! mkdir -p "${OUTPUT_DIR}" 2>/dev/null; then
    echo "ERROR: cannot create output dir: ${OUTPUT_DIR}" >&2
    exit 2
  fi
  # ディレクトリ権限を Vault 慣例 (0o700) に合わせる (新規作成時のみ効く)
  chmod 700 "${OUTPUT_DIR}" 2>/dev/null || true
fi

# -----------------------------------------------------------------------------
# レポート生成
# -----------------------------------------------------------------------------

{
  cat <<EOF
---
title: Competitor Watch — Week ${ISO_WEEK}
type: competitor-watch
generated: ${GENERATED_AT}
iso_week: ${ISO_WEEK}
---

# Competitor Watch — Week ${ISO_WEEK}

> 自動生成: \`scripts/competitor-watch.sh\` (週次 LaunchAgent \`com.kioku.competitor-watch\`)
>
> 26042304 meeting §3.5 決定。SWOT Threats タイムウィンドウ (2026 Q2 末) 対策として、
> 競合 release 動向の認知遅延を防ぐ。

EOF

  found_any=0

  for competitor_path in "${COMPETITORS_DIR_ABS}"/*/; do
    [[ -d "${competitor_path}" ]] || continue
    [[ -d "${competitor_path}/.git" ]] || continue

    competitor_name="$(basename "${competitor_path}")"
    found_any=1

    echo "## ${competitor_name}"
    echo ""

    # リモート情報
    remote_url="$(git -C "${competitor_path}" config --get remote.origin.url 2>/dev/null || echo '(no origin)')"
    echo "- **Remote**: \`${remote_url}\`"

    # 現在 HEAD
    sha_before="$(git -C "${competitor_path}" rev-parse --short HEAD 2>/dev/null || echo 'unknown')"

    # Fetch (silent、失敗しても続行 = 過去 state レポート)
    if git -C "${competitor_path}" fetch --quiet --tags origin 2>/dev/null; then
      log_debug "fetched ${competitor_name}"
    else
      echo "- ⚠️ \`git fetch\` failed (network issue or stale remote)"
    fi

    # Fast-forward only pull (force-push には追従しない = 攻撃者による履歴書き換え防止)
    if git -C "${competitor_path}" symbolic-ref -q HEAD >/dev/null 2>&1; then
      if git -C "${competitor_path}" pull --ff-only --quiet 2>/dev/null; then
        log_debug "fast-forward pulled ${competitor_name}"
      else
        echo "- ⚠️ \`git pull --ff-only\` refused (non-fast-forward or divergent history)"
      fi
    else
      echo "- ⚠️ HEAD is detached, skipping pull"
    fi

    sha_after="$(git -C "${competitor_path}" rev-parse --short HEAD 2>/dev/null || echo 'unknown')"

    if [[ "${sha_before}" != "${sha_after}" ]]; then
      echo "- **Updated**: \`${sha_before}\` → \`${sha_after}\`"
    else
      echo "- **No new commits on tracked branch** (HEAD: \`${sha_after}\`)"
    fi

    echo ""
    echo "### Commits (last 7 days)"
    echo ""
    commits="$(git -C "${competitor_path}" log --since='7 days ago' \
      --pretty=format:'%h %ad %s' --date=short 2>/dev/null || true)"
    if [[ -z "${commits}" ]]; then
      echo "_(no commits in the last 7 days)_"
    else
      echo '```'
      echo "${commits}"
      echo '```'
    fi

    echo ""
    echo "### Recent tags (top 5 by creation date)"
    echo ""
    tags="$(git -C "${competitor_path}" tag --sort=-creatordate 2>/dev/null | head -5 || true)"
    if [[ -z "${tags}" ]]; then
      echo "_(no tags)_"
    else
      echo '```'
      echo "${tags}"
      echo '```'
    fi

    echo ""
    echo "### File count summary (tracked files)"
    echo ""
    total_files="$(git -C "${competitor_path}" ls-files 2>/dev/null | wc -l | tr -d ' ' || echo 'unknown')"
    echo "- Total tracked files: ${total_files}"
    echo ""

    echo "---"
    echo ""
  done

  if [[ "${found_any}" == "0" ]]; then
    echo "## (no competitors registered)"
    echo ""
    echo "To start monitoring a competitor, clone its repo under \`tools/claude-brain/competitors/<name>/\`:"
    echo ""
    echo '```bash'
    echo "cd tools/claude-brain/competitors"
    echo "git clone https://github.com/EXAMPLE/competitor.git"
    echo '```'
  fi

  cat <<EOF

## KIOKU Response Notes

_このセクションは Claude (auto-ingest L1) が週次で埋めるか、ユーザーが手で追記することを想定。_

- Adoption candidates discovered this week:
- Threats escalated / de-escalated:
- Defer updates to \`handoff/open-issues.md\`:

---

_次回 watch 実行: 翌週月曜 AM (LaunchAgent \`com.kioku.competitor-watch\`)_
EOF

} > "${OUTPUT_FILE}"

if [[ "${DRY_RUN}" != "1" ]]; then
  chmod 600 "${OUTPUT_FILE}" 2>/dev/null || true
  echo "[written] ${OUTPUT_FILE}"
fi
