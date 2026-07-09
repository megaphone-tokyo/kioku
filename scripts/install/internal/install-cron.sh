#!/usr/bin/env bash
#
# install-cron.sh — claude-brain 用 cron エントリを出力 / 適用する (Phase F + G、v0.11 S6-2)
#
# 使い方:
#   bash tools/claude-brain/scripts/install/internal/install-cron.sh           # stdout に設定を出力 (非破壊、従来挙動)
#   bash tools/claude-brain/scripts/install/internal/install-cron.sh --apply   # crontab へ冪等マージ (dedup + backup)
#
# --apply なし: install-hooks.sh と同じく、手動でマージすべき設定を stdout に出す。
#               crontab 自体は書き換えない (非破壊)。出力された行を `crontab -e` で手動追記する。
# --apply あり: `crontab -l` の現状から自 script (auto-ingest.sh / auto-lint.sh) の既存 entry と
#               marker comment を除去 (dedup) → 新 entry を追記 → `crontab -` で書き戻す。
#               2 回実行しても重複 entry を作らない (冪等)。書き戻し前に backup を保存し、
#               失敗時は backup から復元する (rollback)。

set -euo pipefail

# --apply 経路の structured log (stderr へ ERROR prefix + [install-cron] scope を統一 format で出す)
log_info() { echo "[install-cron] $*"; }
log_error() { echo "ERROR: [install-cron] $*" >&2; }

usage() {
  echo "usage: bash install-cron.sh [--apply]" >&2
  echo "  (no flag)  print cron entries to stdout for manual merge (non-destructive)" >&2
  echo "  --apply    idempotently merge entries into the user's crontab (dedup + backup + rollback)" >&2
}

APPLY_MODE=0
for arg in "$@"; do
  case "${arg}" in
    --apply) APPLY_MODE=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      log_error "unknown argument: ${arg}"
      usage
      exit 2
      ;;
  esac
done

# R4-001: OBSIDIAN_VAULT のバリデーション (validate_vault_path は lib/install-common.sh の SSOT、PR S6-1)
source "$(dirname "${BASH_SOURCE[0]}")/../../lib/install-common.sh"

# S6-5: 本 script は scripts/install/internal/ 配下 (scripts root は 2 つ上)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
AUTO_INGEST_ABS="${SCRIPTS_ROOT}/auto-ingest.sh"
AUTO_LINT_ABS="${SCRIPTS_ROOT}/auto-lint.sh"

if [[ ! -f "${AUTO_INGEST_ABS}" ]]; then
  echo "ERROR: auto-ingest.sh not found at ${AUTO_INGEST_ABS}" >&2
  exit 1
fi

if [[ ! -f "${AUTO_LINT_ABS}" ]]; then
  echo "ERROR: auto-lint.sh not found at ${AUTO_LINT_ABS}" >&2
  exit 1
fi

VAULT_DEFAULT="${OBSIDIAN_VAULT:-${HOME}/claude-brain/main-claude-brain}"
validate_vault_path "${VAULT_DEFAULT}"

# -----------------------------------------------------------------------------
# cron entry の単一定義 (stdout 出力 mode と --apply mode で共有、drift 防止)。
# entry 内の $HOME は crontab 側の shell に展開させるため literal のまま持つ。
# -----------------------------------------------------------------------------
CRON_COMMENT_INGEST="# claude-brain: 毎日朝7時に自動 Ingest"
CRON_ENTRY_INGEST="0 7 * * * ${AUTO_INGEST_ABS} >> \"\$HOME/kioku-ingest.log\" 2>&1"
CRON_COMMENT_LINT="# claude-brain: 毎月1日 朝8時に自動 Lint"
CRON_ENTRY_LINT="0 8 1 * * ${AUTO_LINT_ABS} >> \"\$HOME/kioku-lint.log\" 2>&1"

