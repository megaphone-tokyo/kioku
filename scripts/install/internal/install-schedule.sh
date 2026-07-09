#!/usr/bin/env bash
#
# install-schedule.sh — claude-brain 定期実行セットアップの OS 分岐 dispatcher (Phase L)
#
# macOS では install-launchagents.sh を、Linux/WSL/BSD では install-cron.sh を呼ぶ。
# uname -s で判定するだけの薄いラッパー (YAGNI)。
#
# Usage:
#   bash install-schedule.sh [args]
#
# 引数はそのまま下位スクリプトに transparent に渡される。
# 例:
#   bash install-schedule.sh --dry-run
#   bash install-schedule.sh --force       (macOS 時のみ有効)
#   bash install-schedule.sh --uninstall   (macOS 時のみ有効)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

case "$(uname -s)" in
  Darwin)
    exec bash "${SCRIPT_DIR}/install-launchagents.sh" "$@"
    ;;
  Linux|*BSD|CYGWIN*|MINGW*|MSYS*)
    exec bash "${SCRIPT_DIR}/install-cron.sh" "$@"
    ;;
  *)
    echo "ERROR: unsupported OS: $(uname -s)" >&2
    echo "       Supported: Darwin (macOS) / Linux / *BSD / WSL / Cygwin" >&2
    exit 1
    ;;
esac
