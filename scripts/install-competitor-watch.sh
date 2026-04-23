#!/usr/bin/env bash
#
# install-competitor-watch.sh — tools/claude-brain/competitors/ 週次監視の LaunchAgent 登録
#
# 概要:
#   scripts/competitor-watch.sh を毎週月曜 AM 9:00 に起動する LaunchAgent
#   (com.kioku.competitor-watch) を $HOME/Library/LaunchAgents/ に配置する。
#   templates/launchd/com.kioku.competitor-watch.plist.template を
#   プレースホルダ置換して生成し、launchctl bootstrap でロードする。
#
# 背景: 26042304 meeting §3.5 決定。SWOT Threats タイムウィンドウ
#   (2026 Q2 末) に対して、競合 claude-obsidian の release 動向を
#   後手に回らないよう、週次で自動 watch する軽量 cron。
#
# Usage:
#   bash install-competitor-watch.sh              # 冪等に plist 配置 + load
#   bash install-competitor-watch.sh --dry-run    # 予定だけ表示、書き込みなし
#   bash install-competitor-watch.sh --force      # 既存 plist を上書き
#   bash install-competitor-watch.sh --uninstall  # bootout + plist 削除
#   bash install-competitor-watch.sh -h           # ヘルプ
#
# 環境変数:
#   OBSIDIAN_VAULT            Vault ルート (--uninstall 以外で必須)
#   CLAUDE_LAUNCHAGENTS_DIR   plist 配置先 (既定: $HOME/Library/LaunchAgents)
#                              テスト時に mktemp 先へ差し替える
#   KIOKU_SKIP_LOAD           1 にすると launchctl bootstrap/bootout を呼ばない
#                              (テスト用)
#
# 終了コード:
#   0  正常終了
#   1  必須環境変数不足 / テンプレート不在
#   2  既存 plist が非同一で --force なし
#   3  launchctl bootstrap 失敗
#
# 関連 doc:
#   context/22-competitor-watch.md
#   plan/claude/26042304_meeting_post-v0-5-0-roadmap-review.md (§3.5)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOOL_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMPLATE_PATH="${TOOL_ROOT}/templates/launchd/com.kioku.competitor-watch.plist.template"
COMPETITOR_WATCH_ABS="${SCRIPT_DIR}/competitor-watch.sh"
LABEL="com.kioku.competitor-watch"

DEST_DIR="${CLAUDE_LAUNCHAGENTS_DIR:-${HOME}/Library/LaunchAgents}"
PLIST_PATH="${DEST_DIR}/${LABEL}.plist"

FORCE=0
DRY_RUN=0
UNINSTALL=0

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "${arg}" in
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "unknown argument: ${arg}" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# VULN-005 相当: パスのバリデーション (シェルメタ文字・XML 特殊文字を拒否)
validate_vault_path() {
  local p="$1"
  local safe_re='^[a-zA-Z0-9/._[:space:]-]+$'
  if [[ ! "${p}" =~ $safe_re ]]; then
    echo "ERROR: OBSIDIAN_VAULT contains unsafe characters: ${p}" >&2
    echo "       Only alphanumerics, /, ., _, space, and - are allowed." >&2
    exit 1
  fi
}

# -----------------------------------------------------------------------------
# Uninstall ブランチ
# -----------------------------------------------------------------------------

if [[ "${UNINSTALL}" -eq 1 ]]; then
  echo "== Uninstall ${LABEL} =="

  if [[ ! -f "${PLIST_PATH}" ]]; then
    echo "plist not found: ${PLIST_PATH}"
    echo "(already uninstalled)"
    exit 0
  fi

  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[dry-run] would bootout and remove ${PLIST_PATH}"
    exit 0
  fi

  if [[ "${KIOKU_SKIP_LOAD:-0}" != "1" ]]; then
    if command -v launchctl >/dev/null 2>&1; then
      launchctl bootout "gui/$(id -u)" "${PLIST_PATH}" 2>/dev/null || true
    fi
  fi

  rm -f "${PLIST_PATH}"
  echo "[removed] ${PLIST_PATH}"
  exit 0
fi

# -----------------------------------------------------------------------------
# Install ブランチ: 前提チェック
# -----------------------------------------------------------------------------

if [[ -z "${OBSIDIAN_VAULT:-}" ]]; then
  echo "ERROR: OBSIDIAN_VAULT is not set" >&2
  echo "Hint: export OBSIDIAN_VAULT=\"\${HOME}/claude-brain/main-claude-brain\"" >&2
  exit 1
fi

validate_vault_path "${OBSIDIAN_VAULT}"
validate_vault_path "${HOME}"

if [[ ! -f "${TEMPLATE_PATH}" ]]; then
  echo "ERROR: template not found: ${TEMPLATE_PATH}" >&2
  exit 1
fi

