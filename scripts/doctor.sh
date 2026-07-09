#!/usr/bin/env bash
#
# doctor.sh — KIOKU の状態を一括診断する read-only スクリプト
#
# codex roadmap (plan/codex/260430_kioku-product-improvement-roadmap.md §P0) に
# 基づき、Vault/Runtime/CLI/Hook config/MCP config/Metadata parity/Dependencies
# を網羅的にチェックして「何が動いていて、何が壊れているか」を即座に表示する。
#
# 使い方:
#   bash scripts/doctor.sh           # human-readable な出力 (default)
#   bash scripts/doctor.sh --json    # 機械 readable な JSON 出力
#   bash scripts/doctor.sh --quick   # quick-start check: 3 項目のみ・30 秒以内 (--json 併用可)
#
# Exit code:
#   0 = 全 ok
#   1 = 1 件以上の fail
#   2 = warn のみ (fail 無し)
#
# 採用方針:
#   - **Read-only only**: 何も変更しない。fix は Next actions として表示するだけ
#   - **macOS / Linux 両対応**: 純粋に shell + jq のみで完結し OS 依存な stat -f / -c は使わない
#   - **冪等**: 何度実行しても状態に応じて再現性のある出力
#   - **temp HOME / temp Vault で完結する test**: 実 HOME / 実 Vault に touch しない

set -euo pipefail

# -----------------------------------------------------------------------------
# Path resolution (REPO_ROOT は version metadata / mcp/ 検査に使う)
# -----------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CB_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"  # tools/claude-brain/

# -----------------------------------------------------------------------------
# Args
# -----------------------------------------------------------------------------
JSON_MODE=0
QUICK_MODE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON_MODE=1; shift ;;
    --quick) QUICK_MODE=1; shift ;;
    -h|--help)
      cat <<'USAGE'
KIOKU Doctor — 状態の一括診断 (read-only)

Usage:
  bash scripts/doctor.sh           Human-readable output (default)
  bash scripts/doctor.sh --json    Machine-readable JSON output
  bash scripts/doctor.sh --quick   Quick-start check: 3 items only, <30s (combinable with --json)

Exit codes:
  0  all ok
  1  one or more failed checks
  2  warnings only (no failures)
USAGE
      exit 0
      ;;
    *)
      echo "doctor: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

# -----------------------------------------------------------------------------
# Result accumulator
#
# bash 3.2 (macOS default) で動かすため、associative array は使わず parallel
# indexed array で持つ。`add_check id level msg [next_action]` で 1 件追加。
# -----------------------------------------------------------------------------
RESULT_IDS=()
RESULT_LEVELS=()
RESULT_MSGS=()
RESULT_NEXTS=()

OK_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

add_check() {
  local id="$1"
  local level="$2"
  local msg="$3"
  local next="${4:-}"

  case "${level}" in
    ok)   OK_COUNT=$((OK_COUNT + 1)) ;;
    warn) WARN_COUNT=$((WARN_COUNT + 1)) ;;
    fail) FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
    *) echo "doctor: invalid level: ${level}" >&2; exit 2 ;;
  esac

  RESULT_IDS+=("${id}")
  RESULT_LEVELS+=("${level}")
  RESULT_MSGS+=("${msg}")
  RESULT_NEXTS+=("${next}")
}

# -----------------------------------------------------------------------------
# JSON helpers
#
# user の config (~/.claude/settings.json 等) の inspect は jq に依存。jq が
# 無ければ該当 check は warn にする。
# -----------------------------------------------------------------------------
HAS_JQ=0
if command -v jq >/dev/null 2>&1; then
  HAS_JQ=1
fi

# json_string_contains FILE MARKER
#   FILE が JSON で、その serialize 結果 (キー + 値 + 構造) に MARKER
#   (substring) が含まれれば 0、無ければ 1。jq が無ければ 2。
#   `[.. | strings]` は値のみ traverse するため key (例: "kioku-wiki") を
#   見落とす。`tostring` で JSON 全体を 1 string として扱う方が安全
#   (keys+values 両方をカバー、JSON delimiter " : { が間に挟まるため
#   arbitrary substring 衝突の risk は実用上無視できる)。
json_string_contains() {
  local file="$1"
  local marker="$2"
  [[ -f "${file}" ]] || return 1
  [[ "${HAS_JQ}" -eq 1 ]] || return 2
  jq -e --arg m "${marker}" 'tostring | contains($m)' "${file}" >/dev/null 2>&1
}

