#!/usr/bin/env bash
#
# install-cron.sh — KIOKU 用 cron エントリを出力する (Phase F + G)
#
# install-hooks.sh と同じく、手動でマージすべき設定を stdout に出す。
# crontab 自体は書き換えない (非破壊)。
#
# 使い方:
#   bash scripts/install-cron.sh
#
# 出力された行を `crontab -e` で手動追記する。

set -euo pipefail

# R4-001: OBSIDIAN_VAULT のバリデーション
validate_vault_path() {
  local p="$1"
  local safe_re='^[a-zA-Z0-9/._[:space:]-]+$'
  if [[ ! "${p}" =~ $safe_re ]]; then
    echo "ERROR: OBSIDIAN_VAULT contains unsafe characters: ${p}" >&2
    exit 1
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AUTO_INGEST_ABS="${SCRIPT_DIR}/auto-ingest.sh"
AUTO_LINT_ABS="${SCRIPT_DIR}/auto-lint.sh"

if [[ ! -f "${AUTO_INGEST_ABS}" ]]; then
  echo "ERROR: auto-ingest.sh not found at ${AUTO_INGEST_ABS}" >&2
  exit 1
fi

if [[ ! -f "${AUTO_LINT_ABS}" ]]; then
  echo "ERROR: auto-lint.sh not found at ${AUTO_LINT_ABS}" >&2
  exit 1
fi

VAULT_DEFAULT="${OBSIDIAN_VAULT:-${HOME}/kioku/main-KIOKU}"
validate_vault_path "${VAULT_DEFAULT}"

cat <<EOF
============================================================
KIOKU 自動化 — cron 設定
============================================================

以下のコマンドで crontab を編集してください:

  crontab -e

以下の行を追加 (パスはすでに絶対パスに展開済み):

  # KIOKU: 毎日朝7時に自動 Ingest
  0 7 * * * ${AUTO_INGEST_ABS} >> "\$HOME/kioku-ingest.log" 2>&1

  # KIOKU: 毎月1日 朝8時に自動 Lint
  0 8 1 * * ${AUTO_LINT_ABS} >> "\$HOME/kioku-lint.log" 2>&1

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