if [[ ! -f "${COMPETITOR_WATCH_ABS}" ]]; then
  echo "ERROR: competitor-watch.sh not found: ${COMPETITOR_WATCH_ABS}" >&2
  exit 1
fi

# competitor-watch.sh も validate (XML 埋め込みのため)
validate_vault_path "${COMPETITOR_WATCH_ABS}"

# -----------------------------------------------------------------------------
# plist 生成 (プレースホルダ置換)
# -----------------------------------------------------------------------------

echo "============================================================"
echo "claude-brain: competitor-watch LaunchAgent インストール"
echo "============================================================"
echo "  Label            = ${LABEL}"
echo "  Schedule         = 毎週月曜 AM 9:00 (StartCalendarInterval)"
echo "  Plist            = ${PLIST_PATH}"
echo "  Script           = ${COMPETITOR_WATCH_ABS}"
echo "  OBSIDIAN_VAULT   = ${OBSIDIAN_VAULT}"
echo "  Log              = ${HOME}/.local/log/kioku-competitor-watch.{log,err}"
echo ""

# テンプレートの各プレースホルダを置換
RENDERED="$(sed \
  -e "s|__COMPETITOR_WATCH_SH__|${COMPETITOR_WATCH_ABS}|g" \
  -e "s|__OBSIDIAN_VAULT__|${OBSIDIAN_VAULT}|g" \
  -e "s|__HOME__|${HOME}|g" \
  "${TEMPLATE_PATH}")"

if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "[dry-run] rendered plist:"
  echo "----------------------------------------------------------"
  echo "${RENDERED}"
  echo "----------------------------------------------------------"
  echo "[dry-run] would write to ${PLIST_PATH}"
  echo "[dry-run] would bootstrap gui/$(id -u) ${PLIST_PATH}"
  exit 0
fi

mkdir -p "${DEST_DIR}"
mkdir -p "${HOME}/.local/log"

# 既存 plist 比較 (冪等性)
if [[ -f "${PLIST_PATH}" ]]; then
  if printf '%s\n' "${RENDERED}" | cmp -s - "${PLIST_PATH}"; then
    echo "[same] ${PLIST_PATH} already up-to-date, skipping write"
  else
    if [[ "${FORCE}" -eq 0 ]]; then
      echo "ERROR: ${PLIST_PATH} differs from rendered template." >&2
      echo "       Re-run with --force to overwrite, or --uninstall first." >&2
      exit 2
    fi
    printf '%s\n' "${RENDERED}" > "${PLIST_PATH}"
    echo "[force-written] ${PLIST_PATH}"
  fi
else
  printf '%s\n' "${RENDERED}" > "${PLIST_PATH}"
  echo "[written] ${PLIST_PATH}"
fi

chmod 644 "${PLIST_PATH}"

# -----------------------------------------------------------------------------
# launchctl bootstrap
# -----------------------------------------------------------------------------

if [[ "${KIOKU_SKIP_LOAD:-0}" == "1" ]]; then
  echo "[skip] KIOKU_SKIP_LOAD=1, not calling launchctl"
  exit 0
fi

if ! command -v launchctl >/dev/null 2>&1; then
  echo "[warn] launchctl not available (non-macOS?). plist written but not loaded."
  exit 0
fi

UID_NUM="$(id -u)"

# 既存 bootout (冪等性 — 同じ label が既に load されていても失敗しない)
launchctl bootout "gui/${UID_NUM}" "${PLIST_PATH}" 2>/dev/null || true

if launchctl bootstrap "gui/${UID_NUM}" "${PLIST_PATH}" 2>/dev/null; then
  echo "[loaded] launchctl bootstrap gui/${UID_NUM} ${PLIST_PATH}"
else
  echo "ERROR: launchctl bootstrap failed for ${PLIST_PATH}" >&2
  echo "       You can retry manually: launchctl bootstrap gui/${UID_NUM} ${PLIST_PATH}" >&2
  exit 3
fi

cat <<EOF

============================================================
完了。com.kioku.competitor-watch が登録されました
============================================================

動作確認:
  # LaunchAgent の list に出ているか
  launchctl print gui/${UID_NUM}/${LABEL} | head -20

  # 手動で 1 回走らせる (次回月曜を待たずにテスト)
  launchctl kickstart -p gui/${UID_NUM}/${LABEL}

  # Vault の wiki/meta/competitor-watch/ に週次レポートが生成される
  ls -la "\${OBSIDIAN_VAULT}/wiki/meta/competitor-watch/"

  # ログ
  tail -f ${HOME}/.local/log/kioku-competitor-watch.log
  tail -f ${HOME}/.local/log/kioku-competitor-watch.err

アンインストール:
  bash install-competitor-watch.sh --uninstall

関連 doc:
  tools/claude-brain/context/22-competitor-watch.md
EOF