# -----------------------------------------------------------------------------
# Section: Environment
# -----------------------------------------------------------------------------
check_environment() {
  # OBSIDIAN_VAULT が設定済か
  if [[ -n "${OBSIDIAN_VAULT:-}" ]]; then
    add_check "env-obsidian-vault" "ok" \
      "OBSIDIAN_VAULT is set: ${OBSIDIAN_VAULT}"
  else
    add_check "env-obsidian-vault" "fail" \
      "OBSIDIAN_VAULT is not set" \
      "export OBSIDIAN_VAULT=\"\$HOME/claude-brain/main-claude-brain\" in ~/.zshrc or ~/.bashrc"
    return 0
  fi

  # Vault directory が存在するか
  if [[ -d "${OBSIDIAN_VAULT}" ]]; then
    add_check "env-vault-dir" "ok" \
      "Vault directory exists: ${OBSIDIAN_VAULT}"
  else
    add_check "env-vault-dir" "fail" \
      "Vault directory does not exist: ${OBSIDIAN_VAULT}" \
      "bash scripts/setup-vault.sh"
    return 0
  fi

  # Vault が Git repo 配下か
  if git -C "${OBSIDIAN_VAULT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    add_check "env-vault-git" "ok" \
      "Vault is inside a Git working tree"
  else
    add_check "env-vault-git" "warn" \
      "Vault is not a Git repo (cross-machine sync via auto-commit/push will be skipped)" \
      "cd \"${OBSIDIAN_VAULT}\" && git init"
  fi

  # 4 dir (wiki/ session-logs/ raw-sources/ templates/) の存在
  local missing=()
  local dir
  for dir in wiki session-logs raw-sources templates; do
    if [[ ! -d "${OBSIDIAN_VAULT}/${dir}" ]]; then
      missing+=("${dir}")
    fi
  done
  if [[ ${#missing[@]} -eq 0 ]]; then
    add_check "env-vault-subdirs" "ok" \
      "Vault has wiki/ session-logs/ raw-sources/ templates/"
  else
    add_check "env-vault-subdirs" "fail" \
      "Vault missing required subdirs: ${missing[*]}" \
      "bash scripts/setup-vault.sh"
  fi

  # .gitignore に session-logs/ があるか
  local gi="${OBSIDIAN_VAULT}/.gitignore"
  if [[ -f "${gi}" ]] && grep -qE '^session-logs/?$' "${gi}"; then
    add_check "env-gitignore-session-logs" "ok" \
      ".gitignore excludes session-logs/"
  else
    add_check "env-gitignore-session-logs" "fail" \
      ".gitignore is missing 'session-logs/' (sensitive logs may be pushed to GitHub)" \
      "echo 'session-logs/' >> \"${OBSIDIAN_VAULT}/.gitignore\""
  fi

  # .gitignore に .cache/ があるか (auto-ingest manifest 用)
  if [[ -f "${gi}" ]] && grep -qE '^\.cache/?$' "${gi}"; then
    add_check "env-gitignore-cache" "ok" \
      ".gitignore excludes .cache/"
  else
    add_check "env-gitignore-cache" "warn" \
      ".gitignore is missing '.cache/' (auto-ingest manifest noise may be committed)" \
      "echo '.cache/' >> \"${OBSIDIAN_VAULT}/.gitignore\""
  fi
}

# -----------------------------------------------------------------------------
# Section: Runtime
# -----------------------------------------------------------------------------
check_runtime() {
  # Node version >= 18
  if command -v node >/dev/null 2>&1; then
    local node_version major
    node_version="$(node --version 2>/dev/null || echo "v0.0.0")"
    # v18.17.0 -> 18
    major="${node_version#v}"
    major="${major%%.*}"
    # 数値以外が入っていたら 0 にして fail に倒す
    if [[ ! "${major}" =~ ^[0-9]+$ ]]; then
      major=0
    fi
    if [[ "${major}" -ge 18 ]]; then
      add_check "runtime-node" "ok" \
        "Node ${node_version} (>= 18 required)"
    else
      add_check "runtime-node" "fail" \
        "Node ${node_version} is too old (>= 18 required)" \
        "Install Node 18+ via nvm / asdf / brew"
    fi
  else
    add_check "runtime-node" "fail" \
      "Node is not installed (required for hooks and MCP server)" \
      "Install Node 18+ via nvm / asdf / brew"
  fi

  # jq
  if [[ "${HAS_JQ}" -eq 1 ]]; then
    add_check "runtime-jq" "ok" \
      "jq is installed"
  else
    add_check "runtime-jq" "fail" \
      "jq is not installed (required for install-hooks*.sh --apply and config inspection)" \
      "brew install jq  # or: apt-get install jq"
  fi

  # poppler (pdfinfo / pdftotext)
  local poppler_missing=()
  command -v pdfinfo  >/dev/null 2>&1 || poppler_missing+=("pdfinfo")
  command -v pdftotext >/dev/null 2>&1 || poppler_missing+=("pdftotext")
  if [[ ${#poppler_missing[@]} -eq 0 ]]; then
    add_check "runtime-poppler" "ok" \
      "poppler tools installed (pdfinfo, pdftotext)"
  else
    add_check "runtime-poppler" "warn" \
      "poppler tools missing: ${poppler_missing[*]} (PDF ingest will be unavailable)" \
      "brew install poppler  # or: apt-get install poppler-utils"
  fi

  # qmd (optional but improves recall)
  if command -v qmd >/dev/null 2>&1; then
    add_check "runtime-qmd" "ok" \
      "qmd is installed (BM25 + vector search backend)"
  else
    add_check "runtime-qmd" "warn" \
      "qmd is not installed (Wiki search falls back to grep; recall is rough)" \
      "See https://github.com/megaphone-tokyo/qmd for installation"
  fi
}

# -----------------------------------------------------------------------------
# Section: CLI agents
# -----------------------------------------------------------------------------
check_cli_agents() {
  # claude (required for the primary use case)
  if command -v claude >/dev/null 2>&1; then
    add_check "cli-claude" "ok" \
      "claude CLI is installed"
  else
    add_check "cli-claude" "fail" \
      "claude CLI is not installed (Claude Code is the primary KIOKU client)" \
      "Install Claude Code: https://claude.com/product/claude-code"
  fi

  # codex (optional)
  if command -v codex >/dev/null 2>&1; then
    add_check "cli-codex" "ok" \
      "codex CLI is installed"
  else
    add_check "cli-codex" "warn" \
      "codex CLI is not installed (optional; install if you want Codex hook integration)" \
      "Install Codex CLI if you want multi-agent support"
  fi

  # gemini (optional)
  if command -v gemini >/dev/null 2>&1; then
    add_check "cli-gemini" "ok" \
      "gemini CLI is installed"
  else
    add_check "cli-gemini" "warn" \
      "gemini CLI is not installed (optional; install if you want Gemini hook integration)" \
      "Install Gemini CLI if you want multi-agent support"
  fi
}

# -----------------------------------------------------------------------------
# Section: Hook configs
#
# - Claude:  ~/.claude/settings.json   marker: "session-logger.mjs"
# - Codex:   ~/.codex/hooks.json       marker: "adapters/codex.mjs"
# - Gemini:  ~/.gemini/settings.json   marker: "claude-brain-"  (hook name prefix)
#
# 3 agent ともに「対応 CLI が install されている時のみ relevant」とみなす:
# CLI 不在なら "skip" 扱いにせず、"warn (CLI absent)" として 1 行残す
# (絶対 path を使う install-hooks-* と同じ pattern: CLI が無ければ Hook config
# は不要だが、user に状況を見せるため info line は出す)。
# -----------------------------------------------------------------------------
check_hook_configs() {
  local home="${HOME}"

  # Claude hook
  local claude_settings="${home}/.claude/settings.json"
  if ! command -v claude >/dev/null 2>&1; then
    add_check "hook-claude" "warn" \
      "claude CLI absent — skipping ~/.claude/settings.json hook check"
  elif [[ ! -f "${claude_settings}" ]]; then
    add_check "hook-claude" "fail" \
      "${claude_settings} does not exist" \
      "bash scripts/install/user/install-hooks.sh --apply"
  elif [[ "${HAS_JQ}" -ne 1 ]]; then
    add_check "hook-claude" "warn" \
      "jq not available; cannot inspect ${claude_settings}" \
      "brew install jq"
  elif json_string_contains "${claude_settings}" "session-logger.mjs"; then
    add_check "hook-claude" "ok" \
      "~/.claude/settings.json registers KIOKU session-logger hook"
  else
    add_check "hook-claude" "fail" \
      "~/.claude/settings.json does not register KIOKU session-logger hook" \
      "bash scripts/install/user/install-hooks.sh --apply"
  fi

  # Codex hook
  local codex_hooks="${home}/.codex/hooks.json"
  if ! command -v codex >/dev/null 2>&1; then
    add_check "hook-codex" "warn" \
      "codex CLI absent — skipping ~/.codex/hooks.json hook check"
  elif [[ ! -f "${codex_hooks}" ]]; then
    add_check "hook-codex" "fail" \
      "${codex_hooks} does not exist" \
      "bash scripts/install/user/install-hooks-codex.sh --apply"
  elif [[ "${HAS_JQ}" -ne 1 ]]; then
    add_check "hook-codex" "warn" \
      "jq not available; cannot inspect ${codex_hooks}" \
      "brew install jq"
  elif json_string_contains "${codex_hooks}" "adapters/codex.mjs"; then
    add_check "hook-codex" "ok" \
      "~/.codex/hooks.json registers KIOKU codex adapter hook"
  else
    add_check "hook-codex" "fail" \
      "~/.codex/hooks.json does not register KIOKU codex adapter" \
      "bash scripts/install/user/install-hooks-codex.sh --apply"
  fi

  # Gemini hook
  local gemini_settings="${home}/.gemini/settings.json"
  if ! command -v gemini >/dev/null 2>&1; then
    add_check "hook-gemini" "warn" \
      "gemini CLI absent — skipping ~/.gemini/settings.json hook check"
  elif [[ ! -f "${gemini_settings}" ]]; then
    add_check "hook-gemini" "fail" \
      "${gemini_settings} does not exist" \
      "bash scripts/install/user/install-hooks-gemini.sh --apply"
  elif [[ "${HAS_JQ}" -ne 1 ]]; then
    add_check "hook-gemini" "warn" \
      "jq not available; cannot inspect ${gemini_settings}" \
      "brew install jq"
  elif json_string_contains "${gemini_settings}" "claude-brain-"; then
    add_check "hook-gemini" "ok" \
      "~/.gemini/settings.json registers KIOKU gemini hooks"
  else
    add_check "hook-gemini" "fail" \
      "~/.gemini/settings.json does not register KIOKU gemini hooks" \
      "bash scripts/install/user/install-hooks-gemini.sh --apply"
  fi
}

# -----------------------------------------------------------------------------
# Section: MCP configs
#
# - Claude Desktop: ~/Library/Application Support/Claude/claude_desktop_config.json
#   (Linux なら ~/.config/Claude/... 等、絶対 path を使う install-mcp-client.sh と同じ default)
# - Codex:  ~/.codex/config.toml に [mcp_servers.kioku] block (TOML)
# - Gemini: ~/.gemini/settings.json の .mcpServers.kioku
# -----------------------------------------------------------------------------
check_mcp_configs() {
  local home="${HOME}"
  local uname_s
  uname_s="$(uname -s 2>/dev/null || echo unknown)"

  # Claude Desktop config (macOS / Linux で path が違う、Linux 側は heuristic)
  local claude_desktop_config
  if [[ "${uname_s}" == "Darwin" ]]; then
    claude_desktop_config="${home}/Library/Application Support/Claude/claude_desktop_config.json"
  else
    claude_desktop_config="${home}/.config/Claude/claude_desktop_config.json"
  fi
  # CLAUDE_DESKTOP_CONFIG env で override 可 (install-mcp-client.sh と同 pattern)
  if [[ -n "${CLAUDE_DESKTOP_CONFIG:-}" ]]; then
    claude_desktop_config="${CLAUDE_DESKTOP_CONFIG}"
  fi

  if [[ ! -f "${claude_desktop_config}" ]]; then
    add_check "mcp-claude-desktop" "warn" \
      "Claude Desktop config not found at ${claude_desktop_config} (Claude Desktop may not be installed)" \
      "bash scripts/install/internal/install-mcp-client.sh --apply  # if Claude Desktop is in use"
  elif [[ "${HAS_JQ}" -ne 1 ]]; then
    add_check "mcp-claude-desktop" "warn" \
      "jq not available; cannot inspect ${claude_desktop_config}"
  elif json_string_contains "${claude_desktop_config}" "kioku"; then
    add_check "mcp-claude-desktop" "ok" \
      "Claude Desktop config registers KIOKU MCP server"
  else
    add_check "mcp-claude-desktop" "fail" \
      "Claude Desktop config does not register KIOKU MCP server" \
      "bash scripts/install/internal/install-mcp-client.sh --apply"
  fi

  # Codex MCP (TOML, jq 不要)
  local codex_config="${home}/.codex/config.toml"
  if ! command -v codex >/dev/null 2>&1; then
    add_check "mcp-codex" "warn" \
      "codex CLI absent — skipping ~/.codex/config.toml MCP check"
  elif [[ ! -f "${codex_config}" ]]; then
    add_check "mcp-codex" "warn" \
      "${codex_config} does not exist (Codex MCP not configured)"
  elif grep -qE '^\[mcp_servers\.(kioku|"kioku|kioku-wiki|"kioku-wiki)' "${codex_config}"; then
    add_check "mcp-codex" "ok" \
      "Codex config.toml registers KIOKU MCP server"
  else
    add_check "mcp-codex" "warn" \
      "Codex config.toml does not register KIOKU MCP server" \
      "Add [mcp_servers.kioku] block to ~/.codex/config.toml"
  fi

  # Gemini MCP
  local gemini_settings="${home}/.gemini/settings.json"
  if ! command -v gemini >/dev/null 2>&1; then
    add_check "mcp-gemini" "warn" \
      "gemini CLI absent — skipping ~/.gemini/settings.json MCP check"
  elif [[ ! -f "${gemini_settings}" ]]; then
    add_check "mcp-gemini" "warn" \
      "${gemini_settings} does not exist (Gemini MCP not configured)"
  elif [[ "${HAS_JQ}" -ne 1 ]]; then
    add_check "mcp-gemini" "warn" \
      "jq not available; cannot inspect ${gemini_settings}"
  elif jq -e '.mcpServers // {} | has("kioku") or has("kioku-wiki")' \
        "${gemini_settings}" >/dev/null 2>&1; then
    add_check "mcp-gemini" "ok" \
      "Gemini settings registers KIOKU MCP server"
  else
    add_check "mcp-gemini" "warn" \
      "Gemini settings does not register KIOKU MCP server"
  fi
}

# -----------------------------------------------------------------------------
# Section: Metadata parity
#
# 4 file の version field が一致しているか:
#   mcp/package.json                        .version
#   mcp/manifest.json                       .version
#   .claude-plugin/plugin.json              .version
#   .claude-plugin/marketplace.json         .metadata.version (and .plugins[0].version)
# -----------------------------------------------------------------------------
check_metadata_parity() {
  if [[ "${HAS_JQ}" -ne 1 ]]; then
    add_check "metadata-version" "warn" \
      "jq not available; cannot verify metadata version parity" \
      "brew install jq"
    return 0
  fi

  local files=(
    "${CB_ROOT}/mcp/package.json"
    "${CB_ROOT}/mcp/manifest.json"
    "${CB_ROOT}/.claude-plugin/plugin.json"
    "${CB_ROOT}/.claude-plugin/marketplace.json"
  )

  local missing=()
  local f
  for f in "${files[@]}"; do
    [[ -f "${f}" ]] || missing+=("${f#${CB_ROOT}/}")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    add_check "metadata-files" "fail" \
      "Metadata files missing: ${missing[*]}"
    return 0
  fi

  local v_pkg v_man v_plugin v_market_meta v_market_plugin
  v_pkg="$(jq -r '.version // ""' "${CB_ROOT}/mcp/package.json" 2>/dev/null || echo "")"
  v_man="$(jq -r '.version // ""' "${CB_ROOT}/mcp/manifest.json" 2>/dev/null || echo "")"
  v_plugin="$(jq -r '.version // ""' "${CB_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || echo "")"
  v_market_meta="$(jq -r '.metadata.version // ""' "${CB_ROOT}/.claude-plugin/marketplace.json" 2>/dev/null || echo "")"
  v_market_plugin="$(jq -r '.plugins[0].version // ""' "${CB_ROOT}/.claude-plugin/marketplace.json" 2>/dev/null || echo "")"

  local empty=()
  [[ -n "${v_pkg}"           ]] || empty+=("mcp/package.json")
  [[ -n "${v_man}"           ]] || empty+=("mcp/manifest.json")
  [[ -n "${v_plugin}"        ]] || empty+=(".claude-plugin/plugin.json")
  [[ -n "${v_market_meta}"   ]] || empty+=(".claude-plugin/marketplace.json:.metadata.version")
  [[ -n "${v_market_plugin}" ]] || empty+=(".claude-plugin/marketplace.json:.plugins[0].version")
  if [[ ${#empty[@]} -gt 0 ]]; then
    add_check "metadata-version" "fail" \
      "Cannot read version from: ${empty[*]}"
    return 0
  fi

  if [[ "${v_pkg}" == "${v_man}" \
     && "${v_pkg}" == "${v_plugin}" \
     && "${v_pkg}" == "${v_market_meta}" \
     && "${v_pkg}" == "${v_market_plugin}" ]]; then
    add_check "metadata-version" "ok" \
      "All 4 metadata files report version ${v_pkg}"
  else
    add_check "metadata-version" "fail" \
      "Version drift: pkg=${v_pkg} manifest=${v_man} plugin=${v_plugin} marketplace.metadata=${v_market_meta} marketplace.plugins[0]=${v_market_plugin}" \
      "Bump all 5 fields together (release prep checklist)"
  fi
}

# -----------------------------------------------------------------------------
# Section: Sync state (Sprint 4 Phase 4 PR B4)
#
# Vault が Git repo 配下である前提で、cloud sync (auto push/pull) の 3 軸の
# 現在 state を表示する read-only diagnostic。retry queue file は
# `hooks/sync-vault.mjs` (PR A4) が write/update する schema を read-only で
# inspect する (write は一切しない)。
#
# - sync-last-commit    : `git log -1` の最新 commit timestamp
# - sync-pending-retry  : `.kioku-sync-retry.json` の有無 + retryCount + errorType
# - sync-network        : `github.com` reachability (curl --max-time 5、fail-fast)
#
# Vault が Git repo でない / OBSIDIAN_VAULT 未設定の場合は本 section を丸ごと
# skip して "warn" 1 行のみ残す (existing env-vault-git check が既に状態を
# 伝えているため重複を避ける)。
# -----------------------------------------------------------------------------
check_sync_state() {
  if [[ -z "${OBSIDIAN_VAULT:-}" ]] || [[ ! -d "${OBSIDIAN_VAULT}" ]]; then
    return 0
  fi
  if ! git -C "${OBSIDIAN_VAULT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    add_check "sync-state" "warn" \
      "Vault is not a Git repo — sync state diagnostic skipped"
    return 0
  fi

  # Last commit timestamp (auto-commit と user commit を区別しない、最終 push 候補時刻として活用)
  local last_commit_time
  last_commit_time="$(git -C "${OBSIDIAN_VAULT}" log -1 --format='%cI' 2>/dev/null || true)"
  if [[ -n "${last_commit_time}" ]]; then
    add_check "sync-last-commit" "ok" \
      "Last Vault commit: ${last_commit_time}"
  else
    add_check "sync-last-commit" "warn" \
      "Vault has no commits yet (first session not run?)"
  fi

  # Pending retry queue (.kioku-sync-retry.json) inspect
  # schema: { errorType, message, firstAttempt, lastAttempt, retryCount }
  local retry_queue="${OBSIDIAN_VAULT}/.kioku-sync-retry.json"
  if [[ ! -f "${retry_queue}" ]]; then
    add_check "sync-pending-retry" "ok" \
      "No pending sync retry"
  elif [[ "${HAS_JQ}" -eq 1 ]]; then
    local retry_count error_type first_attempt
    retry_count="$(jq -r '.retryCount // "?"' "${retry_queue}" 2>/dev/null || echo "?")"
    error_type="$(jq -r '.errorType // "unknown"' "${retry_queue}" 2>/dev/null || echo "unknown")"
    first_attempt="$(jq -r '.firstAttempt // ""' "${retry_queue}" 2>/dev/null || echo "")"
    local detail="${retry_count} attempts, last error: ${error_type}"
    if [[ -n "${first_attempt}" ]]; then
      detail="${detail}, since: ${first_attempt}"
    fi
    add_check "sync-pending-retry" "warn" \
      "Pending sync retry queue: ${detail}" \
      "Next Claude session will retry automatically (or run: node hooks/sync-vault.mjs --pull-and-retry)"
  else
    # jq 不在 fallback: file 存在のみ報告
    add_check "sync-pending-retry" "warn" \
      "Pending sync retry queue exists (install jq to inspect details)" \
      "brew install jq  # or: apt-get install jq"
  fi

  # Network reachability — github.com への HEAD-only probe (curl --max-time 5)
  # curl が無い環境では skip (warn)
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS --head --max-time 5 https://github.com >/dev/null 2>&1; then
      add_check "sync-network" "ok" \
        "Network: github.com reachable"
    else
      add_check "sync-network" "warn" \
        "Network: github.com unreachable (auto-sync will queue until reconnected)"
    fi
  else
    add_check "sync-network" "warn" \
      "curl not installed — cannot probe network reachability"
  fi
}

# -----------------------------------------------------------------------------
# Section: Auto-ingest state (Sprint 5 PR B5)
#
# Sprint 5 PR A5 で導入した auto-ingest retry queue + manual review queue を
# read-only で集約表示する。doctor.sh はユーザーが「最後に Wiki が更新されたのは
# いつか」「extract / LLM 失敗で retry を待っている file はあるか」「人手 review
# が必要な entry はあるか」を一目で把握できるようにする。
#
# 集約する 3 axis:
# - auto-ingest-last  : raw-sources/ 配下 .processed marker の最新 mtime
#                       (extract-pdf.sh / extract-epub.mjs / extract-docx.mjs
#                       が成功時に touch する規約 — 現状未定義の場合は
#                       wiki/summaries/ の最新 mtime で fallback)
# - auto-ingest-retry : .kioku-auto-ingest-retry.json の entries 件数 + 最新 errorType
# - auto-ingest-manual: .kioku-auto-ingest-manual-review.json の entries 件数
#
# Vault が存在しない / OBSIDIAN_VAULT 未設定の場合は本 section を丸ごと skip
# (existing env-vault check が既に状態を伝えている)。
# -----------------------------------------------------------------------------
check_auto_ingest_state() {
  if [[ -z "${OBSIDIAN_VAULT:-}" ]] || [[ ! -d "${OBSIDIAN_VAULT}" ]]; then
    return 0
  fi

  # axis 1: last successful auto-ingest 時刻
  # raw-sources/ 配下 .processed marker (extract-* 成功時に touch、現状は
  # extract scripts 側 PR で導入予定) → 無ければ wiki/summaries/ 最新 mtime fallback
  local last_marker_epoch=""
  if [[ -d "${OBSIDIAN_VAULT}/raw-sources" ]]; then
    last_marker_epoch="$(find "${OBSIDIAN_VAULT}/raw-sources" -name ".processed" -type f \
      -exec stat -f '%m' {} + 2>/dev/null | sort -rn | head -1 || true)"
  fi
  if [[ -z "${last_marker_epoch}" ]] && [[ -d "${OBSIDIAN_VAULT}/wiki/summaries" ]]; then
    last_marker_epoch="$(find "${OBSIDIAN_VAULT}/wiki/summaries" -type f -name "*.md" \
      -exec stat -f '%m' {} + 2>/dev/null | sort -rn | head -1 || true)"
  fi
  if [[ -n "${last_marker_epoch}" ]]; then
    local last_iso
    last_iso="$(date -r "${last_marker_epoch}" -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
      || date -u -d "@${last_marker_epoch}" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
      || echo "${last_marker_epoch}")"
    add_check "auto-ingest-last" "ok" \
      "Last auto-ingest activity: ${last_iso}"
  else
    # Both raw-sources/ markers and wiki/summaries/ are empty.
    # Treat as fresh-install state: silent (matches the auto-ingest-manual
    # convention of "absent = healthy default"). doctor.sh's existing
    # "no message = nothing to flag" convention preserves the EXIT-CODE-1 (all
    # ok) test expectation when wiki/summaries/ is empty.
    :
  fi

  # axis 2: pending retry queue
  local retry_queue="${OBSIDIAN_VAULT}/.kioku-auto-ingest-retry.json"
  if [[ ! -f "${retry_queue}" ]]; then
    add_check "auto-ingest-retry" "ok" \
      "No pending auto-ingest retry"
  elif [[ "${HAS_JQ}" -eq 1 ]]; then
    local entries_count last_error_type
    entries_count="$(jq -r '.entries | length' "${retry_queue}" 2>/dev/null || echo "?")"
    last_error_type="$(jq -r '.entries[-1].errorType // "unknown"' "${retry_queue}" 2>/dev/null || echo "unknown")"
    if [[ "${entries_count}" == "0" ]]; then
      add_check "auto-ingest-retry" "ok" \
        "No pending auto-ingest retry (queue file present but empty)"
    else
      add_check "auto-ingest-retry" "warn" \
        "Pending auto-ingest retry queue: ${entries_count} entries (latest error: ${last_error_type})" \
        "Next cron tick will retry. Inspect: cat \"\${OBSIDIAN_VAULT}/.kioku-auto-ingest-retry.json\""
    fi
  else
    # jq 不在 fallback: file 存在 + 行数で entries を粗く count
    local rough_count
    rough_count="$(grep -c '"errorType"' "${retry_queue}" 2>/dev/null | tr -d ' ' || echo "?")"
    add_check "auto-ingest-retry" "warn" \
      "Pending auto-ingest retry queue (~${rough_count} entries, install jq for detail)" \
      "brew install jq  # or: apt-get install jq"
  fi

  # axis 3: manual review queue (3 連敗 → human review 待ち)
  local manual_review="${OBSIDIAN_VAULT}/.kioku-auto-ingest-manual-review.json"
  if [[ ! -f "${manual_review}" ]]; then
    # absent = 健全 (entry 0 は default state)、ok 行は出さず silent
    :
  elif [[ "${HAS_JQ}" -eq 1 ]]; then
    local manual_count
    manual_count="$(jq -r '.entries | length' "${manual_review}" 2>/dev/null || echo "?")"
    if [[ "${manual_count}" == "0" ]]; then
      :
    else
      add_check "auto-ingest-manual" "fail" \
        "Manual review queue: ${manual_count} entries (3 retry failed, human action required)" \
        "Inspect: cat \"\${OBSIDIAN_VAULT}/.kioku-auto-ingest-manual-review.json\""
    fi
  else
    local manual_rough
    manual_rough="$(grep -c '"rawSource"' "${manual_review}" 2>/dev/null | tr -d ' ' || echo "?")"
    add_check "auto-ingest-manual" "fail" \
      "Manual review queue: ~${manual_rough} entries (3 retry failed, human action required, install jq for detail)" \
      "brew install jq"
  fi
}

# -----------------------------------------------------------------------------
# Section: Hook health (v0.11 S6-4 Layer 2)
#
# hooks (session-logger-core.mjs) は silent failure を errors.log に WARN として
# structured logging する (S6-4 Layer 1: 空 assistant_stop / transcript TOCTOU
# 縮小 / transcript 不達など)。doctor は「直近 window 行の WARN 件数」を集計し、
# 閾値以上なら warn を表示して hook の取りこぼしを可視化する。
#
# - window   : 直近 KIOKU_HOOK_WARN_WINDOW 行 (default 200) を tail で読む。
#              ISO timestamp の時刻 parse は BSD/GNU date 差異があるため
#              行数 window を採用 (OS 非依存)
# - threshold: KIOKU_HOOK_WARN_THRESHOLD (default 10)。以上で warn
# - errors.log 不在 = 健全 default → silent (auto-ingest-manual convention)
# - threshold 未満は ok 行で件数を表示 (観測性)
#
# default 値 (200 / 10) と env 変数名は hooks/wiki-context-injector.mjs の
# SessionStart 通知 (Layer 3) と共有する。drift すれば OBS-PARITY-1 test
# (tests/hooks/session-logger-observability.test.mjs) が検出する。
# -----------------------------------------------------------------------------
HOOK_WARN_WINDOW_DEFAULT=200
HOOK_WARN_THRESHOLD_DEFAULT=10

check_hook_health() {
  if [[ -z "${OBSIDIAN_VAULT:-}" ]] || [[ ! -d "${OBSIDIAN_VAULT}" ]]; then
    return 0
  fi

  local errors_log="${OBSIDIAN_VAULT}/session-logs/.claude-brain/errors.log"
  if [[ ! -f "${errors_log}" ]]; then
    # absent = 健全 (hook が一度も WARN/ERROR を出していない or hooks 未 install)。
    # silent (check_auto_ingest_state の "absent = healthy default" convention)
    return 0
  fi

  local window="${KIOKU_HOOK_WARN_WINDOW:-${HOOK_WARN_WINDOW_DEFAULT}}"
  local threshold="${KIOKU_HOOK_WARN_THRESHOLD:-${HOOK_WARN_THRESHOLD_DEFAULT}}"
  if [[ ! "${window}" =~ ^[0-9]+$ ]] || [[ "${window}" -eq 0 ]]; then
    window="${HOOK_WARN_WINDOW_DEFAULT}"
  fi
  if [[ ! "${threshold}" =~ ^[0-9]+$ ]] || [[ "${threshold}" -eq 0 ]]; then
    threshold="${HOOK_WARN_THRESHOLD_DEFAULT}"
  fi

  # `grep -c` は 0 件時に exit 1 を返す。pipefail 下で `|| echo` を使うと
  # "0\n?" の 2 行 capture になる罠があるため `|| true` + 後段 sanitize
  # (check_discoverqueries_state axis 2 の既知 pattern に倣う)
  local warn_count
  warn_count="$(tail -n "${window}" "${errors_log}" 2>/dev/null | grep -c 'WARN:' || true)"
  warn_count="$(printf '%s' "${warn_count}" | tr -d ' \n')"
  if [[ ! "${warn_count}" =~ ^[0-9]+$ ]]; then
    warn_count=0
  fi

  if [[ "${warn_count}" -ge "${threshold}" ]]; then
    add_check "hook-health" "warn" \
      "Hook errors.log: ${warn_count} WARN entries in last ${window} lines (>= threshold ${threshold} — hooks may be silently failing)" \
      "Inspect: tail -50 \"\${OBSIDIAN_VAULT}/session-logs/.claude-brain/errors.log\""
  elif [[ "${warn_count}" -gt 0 ]]; then
    add_check "hook-health" "ok" \
      "Hook errors.log: ${warn_count} WARN entries in last ${window} lines (below threshold ${threshold})"
  else
    add_check "hook-health" "ok" \
      "Hook errors.log: no WARN entries in last ${window} lines"
  fi
}

# -----------------------------------------------------------------------------
# Section: DiscoverQueries state (Sprint 5.5 PR B55)
#
# Sprint 5.5 PR A55 で導入した discoverQueries 8th source (session-logs/ scan
# dynamic learning) は、`.kioku-discoverqueries-usage.json` usage log に
# query → count を蓄積し、`.kioku-discoverqueries-opt-out` file でユーザーが
# 無効化できる。doctor.sh はユーザーが「dynamic learning は動いているか」
# 「opt-out 済か」「usage log は 64KB rotation 間際か」を一目で把握できる
# read-only diagnostic を提供する。
#
# 集約する 3 axis:
# - discoverqueries-optout : .kioku-discoverqueries-opt-out 存在 → warn
#                            (dynamic learning disabled、static 7 source のみ)。
#                            不在なら silent (= dynamic learning 有効が default)
# - discoverqueries-usage  : .kioku-discoverqueries-usage.json の entries 件数 +
#                            最終更新時刻 (= entries[].lastSeen の最大値。
#                            top-level lastUpdated key は production schema に
#                            無く、jq fallback `max(.entries[].lastSeen)` で
#                            算出)。不在 / empty は silent (fresh state)、
#                            entries>=1 は ok。jq 不在は grep ベース概数 fallback
# - discoverqueries-size   : usage log file size。64KB (USAGE_LOG_MAX_BYTES)
#                            未満は silent、超過は warn (FIFO rotation 動作示唆)。
#                            `wc -c` で OS 非依存 (BSD/GNU stat -f / -c 回避)
#
# opt-out enabled 時は usage / size axis を skip (dynamic learning disabled で
# usage log は無いか stale、noise 回避 — check_auto_ingest_state の
# "absent = silent" convention に倣う)。
#
# Vault が存在しない / OBSIDIAN_VAULT 未設定の場合は本 section を丸ごと skip
# (existing env-vault check が既に状態を伝えている)。
#
# DQ_USAGE_LOG_MAX_BYTES は mcp/lib/discoverqueries-learning.mjs の同名 export
# USAGE_LOG_MAX_BYTES (64 * 1024) と pin。drift すれば DQ-3 test が検出する。
# -----------------------------------------------------------------------------
DQ_USAGE_LOG_MAX_BYTES=$((64 * 1024))

check_discoverqueries_state() {
  if [[ -z "${OBSIDIAN_VAULT:-}" ]] || [[ ! -d "${OBSIDIAN_VAULT}" ]]; then
    return 0
  fi

  local optout_file="${OBSIDIAN_VAULT}/.kioku-discoverqueries-opt-out"
  local usage_log="${OBSIDIAN_VAULT}/.kioku-discoverqueries-usage.json"

  # axis 1: opt-out marker. Present → dynamic learning disabled (warn). When
  # opted out the usage / size axes are skipped (the log is absent or stale —
  # surfacing it would be misleading noise).
  if [[ -f "${optout_file}" ]]; then
    add_check "discoverqueries-optout" "warn" \
      "DiscoverQueries dynamic learning: opt-out enabled (static 7 source only)" \
      "Remove \"\${OBSIDIAN_VAULT}/.kioku-discoverqueries-opt-out\" to re-enable session-log learning"
    return 0
  fi

  # axis 4 (v0.11 S6-7): recency decay half-life. Mirrors the resolution in
  # mcp/lib/qmd-search-index.mjs resolveDqHalfLifeDays(): env
  # KIOKU_DQ_HALFLIFE_DAYS when a positive number, else default 14. Displayed
  # only when dynamic learning is enabled (opt-out early-returns above, where
  # the 8th source — and therefore decay — is skipped entirely).
  local dq_half_life="${KIOKU_DQ_HALFLIFE_DAYS:-14}"
  if [[ ! "${dq_half_life}" =~ ^[0-9]+([.][0-9]+)?$ ]] || [[ "${dq_half_life}" =~ ^0+([.]0+)?$ ]]; then
    dq_half_life=14
  fi
  add_check "discoverqueries-recency" "ok" \
    "DiscoverQueries recency boost: halfLife=${dq_half_life} days (decay active)"

  # axis 2: usage log entries count + last-update timestamp. The production
  # appendToUsageLog writes no top-level `lastUpdated` key — only per-entry
  # `lastSeen` — so the jq expression falls back to max(.entries[].lastSeen).
  if [[ ! -f "${usage_log}" ]]; then
    # absent = fresh state (no session-log learning has happened yet). Silent,
    # matching the auto-ingest-manual "absent = healthy default" convention so
    # the all-ok EXIT-CODE-1 expectation is preserved.
    :
  elif [[ "${HAS_JQ}" -eq 1 ]]; then
    local entries_count last_updated
    entries_count="$(jq -r '.entries | length' "${usage_log}" 2>/dev/null || echo "?")"
    last_updated="$(jq -r '.lastUpdated // (.entries | map(.lastSeen) | max) // ""' "${usage_log}" 2>/dev/null || echo "")"
    if [[ "${entries_count}" == "0" || "${entries_count}" == "?" ]]; then
      # empty / unreadable usage log → treat as fresh state, stay silent.
      :
    else
      local detail="usage log present, ${entries_count} queries learned"
      if [[ -n "${last_updated}" ]]; then
        detail="${detail}, last updated ${last_updated}"
      fi
      add_check "discoverqueries-usage" "ok" \
        "DiscoverQueries dynamic learning: active (${detail})"
    fi
  else
    # jq 不在 fallback: count usage-log entries roughly by "query" occurrences.
    # `grep -c` prints 0 yet exits 1 on no-match; under `set -o pipefail` that
    # exit 1 propagates across the pipe and would trip `|| echo "?"`, yielding a
    # corrupt 2-line "0\n?" capture that matches neither "0" nor "?" and falls
    # through to a bogus active line on an empty log. Capture pipefail-safe:
    # tolerate grep's non-zero exit, then strip whitespace/newlines separately.
    local rough_count
    rough_count="$(grep -c '"query"' "${usage_log}" 2>/dev/null || true)"
    rough_count="$(printf '%s' "${rough_count}" | tr -d ' \n')"
    [[ -z "${rough_count}" ]] && rough_count="?"
    if [[ "${rough_count}" == "0" || "${rough_count}" == "?" ]]; then
      :
    else
      add_check "discoverqueries-usage" "ok" \
        "DiscoverQueries dynamic learning: active (usage log present, ~${rough_count} queries learned, install jq for detail)"
    fi
  fi

  # axis 3: usage log size vs the 64KB privacy / FIFO-rotation cap. Uses
  # `wc -c` (OS-neutral) instead of stat -f / -c (BSD vs GNU divergence).
  if [[ -f "${usage_log}" ]]; then
    local log_bytes
    log_bytes="$(wc -c < "${usage_log}" 2>/dev/null | tr -d ' ' || echo "0")"
    if [[ ! "${log_bytes}" =~ ^[0-9]+$ ]]; then
      log_bytes=0
    fi
    if [[ "${log_bytes}" -gt "${DQ_USAGE_LOG_MAX_BYTES}" ]]; then
      local log_kb=$((log_bytes / 1024))
      add_check "discoverqueries-size" "warn" \
        "DiscoverQueries usage log near capacity: ${log_kb}KB (>64KB cap, FIFO rotation active — oldest queries are being dropped)" \
        "Expected behavior (64KB bound); no action needed unless query recall degrades"
    fi
  fi
}

# -----------------------------------------------------------------------------
# Section: Dependencies
# -----------------------------------------------------------------------------
check_dependencies() {
  # mcp/node_modules
  if [[ -d "${CB_ROOT}/mcp/node_modules" ]]; then
    add_check "deps-mcp-node-modules" "ok" \
      "mcp/node_modules/ is present"
  else
    add_check "deps-mcp-node-modules" "warn" \
      "mcp/node_modules/ is missing (MCP server will fail to start)" \
      "bash scripts/setup-mcp.sh"
  fi

  # scan-secrets.sh の existence (実行は重いので doctor では起動せず info だけ)
  if [[ -f "${CB_ROOT}/scripts/scan-secrets.sh" ]]; then
    add_check "deps-scan-secrets" "ok" \
      "scan-secrets.sh is present (run separately to audit Vault)"
  else
    add_check "deps-scan-secrets" "fail" \
      "scan-secrets.sh is missing from scripts/" \
      "Re-clone or re-install KIOKU"
  fi
}

# -----------------------------------------------------------------------------
# Section: Quick checks (v0.11 S6-6、--quick / quick-start-check)
#
# `--quick` は「KIOKU の quick start が成立しているか」を 30 秒以内・3 項目で
# 判定する軽量 view。新規 script は作らず doctor.sh 内の flag で実装する
# (doctor.sh = 健康判定の唯一 SSOT、meeting 26070701 UX 役条件)。
# full check との対応表は context/26-doctor.md §Quick check を参照。
#
# 3 check:
# - quick-session-log : session-logs/ に 24h 以内の *.md がある。Hook が実際に
#                       ログを出している「結果」の evidence check (full 側の
#                       hook-claude/codex/gemini は config 登録を見る「設定」check)
# - quick-wiki        : wiki/ に .md が 1 file 以上ある (ingest 済の evidence)
# - quick-mcp-config  : いずれかの MCP client config に kioku 登録がある。
#                       full 側 mcp-claude-desktop / mcp-codex / mcp-gemini の
#                       3 check を 1 行に集約 (config 検査のみ、実 server 起動なし)
#
# 制約 (30 秒以内保証): network probe (curl) / git 操作を含む check は --quick
# に含めない。24h 判定は find -mtime -1 (BSD/GNU 共通) を使い stat -f / -c は
# 使わない。OBSIDIAN_VAULT 未設定でも 3 項目とも必ず 1 行出す (常に 3 行 invariant)。
# -----------------------------------------------------------------------------
check_quick_session_log() {
  if [[ -z "${OBSIDIAN_VAULT:-}" ]]; then
    add_check "quick-session-log" "fail" \
      "OBSIDIAN_VAULT is not set — cannot check session-logs/" \
      "export OBSIDIAN_VAULT=\"\$HOME/claude-brain/main-claude-brain\" in ~/.zshrc or ~/.bashrc"
    return 0
  fi
  local logs_dir="${OBSIDIAN_VAULT}/session-logs"
  if [[ ! -d "${logs_dir}" ]]; then
    add_check "quick-session-log" "fail" \
      "session-logs/ does not exist under Vault" \
      "bash scripts/setup-vault.sh"
    return 0
  fi
  # -mtime -1 = 24h 未満に更新された file。head -1 で最初の hit で短絡する。
  # pipefail 下で head の早期 close が find に SIGPIPE を返しても || true で吸収
  local recent
  recent="$(find "${logs_dir}" -type f -name "*.md" -mtime -1 2>/dev/null | head -1 || true)"
  if [[ -n "${recent}" ]]; then
    add_check "quick-session-log" "ok" \
      "session-logs/ has a log written within 24h (hooks are producing logs)"
  else
    add_check "quick-session-log" "warn" \
      "session-logs/ has no log newer than 24h (no recent session, or hooks are not firing)" \
      "Run one Claude Code session, then re-run. If it persists: bash scripts/doctor.sh (full check)"
  fi
}

check_quick_wiki() {
  if [[ -z "${OBSIDIAN_VAULT:-}" ]]; then
    add_check "quick-wiki" "fail" \
      "OBSIDIAN_VAULT is not set — cannot check wiki/" \
      "export OBSIDIAN_VAULT=\"\$HOME/claude-brain/main-claude-brain\" in ~/.zshrc or ~/.bashrc"
    return 0
  fi
  local wiki_dir="${OBSIDIAN_VAULT}/wiki"
  if [[ ! -d "${wiki_dir}" ]]; then
    add_check "quick-wiki" "fail" \
      "wiki/ does not exist under Vault" \
      "bash scripts/setup-vault.sh"
    return 0
  fi
  local first_md
  first_md="$(find "${wiki_dir}" -type f -name "*.md" 2>/dev/null | head -1 || true)"
  if [[ -n "${first_md}" ]]; then
    add_check "quick-wiki" "ok" \
      "wiki/ has at least one .md (ingest has produced wiki content)"
  else
    add_check "quick-wiki" "warn" \
      "wiki/ has no .md yet (nothing ingested)" \
      "Ingest something: /wiki-ingest in Claude Code, or bash scripts/auto-ingest.sh"
  fi
}

check_quick_mcp_config() {
  local home="${HOME}"
  local uname_s
  uname_s="$(uname -s 2>/dev/null || echo unknown)"

  # Claude Desktop config path resolution は check_mcp_configs と同一
  # (CLAUDE_DESKTOP_CONFIG env override 含む) — 判定 marker も full 側と同じ
  # ものを使い、quick / full で健康表示が分裂しないようにする
  local claude_desktop_config
  if [[ "${uname_s}" == "Darwin" ]]; then
    claude_desktop_config="${home}/Library/Application Support/Claude/claude_desktop_config.json"
  else
    claude_desktop_config="${home}/.config/Claude/claude_desktop_config.json"
  fi
  if [[ -n "${CLAUDE_DESKTOP_CONFIG:-}" ]]; then
    claude_desktop_config="${CLAUDE_DESKTOP_CONFIG}"
  fi
  local codex_config="${home}/.codex/config.toml"
  local gemini_settings="${home}/.gemini/settings.json"

  local found="" candidates=0 jq_blocked=0

  if [[ -f "${claude_desktop_config}" ]]; then
    candidates=$((candidates + 1))
    if json_string_contains "${claude_desktop_config}" "kioku"; then
      found="Claude Desktop config"
    elif [[ "${HAS_JQ}" -ne 1 ]]; then
      jq_blocked=1
    fi
  fi
  if [[ -z "${found}" && -f "${codex_config}" ]]; then
    candidates=$((candidates + 1))
    if grep -qE '^\[mcp_servers\.(kioku|"kioku|kioku-wiki|"kioku-wiki)' "${codex_config}"; then
      found="Codex config.toml"
    fi
  fi
  if [[ -z "${found}" && -f "${gemini_settings}" ]]; then
    candidates=$((candidates + 1))
    if [[ "${HAS_JQ}" -eq 1 ]] && jq -e '.mcpServers // {} | has("kioku") or has("kioku-wiki")' \
        "${gemini_settings}" >/dev/null 2>&1; then
      found="Gemini settings"
    elif [[ "${HAS_JQ}" -ne 1 ]]; then
      jq_blocked=1
    fi
  fi

  if [[ -n "${found}" ]]; then
    add_check "quick-mcp-config" "ok" \
      "MCP config registers KIOKU: ${found} (config-level check; server not launched)"
  elif [[ "${jq_blocked}" -eq 1 ]]; then
    add_check "quick-mcp-config" "warn" \
      "jq not available; cannot inspect MCP client configs" \
      "brew install jq  # or: apt-get install jq"
  elif [[ "${candidates}" -eq 0 ]]; then
    add_check "quick-mcp-config" "warn" \
      "No MCP client config found (Claude Desktop / Codex / Gemini) — kioku_search is not reachable from any client" \
      "bash scripts/install/internal/install-mcp-client.sh --apply  # if Claude Desktop is in use"
  else
    add_check "quick-mcp-config" "fail" \
      "MCP client config(s) found but none registers KIOKU — kioku_search will not work" \
      "bash scripts/install/internal/install-mcp-client.sh --apply"
  fi
}

# -----------------------------------------------------------------------------
# Section: Install mode detection (derived from hook/MCP checks)
#
# 既存の hook-* / mcp-* check 結果を集約して、現在の install mode を判定する。
# Mode C (Full memory): MCP ok + Hooks ok    KIOKU 本来の使い方 (auto logging + sync)
# Mode A (MCP-only):    MCP ok + Hooks 無し  security-conscious / Claude Desktop 中心
# Unknown:              上記いずれでもない    partial install / first run
#
# Mode B (Read-only) は --read-only flag が install-mcp-client.sh に未実装の
# ため MVP では判定しない (acceptance criteria は Mode A / C 判定で満たす)。
# read-only flag 導入後に v0.7.x の iterative refine で追加予定。
# -----------------------------------------------------------------------------
INSTALL_MODE_LABEL=""
INSTALL_MODE_DETAIL=""

detect_install_mode() {
  local total=$((OK_COUNT + WARN_COUNT + FAIL_COUNT))
  local has_hooks_ok=0
  local has_mcp_ok=0
  local i=0
  while [[ $i -lt $total ]]; do
    local id="${RESULT_IDS[$i]}"
    local level="${RESULT_LEVELS[$i]}"
    case "${id}" in
      hook-claude|hook-codex|hook-gemini)
        [[ "${level}" == "ok" ]] && has_hooks_ok=1
        ;;
      mcp-claude-desktop|mcp-codex|mcp-gemini)
        [[ "${level}" == "ok" ]] && has_mcp_ok=1
        ;;
    esac
    i=$((i + 1))
  done

  local hooks_state mcp_state
  if [[ "${has_hooks_ok}" -eq 1 ]]; then hooks_state="ok"; else hooks_state="not registered"; fi
  if [[ "${has_mcp_ok}"   -eq 1 ]]; then mcp_state="ok";   else mcp_state="not registered"; fi

  if [[ "${has_mcp_ok}" -eq 1 && "${has_hooks_ok}" -eq 1 ]]; then
    INSTALL_MODE_LABEL="Mode C (Full memory)"
  elif [[ "${has_mcp_ok}" -eq 1 && "${has_hooks_ok}" -eq 0 ]]; then
    INSTALL_MODE_LABEL="Mode A (MCP-only)"
  else
    INSTALL_MODE_LABEL="Unknown / Partial install"
  fi
  INSTALL_MODE_DETAIL="MCP: ${mcp_state} / Hooks: ${hooks_state}"
}

# -----------------------------------------------------------------------------
# Output: text or JSON
# -----------------------------------------------------------------------------
print_text() {
  local total=$((OK_COUNT + WARN_COUNT + FAIL_COUNT))
  if [[ "${QUICK_MODE}" -eq 1 ]]; then
    echo "KIOKU Doctor (quick)"
  else
    echo "KIOKU Doctor"
  fi
  echo ""

  local i=0
  while [[ $i -lt $total ]]; do
    local level="${RESULT_LEVELS[$i]}"
    local msg="${RESULT_MSGS[$i]}"
    case "${level}" in
      ok)   printf '[ok]   %s\n' "${msg}" ;;
      warn) printf '[warn] %s\n' "${msg}" ;;
      fail) printf '[fail] %s\n' "${msg}" ;;
    esac
    i=$((i + 1))
  done

  echo ""
  printf 'Summary: %d ok / %d warn / %d fail\n' \
    "${OK_COUNT}" "${WARN_COUNT}" "${FAIL_COUNT}"

  # quick mode: full 診断への pointer を 1 行 (install mode 判定は quick では
  # 走らないため INSTALL_MODE_LABEL は空 = 下の [mode] block は出ない)
  if [[ "${QUICK_MODE}" -eq 1 ]]; then
    echo "Quick check only (3 items). Run 'bash scripts/doctor.sh' for the full diagnosis."
  fi

  # Install mode (derived view from hook/MCP checks)
  if [[ -n "${INSTALL_MODE_LABEL}" ]]; then
    printf '[mode] Current install mode: %s\n' "${INSTALL_MODE_LABEL}"
    printf '       %s\n' "${INSTALL_MODE_DETAIL}"
  fi

  # Next actions (warn/fail で next_action が空でないものを列挙、重複は除く)
  local actions_file
  actions_file="$(mktemp)"
  i=0
  while [[ $i -lt $total ]]; do
    local lvl="${RESULT_LEVELS[$i]}"
    local nxt="${RESULT_NEXTS[$i]}"
    if [[ "${lvl}" != "ok" && -n "${nxt}" ]]; then
      printf '%s\n' "${nxt}" >> "${actions_file}"
    fi
    i=$((i + 1))
  done
  if [[ -s "${actions_file}" ]]; then
    echo ""
    echo "Next actions:"
    # 重複除去 (出現順を保持)
    awk '!seen[$0]++' "${actions_file}" | while IFS= read -r line; do
      printf '  - %s\n' "${line}"
    done
  fi
  rm -f "${actions_file}"
}

print_json() {
  if [[ "${HAS_JQ}" -ne 1 ]]; then
    echo "doctor: --json requires jq" >&2
    return 2
  fi

  local total=$((OK_COUNT + WARN_COUNT + FAIL_COUNT))
  local buf
  buf="$(mktemp)"
  local i=0
  while [[ $i -lt $total ]]; do
    local id="${RESULT_IDS[$i]}"
    local level="${RESULT_LEVELS[$i]}"
    local msg="${RESULT_MSGS[$i]}"
    local nxt="${RESULT_NEXTS[$i]}"
    jq -nc \
      --arg id "${id}" \
      --arg level "${level}" \
      --arg message "${msg}" \
      --arg next_action "${nxt}" \
      '{id: $id, level: $level, message: $message}
       + (if $next_action == "" then {} else {next_action: $next_action} end)' \
      >> "${buf}"
    i=$((i + 1))
  done

  jq -s \
    --argjson ok "${OK_COUNT}" \
    --argjson warn "${WARN_COUNT}" \
    --argjson fail "${FAIL_COUNT}" \
    --arg install_mode "${INSTALL_MODE_LABEL}" \
    --arg install_mode_detail "${INSTALL_MODE_DETAIL}" \
    '{summary: {ok: $ok, warn: $warn, fail: $fail, install_mode: $install_mode, install_mode_detail: $install_mode_detail}, checks: .}' \
    "${buf}"
  rm -f "${buf}"
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
if [[ "${QUICK_MODE}" -eq 1 ]]; then
  # --quick: 3 check のみ (v0.11 S6-6)。network / git 操作を含む check は走らせ
  # ない (30 秒以内保証)。install mode 判定は hook-* / mcp-* check の結果に依存
  # するため quick では skip する (INSTALL_MODE_LABEL は空のまま)
  check_quick_session_log
  check_quick_wiki
  check_quick_mcp_config
else
  check_environment
  check_runtime
  check_cli_agents
  check_hook_configs
  check_mcp_configs
  check_metadata_parity
  check_dependencies
  check_sync_state
  check_auto_ingest_state
  check_hook_health
  check_discoverqueries_state
  detect_install_mode
fi

if [[ "${JSON_MODE}" -eq 1 ]]; then
  print_json
else
  print_text
fi

# Exit code: 1 if any fail, 2 if warn but no fail, else 0
if [[ "${FAIL_COUNT}" -gt 0 ]]; then
  exit 1
elif [[ "${WARN_COUNT}" -gt 0 ]]; then
  exit 2
fi
exit 0
