#!/usr/bin/env bash
#
# install-mcp-client.sh — Claude Desktop / Claude Code に kioku-wiki MCP を登録 (Phase M)
#
# 既定動作 (無引数 / --dry-run): 設定スニペットを stdout に出すだけ (書き込まない)
# --apply  : Desktop の claude_desktop_config.json に jq で idempotent merge
# --uninstall: Desktop config から "kioku-wiki" を削除
#
# 環境変数:
#   OBSIDIAN_VAULT          Vault ルート (必須)
#   CLAUDE_DESKTOP_CONFIG   書き込み先 (既定 ~/Library/Application Support/Claude/claude_desktop_config.json)
#   KIOKU_NODE_BIN          Desktop が呼ぶ node の絶対パス (既定 command -v node)
#   ASSUME_YES=1            --apply の確認プロンプトをスキップ
#
# 終了コード:
#   0  正常終了
#   1  必須環境変数不足 / バリデーション失敗
#   2  jq 不在 / JSON 破損 / ユーザー abort

set -euo pipefail

MODE="dry-run"
ASSUME_YES="${ASSUME_YES:-0}"
for arg in "$@"; do
  case "${arg}" in
    --apply) MODE="apply" ;;
    --dry-run) MODE="dry-run" ;;
    --uninstall) MODE="uninstall" ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      printf 'ERROR: unknown argument: %s\n' "${arg}" >&2
      exit 1
      ;;
  esac
done

# -----------------------------------------------------------------------------
# 前提
# -----------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
MCP_DIR="${REPO_ROOT}/tools/claude-brain/mcp"
SERVER_ABS="${MCP_DIR}/server.mjs"
TEMPLATE_PATH="${REPO_ROOT}/tools/claude-brain/templates/mcp/claude_desktop_config.json.template"

if [[ ! -f "${SERVER_ABS}" ]]; then
  printf 'ERROR: server not found at %s\n' "${SERVER_ABS}" >&2
  exit 1
fi

if [[ ! -f "${TEMPLATE_PATH}" ]]; then
  printf 'ERROR: template not found at %s\n' "${TEMPLATE_PATH}" >&2
  exit 1
fi

OBSIDIAN_VAULT="${OBSIDIAN_VAULT:-}"
if [[ -z "${OBSIDIAN_VAULT}" ]]; then
  printf 'ERROR: OBSIDIAN_VAULT is required\n' >&2
  exit 1
fi

validate_vault_path() {
  local p="$1"
  local safe_re='^[a-zA-Z0-9/._[:space:]-]+$'
  if [[ ! "${p}" =~ ${safe_re} ]]; then
    printf 'ERROR: OBSIDIAN_VAULT contains unsafe characters: %s\n' "${p}" >&2
    exit 1
  fi
}
validate_vault_path "${OBSIDIAN_VAULT}"

NODE_BIN="${KIOKU_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [[ -z "${NODE_BIN}" ]]; then
  printf 'ERROR: node not found in PATH (set KIOKU_NODE_BIN to absolute path)\n' >&2
  exit 1
fi

CONFIG_PATH="${CLAUDE_DESKTOP_CONFIG:-${HOME}/Library/Application Support/Claude/claude_desktop_config.json}"

# -----------------------------------------------------------------------------
# テンプレ展開 (sed | 区切り、置換後残存チェック)
# -----------------------------------------------------------------------------

TMPWORK="$(mktemp -d)"
trap 'rm -rf "${TMPWORK}"' EXIT

SNIPPET="${TMPWORK}/snippet.json"
sed \
  -e "s|__NODE_BIN__|${NODE_BIN}|g" \
  -e "s|__SERVER_PATH__|${SERVER_ABS}|g" \
  -e "s|__OBSIDIAN_VAULT__|${OBSIDIAN_VAULT}|g" \
  "${TEMPLATE_PATH}" > "${SNIPPET}"

if grep -q '__[A-Z_]*__' "${SNIPPET}"; then
  printf 'ERROR: unresolved placeholders in snippet:\n' >&2
  grep -o '__[A-Z_]*__' "${SNIPPET}" >&2 || true
  exit 1
fi

# -----------------------------------------------------------------------------
# 案内出力 (Claude Code は手動で `claude mcp add` を打ってもらう)
# -----------------------------------------------------------------------------

print_claude_code_instructions() {
  cat <<EOF

------------------------------------------------------------
Claude Code (CLI / VSCode 拡張) 用の登録コマンド:

  claude mcp add --scope user --transport stdio kioku \\
    "${NODE_BIN}" "${SERVER_ABS}"

確認:
  claude mcp list | grep kioku

備考: Claude Code は OBSIDIAN_VAULT を親プロセスから継承するため、
      シェル起動時に ~/.zshrc 等で export していれば追加設定不要です。
------------------------------------------------------------
EOF
}

