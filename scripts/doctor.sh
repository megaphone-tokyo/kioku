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
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON_MODE=1; shift ;;
    -h|--help)
      cat <<'USAGE'
KIOKU Doctor — 状態の一括診断 (read-only)

Usage:
  bash scripts/doctor.sh           Human-readable output (default)
  bash scripts/doctor.sh --json    Machine-readable JSON output

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
      "bash scripts/install-hooks.sh --apply"
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
      "bash scripts/install-hooks.sh --apply"
  fi

  # Codex hook
  local codex_hooks="${home}/.codex/hooks.json"
  if ! command -v codex >/dev/null 2>&1; then
    add_check "hook-codex" "warn" \
      "codex CLI absent — skipping ~/.codex/hooks.json hook check"
  elif [[ ! -f "${codex_hooks}" ]]; then
    add_check "hook-codex" "fail" \
      "${codex_hooks} does not exist" \
      "bash scripts/install-hooks-codex.sh --apply"
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
      "bash scripts/install-hooks-codex.sh --apply"
  fi

  # Gemini hook
  local gemini_settings="${home}/.gemini/settings.json"
  if ! command -v gemini >/dev/null 2>&1; then
    add_check "hook-gemini" "warn" \
      "gemini CLI absent — skipping ~/.gemini/settings.json hook check"
  elif [[ ! -f "${gemini_settings}" ]]; then
    add_check "hook-gemini" "fail" \
      "${gemini_settings} does not exist" \
      "bash scripts/install-hooks-gemini.sh --apply"
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
      "bash scripts/install-hooks-gemini.sh --apply"
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
      "bash scripts/install-mcp-client.sh --apply  # if Claude Desktop is in use"
  elif [[ "${HAS_JQ}" -ne 1 ]]; then
    add_check "mcp-claude-desktop" "warn" \
      "jq not available; cannot inspect ${claude_desktop_config}"
  elif json_string_contains "${claude_desktop_config}" "kioku"; then
    add_check "mcp-claude-desktop" "ok" \
      "Claude Desktop config registers KIOKU MCP server"
  else
    add_check "mcp-claude-desktop" "fail" \
      "Claude Desktop config does not register KIOKU MCP server" \
      "bash scripts/install-mcp-client.sh --apply"
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
  echo "KIOKU Doctor"
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
check_environment
check_runtime
check_cli_agents
check_hook_configs
check_mcp_configs
check_metadata_parity
check_dependencies
detect_install_mode

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
