#!/usr/bin/env bash
#
# setup-mcp.sh — KIOKU MCP サーバーの依存セットアップ (Phase M)
#
# tools/claude-brain/mcp/ 配下に @modelcontextprotocol/sdk を npm install する。
# 親リポは package.json を持たない方針なので、mcp/ サブディレクトリ単独で完結する。
#
# 終了コード:
#   0  正常終了 (既に install 済みでもこちらに帰る)
#   1  node 不在 / バージョン不足 / npm 不在
#
# 使い方:
#   bash tools/claude-brain/scripts/setup-mcp.sh             # 実 install
#   bash tools/claude-brain/scripts/setup-mcp.sh --dry-run   # 確認のみ
#
# アンインストール:
#   rm -rf tools/claude-brain/mcp/node_modules

set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: ${arg}" >&2
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MCP_DIR="$(cd "${SCRIPT_DIR}/../mcp" && pwd)"

echo "setup-mcp: mcp dir = ${MCP_DIR}"

# -----------------------------------------------------------------------------
# 前提チェック
# -----------------------------------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
  {
    printf '%s\n' 'ERROR: node not found in PATH.'
    printf '%s\n' ''
    printf '%s\n' 'Install Node.js 18+ first (any of):'
    printf '%s\n' ''
    printf '%s\n' '  brew install node            # Homebrew'
    printf '%s\n' '  mise use -g node@22          # mise'
    printf '%s\n' '  volta install node           # Volta'
    printf '%s\n' ''
    printf '%s\n' 'Reference: https://nodejs.org/'
  } >&2
  exit 1
fi

NODE_VERSION="$(node --version 2>/dev/null | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [[ ! "${NODE_MAJOR}" =~ ^[0-9]+$ ]] || [[ "${NODE_MAJOR}" -lt 18 ]]; then
  echo "ERROR: Node 18+ required (found: ${NODE_VERSION})" >&2
  exit 1
fi
echo "setup-mcp: node = $(command -v node) (v${NODE_VERSION})"

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found in PATH" >&2
  exit 1
fi

if [[ ! -f "${MCP_DIR}/package.json" ]]; then
  echo "ERROR: ${MCP_DIR}/package.json not found" >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# install
# -----------------------------------------------------------------------------

if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "[dry-run] cd ${MCP_DIR} && npm install --omit=dev --no-audit --no-fund"
  echo "[dry-run] (no changes made)"
  exit 0
fi

if [[ -d "${MCP_DIR}/node_modules/@modelcontextprotocol/sdk" ]]; then
  SDK_VERSION="$(node -p "require('${MCP_DIR}/node_modules/@modelcontextprotocol/sdk/package.json').version" 2>/dev/null || echo unknown)"
  echo "setup-mcp: [skip] @modelcontextprotocol/sdk ${SDK_VERSION} already installed"
else
  echo "setup-mcp: [install] running npm install..."
  (cd "${MCP_DIR}" && npm install --omit=dev --no-audit --no-fund)
  SDK_VERSION="$(node -p "require('${MCP_DIR}/node_modules/@modelcontextprotocol/sdk/package.json').version" 2>/dev/null || echo unknown)"
  echo "setup-mcp: [done] @modelcontextprotocol/sdk ${SDK_VERSION}"
fi

cat <<EOF

============================================================
完了。次に Claude Desktop / Claude Code に kioku MCP を登録してください
============================================================

  bash tools/claude-brain/scripts/install-mcp-client.sh --dry-run   # 確認
  bash tools/claude-brain/scripts/install-mcp-client.sh --apply     # 登録

EOF
