#!/usr/bin/env bash
#
# install-launchagents.sh — macOS 用 claude-brain 定期実行セットアップ (Phase L)
#
# templates/launchd/*.plist.template をプレースホルダ置換して
# $HOME/Library/LaunchAgents/ (または CLAUDE_LAUNCHAGENTS_DIR) に配置し、
# launchctl bootstrap でロードする。冪等に動作する。
#
# Usage:
#   bash install-launchagents.sh              # 冪等に plist 配置 + load
#   bash install-launchagents.sh --dry-run    # 予定だけ表示、書き込みなし
#   bash install-launchagents.sh --force      # 既存 plist を上書き
#   bash install-launchagents.sh --uninstall  # bootout + plist 削除
#   bash install-launchagents.sh -h           # ヘルプ
#
# 環境変数:
#   OBSIDIAN_VAULT            Vault ルート (必須)
#   CLAUDE_LAUNCHAGENTS_DIR   plist 配置先 (既定: $HOME/Library/LaunchAgents)
#                             テスト時に mktemp 先へ差し替える
#   KIOKU_SKIP_LOAD    1 にすると launchctl bootstrap/bootout を呼ばない (テスト用)
#
# 終了コード:
#   0  正常終了
#   1  必須環境変数不足 / ファイル不在
#   2  既存 plist が非同一で --force なし
#   3  launchctl bootstrap 失敗
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TOOL_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMPLATE_DIR="${TOOL_ROOT}/templates/launchd"
AUTO_INGEST_ABS="${SCRIPT_DIR}/auto-ingest.sh"
AUTO_LINT_ABS="${SCRIPT_DIR}/auto-lint.sh"

DEST_DIR="${CLAUDE_LAUNCHAGENTS_DIR:-${HOME}/Library/LaunchAgents}"

FORCE=0
DRY_RUN=0
UNINSTALL=0

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "${arg}" in
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: ${arg}" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# VULN-005: パスのバリデーション (シェルメタ文字・XML 特殊文字を拒否)
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
# 前提チェック
# -----------------------------------------------------------------------------

if [[ "${UNINSTALL}" -eq 0 ]]; then
  # インストール時のみ OBSIDIAN_VAULT が必須
  if [[ -z "${OBSIDIAN_VAULT:-}" ]]; then
    echo "ERROR: OBSIDIAN_VAULT is not set" >&2
    echo "       export OBSIDIAN_VAULT=/path/to/your/vault" >&2
    exit 1
  fi

  validate_vault_path "${OBSIDIAN_VAULT}"

  if [[ ! -f "${AUTO_INGEST_ABS}" ]]; then
    echo "ERROR: auto-ingest.sh not found at ${AUTO_INGEST_ABS}" >&2
    exit 1
  fi

  if [[ ! -f "${AUTO_LINT_ABS}" ]]; then
    echo "ERROR: auto-lint.sh not found at ${AUTO_LINT_ABS}" >&2
    exit 1
  fi

  if [[ ! -d "${TEMPLATE_DIR}" ]]; then
    echo "ERROR: template directory not found: ${TEMPLATE_DIR}" >&2
    exit 1
  fi
fi

# -----------------------------------------------------------------------------
# LaunchAgent 対象一覧
# -----------------------------------------------------------------------------
# template_name:label の 2 要素
AGENTS=(
  "com.kioku.ingest.plist.template:com.kioku.ingest"
  "com.kioku.lint.plist.template:com.kioku.lint"
)

# -----------------------------------------------------------------------------
# ユーティリティ
# -----------------------------------------------------------------------------
generate_plist() {
  local template="$1"
  local dest="$2"
  # sed の区切り文字はパスに含まれない `|` を使う
  sed \
    -e "s|__AUTO_INGEST_SH__|${AUTO_INGEST_ABS}|g" \
    -e "s|__AUTO_LINT_SH__|${AUTO_LINT_ABS}|g" \
    -e "s|__OBSIDIAN_VAULT__|${OBSIDIAN_VAULT}|g" \
    -e "s|__HOME__|${HOME}|g" \
    "${template}" > "${dest}"
}

files_equal() {
  # 2 ファイルの内容が同一なら 0, それ以外 1
  if [[ ! -f "$1" ]] || [[ ! -f "$2" ]]; then
    return 1
  fi
  cmp -s "$1" "$2"
}

launchctl_bootstrap() {
  local label="$1"
  local plist="$2"
  if [[ "${KIOKU_SKIP_LOAD:-0}" == "1" ]]; then
    echo "  [skip-load]  ${label} (KIOKU_SKIP_LOAD=1)"
    return 0
  fi
  local uid
  uid="$(id -u)"
  # 既にロードされていれば bootout する (冪等性)
  if launchctl print "gui/${uid}/${label}" >/dev/null 2>&1; then
    launchctl bootout "gui/${uid}/${label}" >/dev/null 2>&1 || true
  fi
  if ! launchctl bootstrap "gui/${uid}" "${plist}" 2>&1; then
    echo "ERROR: launchctl bootstrap failed for ${label}" >&2
    return 3
  fi
  echo "  [loaded]  ${label}"
}