# -----------------------------------------------------------------------------
# --apply: crontab への冪等マージ
#
# 手順:
#   1. `crontab -l` で現状を取得し、書き戻し前に backup として保存 (rollback 用)
#   2. 自 SCRIPT_PATH (auto-ingest.sh / auto-lint.sh) を含む行と自 marker comment 行を
#      `grep -vF` で除去 (dedup。2 回実行しても重複 entry を作らない)
#   3. 新 entry 4 行 (comment 2 + entry 2) を末尾に追記
#   4. `crontab -` で書き戻し。失敗時は backup から復元し exit 1
#
# 注意: crontab 未登録 user では backup は空 file になる。この状態で rollback すると
# 「crontab なし」ではなく「空 crontab」に復元されるが、実効的な差はない。
# -----------------------------------------------------------------------------
apply_crontab() {
  if ! command -v crontab >/dev/null 2>&1; then
    log_error "crontab command not found in PATH; cannot --apply"
    exit 2
  fi

  # 1. 現状取得 + backup (crontab 未登録なら空 backup。backup は rollback 用に削除しない)
  local backup
  backup="$(mktemp "${TMPDIR:-/tmp}/crontab.bak.XXXXXX")"
  if ! crontab -l > "${backup}" 2>/dev/null; then
    : # crontab 未登録 (no crontab for user) は空 backup として扱う
  fi

  local current
  current="$(cat "${backup}")"

  # 2. dedup: 自 script path を含む行 + 自 marker comment 行 (完全一致) を除去。
  #    grep -vF は「選択行 0 件」で exit 1 を返すため || true で吸収する。
  local filtered=""
  if [[ -n "${current}" ]]; then
    filtered="$(
      printf '%s\n' "${current}" \
        | grep -vF -- "${AUTO_INGEST_ABS}" \
        | grep -vF -- "${AUTO_LINT_ABS}" \
        | grep -vFx -- "${CRON_COMMENT_INGEST}" \
        | grep -vFx -- "${CRON_COMMENT_LINT}" \
        || true
    )"
  fi

  # 3. 新しい crontab 内容を組み立て (既存の無関係 entry → claude-brain entry の順)
  local new_file
  new_file="$(mktemp "${TMPDIR:-/tmp}/crontab.new.XXXXXX")"
  {
    if [[ -n "${filtered}" ]]; then
      printf '%s\n' "${filtered}"
    fi
    printf '%s\n' "${CRON_COMMENT_INGEST}"
    printf '%s\n' "${CRON_ENTRY_INGEST}"
    printf '%s\n' "${CRON_COMMENT_LINT}"
    printf '%s\n' "${CRON_ENTRY_LINT}"
  } > "${new_file}"

  log_info "crontab diff (current -> new):"
  diff -u "${backup}" "${new_file}" || true

  # 4. `crontab -` で書き戻し。失敗時は backup から復元 (rollback)
  local rc=0
  crontab - < "${new_file}" || rc=$?
  if [[ "${rc}" -ne 0 ]]; then
    log_error "crontab write-back failed (exit=${rc}); rolling back from ${backup}"
    local rollback_rc=0
    crontab "${backup}" || rollback_rc=$?
    if [[ "${rollback_rc}" -ne 0 ]]; then
      log_error "rollback also failed (exit=${rollback_rc}); manual restore: crontab ${backup}"
    else
      log_info "rollback succeeded; crontab restored from backup"
    fi
    rm -f "${new_file}"
    exit 1
  fi

  rm -f "${new_file}"
  log_info "applied claude-brain cron entries (idempotent; existing duplicates removed)"
  log_info "  ${CRON_ENTRY_INGEST}"
  log_info "  ${CRON_ENTRY_LINT}"
  log_info "backup: ${backup}"
  log_info "to rollback: crontab ${backup}"
}

if [[ "${APPLY_MODE}" -eq 1 ]]; then
  apply_crontab
  exit 0
fi

cat <<EOF
============================================================
claude-brain 自動化 — cron 設定
============================================================

以下のコマンドで crontab を編集してください:

  crontab -e

以下の行を追加 (パスはすでに絶対パスに展開済み):

  ${CRON_COMMENT_INGEST}
  ${CRON_ENTRY_INGEST}

  ${CRON_COMMENT_LINT}
  ${CRON_ENTRY_LINT}

============================================================
事前確認
============================================================

1. claude -p が動作するか確認:
     claude -p "hello" --output-format json

2. OBSIDIAN_VAULT のデフォルト値:
     ${VAULT_DEFAULT}
   異なる場合は、cron 行の先頭で指定してください:
     0 7 * * * OBSIDIAN_VAULT="/path/to/vault" ${AUTO_INGEST_ABS} >> ...

3. DRY RUN で動作確認:
     KIOKU_DRY_RUN=1 ${AUTO_INGEST_ABS}
     KIOKU_DRY_RUN=1 ${AUTO_LINT_ABS}

============================================================
2 台運用での競合回避
============================================================

Mac mini など 2 台目で cron を設定する場合、git 競合を避けるため
実行時刻をずらしてください。推奨:

  MacBook  — Ingest 7:00 / Lint 毎月1日 8:00
  Mac mini — Ingest 7:30 / Lint 毎月2日 8:00

============================================================
Lint レポートの確認方法
============================================================

自動 Lint は修正を行いません。レポートのみ生成します。
Obsidian で wiki/lint-report.md を開いて内容を確認し、
修正が必要な項目は手動で対応してください。

============================================================
EOF