# -----------------------------------------------------------------------------
# モード分岐
# -----------------------------------------------------------------------------

case "${MODE}" in
  dry-run)
    printf '== Snippet (preview, NOT applied) ==\n'
    cat "${SNIPPET}"
    printf '\nTarget Desktop config: %s\n' "${CONFIG_PATH}"
    if [[ -f "${CONFIG_PATH}" ]]; then
      printf 'Status: already exists. Run with --apply to merge "kioku-wiki" key.\n'
    else
      printf 'Status: file does not exist. Run with --apply to create it.\n'
    fi
    print_claude_code_instructions
    exit 0
    ;;

  uninstall)
    if ! command -v jq >/dev/null 2>&1; then
      printf 'ERROR: jq is required for --uninstall\n' >&2
      exit 2
    fi
    if [[ ! -f "${CONFIG_PATH}" ]]; then
      printf '[skip] %s does not exist\n' "${CONFIG_PATH}"
      exit 0
    fi
    if ! jq -e . "${CONFIG_PATH}" >/dev/null 2>&1; then
      printf 'ERROR: %s is not valid JSON. Refusing to touch.\n' "${CONFIG_PATH}" >&2
      exit 2
    fi
    BACKUP="${CONFIG_PATH}.bak.$(date +%Y%m%d-%H%M%S)"
    cp "${CONFIG_PATH}" "${BACKUP}"
    NEXT="${TMPWORK}/next.json"
    jq 'if has("mcpServers") then .mcpServers |= del(."kioku-wiki") else . end' \
      "${CONFIG_PATH}" > "${NEXT}"
    if ! jq -e . "${NEXT}" >/dev/null 2>&1; then
      printf 'ERROR: jq output not valid JSON. Backup at %s\n' "${BACKUP}" >&2
      exit 2
    fi
    mv "${NEXT}" "${CONFIG_PATH}"
    printf '[removed] kioku-wiki from %s\n' "${CONFIG_PATH}"
    printf 'backup:   %s\n' "${BACKUP}"
    printf 'NOTE: restart Claude Desktop for the change to take effect.\n'
    exit 0
    ;;

  apply)
    if ! command -v jq >/dev/null 2>&1; then
      printf 'ERROR: jq is required for --apply\n' >&2
      exit 2
    fi
    mkdir -p "$(dirname "${CONFIG_PATH}")"
    if [[ ! -f "${CONFIG_PATH}" ]]; then
      printf '{}\n' > "${CONFIG_PATH}"
      printf '[create] %s (was empty)\n' "${CONFIG_PATH}"
    fi
    if ! jq -e . "${CONFIG_PATH}" >/dev/null 2>&1; then
      printf 'ERROR: %s is not valid JSON. Refusing to touch.\n' "${CONFIG_PATH}" >&2
      exit 2
    fi

    BACKUP="${CONFIG_PATH}.bak.$(date +%Y%m%d-%H%M%S)"
    cp "${CONFIG_PATH}" "${BACKUP}"

    MERGED="${TMPWORK}/merged.json"
    # 既存 mcpServers を保ったまま kioku-wiki キーを上書き (idempotent)
    jq --slurpfile snip "${SNIPPET}" '
      .mcpServers = ((.mcpServers // {}) + ($snip[0].mcpServers))
    ' "${CONFIG_PATH}" > "${MERGED}"

    if ! jq -e . "${MERGED}" >/dev/null 2>&1; then
      printf 'ERROR: merge output not valid JSON. Backup kept at %s\n' "${BACKUP}" >&2
      exit 2
    fi

    printf '== diff (old → new) ==\n'
    diff -u "${CONFIG_PATH}" "${MERGED}" || true
    printf '======================\n'
    printf 'target: %s\n' "${CONFIG_PATH}"
    printf 'backup: %s\n' "${BACKUP}"

    if [[ "${ASSUME_YES}" != "1" ]]; then
      printf 'Apply this change? [y/N] '
      read -r reply
      case "${reply}" in
        y|Y|yes|YES) ;;
        *)
          printf 'aborted. backup left at %s\n' "${BACKUP}"
          exit 2
          ;;
      esac
    fi

    mv "${MERGED}" "${CONFIG_PATH}"
    printf '[applied] %s\n' "${CONFIG_PATH}"
    printf 'rollback: mv "%s" "%s"\n' "${BACKUP}" "${CONFIG_PATH}"
    print_claude_code_instructions
    printf '\nNOTE: restart Claude Desktop for the change to take effect.\n'
    exit 0
    ;;
esac
