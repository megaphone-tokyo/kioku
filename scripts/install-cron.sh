#!/usr/bin/env bash
#
# install-cron.sh — DEPRECATED shim (v0.11 S6-5 で scripts/install/internal/ へ移動)
#
# 旧 path 互換のため v0.11-v0.12 の 2 release 期間このまま維持し、その後削除予定。
# 本体は scripts/install/internal/install-cron.sh — 引数はそのまま透過する。

set -euo pipefail

SHIM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# S6-5: shim も security primitive の SSOT を source する
# (validate_vault_path 等が古いまま動く期間を作らない、plan 26070601 §4.5)
source "${SHIM_DIR}/lib/install-common.sh"

echo "[DEPRECATED] scripts/install-cron.sh moved to scripts/install/internal/install-cron.sh (this shim will be removed after v0.12)" >&2

exec bash "${SHIM_DIR}/install/internal/install-cron.sh" "$@"