launchctl_bootout() {
  local label="$1"
  if [[ "${KIOKU_SKIP_LOAD:-0}" == "1" ]]; then
    return 0
  fi
  local uid
  uid="$(id -u)"
  if launchctl print "gui/${uid}/${label}" >/dev/null 2>&1; then
    launchctl bootout "gui/${uid}/${label}" >/dev/null 2>&1 || true
    echo "  [unloaded]  ${label}"
  fi
}

# -----------------------------------------------------------------------------
# --uninstall 経路
# -----------------------------------------------------------------------------
if [[ "${UNINSTALL}" -eq 1 ]]; then
  echo "install-launchagents: uninstalling from ${DEST_DIR}"
  for entry in "${AGENTS[@]}"; do
    label="${entry##*:}"
    dest="${DEST_DIR}/${label}.plist"
    launchctl_bootout "${label}"
    if [[ -f "${dest}" ]]; then
      if [[ "${DRY_RUN}" -eq 1 ]]; then
        echo "  [dry-run] would rm ${dest}"
      else
        rm "${dest}"
        echo "  [removed]  ${label}.plist"
      fi
    else
      echo "  [absent]   ${label}.plist"
    fi
  done
  echo "install-launchagents: uninstall complete."
  exit 0
fi

# -----------------------------------------------------------------------------
# インストール経路
# -----------------------------------------------------------------------------
echo "install-launchagents: dest     = ${DEST_DIR}"
echo "install-launchagents: vault    = ${OBSIDIAN_VAULT}"
echo "install-launchagents: ingest   = ${AUTO_INGEST_ABS}"
echo "install-launchagents: lint     = ${AUTO_LINT_ABS}"
if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "install-launchagents: DRY RUN (no files will be written)"
fi
echo

if [[ "${DRY_RUN}" -eq 0 ]]; then
  mkdir -p "${DEST_DIR}"
fi

TMPWORK="$(mktemp -d)"
trap 'rm -rf "${TMPWORK}"' EXIT

CREATED=0
SKIPPED=0
REPLACED=0
WARNED=0

for entry in "${AGENTS[@]}"; do
  template_name="${entry%%:*}"
  label="${entry##*:}"

  template_path="${TEMPLATE_DIR}/${template_name}"
  dest="${DEST_DIR}/${label}.plist"

  if [[ ! -f "${template_path}" ]]; then
    echo "ERROR: template not found: ${template_path}" >&2
    exit 1
  fi

  # 一時ファイルに展開して既存ファイルと比較
  staged="${TMPWORK}/${label}.plist"
  generate_plist "${template_path}" "${staged}"

  # プレースホルダが残っていないか検証
  if grep -q '__[A-Z_]*__' "${staged}" 2>/dev/null; then
    echo "ERROR: unresolved placeholders in ${staged}:" >&2
    grep -o '__[A-Z_]*__' "${staged}" >&2 || true
    exit 1
  fi

  if [[ -e "${dest}" ]]; then
    if files_equal "${staged}" "${dest}"; then
      echo "  [skip]    ${label}.plist (already up to date)"
      SKIPPED=$((SKIPPED + 1))
      # 既存 plist が正しくロードされているか念のため確認 (load state は separate)
      if [[ "${DRY_RUN}" -eq 0 ]]; then
        launchctl_bootstrap "${label}" "${dest}" || true
      fi
      continue
    fi

    if [[ "${FORCE}" -eq 1 ]]; then
      echo "  [force]   ${label}.plist (overwriting)"
      if [[ "${DRY_RUN}" -eq 0 ]]; then
        cp "${staged}" "${dest}"
        launchctl_bootstrap "${label}" "${dest}" || exit 3
      fi
      REPLACED=$((REPLACED + 1))
      continue
    fi

    echo "  [WARN]    ${label}.plist exists and differs; use --force to overwrite" >&2
    WARNED=$((WARNED + 1))
    continue
  fi

  echo "  [create]  ${label}.plist"
  if [[ "${DRY_RUN}" -eq 0 ]]; then
    cp "${staged}" "${dest}"
    launchctl_bootstrap "${label}" "${dest}" || exit 3
  fi
  CREATED=$((CREATED + 1))
done

echo
echo "install-launchagents: created=${CREATED} replaced=${REPLACED} skipped=${SKIPPED} warned=${WARNED}"

if [[ "${WARNED}" -gt 0 ]]; then
  exit 2
fi

if [[ "${DRY_RUN}" -eq 0 ]] && [[ "${KIOKU_SKIP_LOAD:-0}" != "1" ]]; then
  cat <<EOF

============================================================
次に確認できること
============================================================

  # 登録状態
  launchctl list | grep kioku

  # 詳細
  launchctl print gui/\$(id -u)/com.kioku.ingest | head -30

  # 即時実行 (デバッグ用)
  launchctl kickstart -k gui/\$(id -u)/com.kioku.ingest
  tail -f ~/kioku-ingest.log

次回の自動実行時刻 (ingest): 07:00 / 13:00 / 19:00
次回の自動実行時刻 (lint):   毎月 1 日 08:00

============================================================
EOF
fi
