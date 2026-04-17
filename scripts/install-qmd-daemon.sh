#!/usr/bin/env bash
#
# 0 Phase J: qmd MCP デーモンの launchd 登録
#
# qmd MCP サーバー (HTTP モード) を macOS launchd で常駐化する。
# Mac 再起動後も Claude Code から qmd MCP ツールが利用できる状態を維持する。
#
# 配置先: ~/Library/LaunchAgents/com.kioku.qmd-mcp.plist
#
# 環境変数:
#   QMD_MCP_PORT  リッスンポート (既定 8181)
#
# 終了コード:
#   0  正常終了
#   1  qmd コマンドが PATH にない / launchctl が存在しない (非 macOS)
#
# アンインストール:
#   launchctl unload ~/Library/LaunchAgents/com.kioku.qmd-mcp.plist
#   rm ~/Library/LaunchAgents/com.kioku.qmd-mcp.plist

set -euo pipefail

LABEL="com.kioku.qmd-mcp"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${PLIST_DIR}/${LABEL}.plist"
PORT="${QMD_MCP_PORT:-8181}"

# NEW-003: ポート番号のバリデーション (XML インジェクション防止)
if [[ ! "${PORT}" =~ ^[0-9]+$ ]] || [[ "${PORT}" -lt 1024 ]] || [[ "${PORT}" -gt 65535 ]]; then
  echo "ERROR: QMD_MCP_PORT must be a number between 1024 and 65535 (got: ${PORT})" >&2
  exit 1
fi

# cron や非対話シェルからも qmd を見つけられるよう PATH を補完する。
# (mise / volta が ~/.zshrc 経由でしか activate されない構成にも対応)
#
# 重要: mise shims を Volta より **前** に置く。qmd は mise の Node に対して
# native module (better-sqlite3) をビルドしているため、Volta 上の別バージョンの
# Node が PATH 先頭にあると ABI mismatch でクラッシュする。
export PATH="${HOME}/.local/share/mise/shims:${HOME}/.volta/bin:${HOME}/.local/bin:${HOME}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"

# -----------------------------------------------------------------------------
# 前提チェック
# -----------------------------------------------------------------------------

if ! command -v qmd >/dev/null 2>&1; then
  cat >&2 <<'EOF'
ERROR: qmd command not found in PATH.

Install qmd first (any of):

  npm install -g @tobilu/qmd       # Volta / system Node
  mise use -g npm:@tobilu/qmd      # mise

Reference: https://github.com/tobi/qmd
EOF
  exit 1
fi

if ! command -v launchctl >/dev/null 2>&1; then
  echo "ERROR: launchctl not found. This script targets macOS only." >&2
  exit 1
fi

# 重要: mise / volta の shim (~/.local/share/mise/shims/qmd 等) は単一バイナリへの
# hardlink で、argv[0] の basename を見て dispatch する。`readlink -f` で実体パスに
# 解決すると basename が "mise" / "volta" になり qmd を起動できなくなるため、
# command -v が返す **shim パスのまま** plist に埋める。launchd は親シェル無しで
# 絶対パスを exec するが、shim 自体が dispatch 情報を持っているので問題ない。
QMD_BIN="$(command -v qmd)"

# R4-002: QMD_BIN パスのバリデーション (XML インジェクション防止)
safe_re='^[a-zA-Z0-9/._[:space:]-]+$'
if [[ ! "${QMD_BIN}" =~ $safe_re ]]; then
  echo "ERROR: qmd path contains unsafe characters: ${QMD_BIN}" >&2
  exit 1
fi

echo "============================================================"
echo "KIOKU: qmd MCP デーモンの launchd 登録"
echo "============================================================"
echo "  Label      = ${LABEL}"
echo "  Plist      = ${PLIST_PATH}"
echo "  qmd binary = ${QMD_BIN}"
echo "  Port       = ${PORT}"
echo ""

mkdir -p "${PLIST_DIR}"
mkdir -p "${HOME}/.local/log"

# -----------------------------------------------------------------------------
# 既存のデーモンが動いていれば一旦 unload (冪等性確保)
# -----------------------------------------------------------------------------

if [[ -f "${PLIST_PATH}" ]]; then
  echo "[unload] existing plist found, unloading first..."
  launchctl unload "${PLIST_PATH}" 2>/dev/null || true
fi

# -----------------------------------------------------------------------------
# plist 生成
# -----------------------------------------------------------------------------

cat > "${PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${QMD_BIN}</string>
        <string>mcp</string>
        <string>--http</string>
        <string>--host</string>
        <string>127.0.0.1</string>
        <string>--port</string>
        <string>${PORT}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>PATH</key>
        <string>${HOME}/.local/share/mise/shims:${HOME}/.volta/bin:${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${HOME}/.local/log/qmd-mcp.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/.local/log/qmd-mcp.err</string>
</dict>
</plist>
EOF

echo "[written] ${PLIST_PATH}"

# -----------------------------------------------------------------------------
# launchctl load
# -----------------------------------------------------------------------------

if launchctl load "${PLIST_PATH}" 2>/dev/null; then
  echo "[loaded] launchctl load succeeded"
else
  echo "[warn] launchctl load failed; you can re-run manually:"
  echo "       launchctl load ${PLIST_PATH}"
fi

# -----------------------------------------------------------------------------
# MCP 設定の案内
# -----------------------------------------------------------------------------

cat <<EOF

============================================================
完了。次に Claude Code に qmd MCP サーバーを登録してください
============================================================

以下のコマンドを実行 (ユーザースコープに登録):

  claude mcp add --scope user --transport http qmd http://localhost:${PORT}/mcp

確認:

  claude mcp list | grep qmd
  # => qmd: http://localhost:${PORT}/mcp (HTTP) - ✓ Connected

備考:
- Claude Code CLI の正典設定ファイルは ~/.claude.json です
  (~/.claude/settings.json や VSCode の "claude.mcpServers" は
   現在の Claude Code では読まれません。手で編集しないこと)
- VSCode 拡張版 Claude Code も同じ ~/.claude.json を読むので、
  拡張側で別途登録する必要はありません。再起動のみ必要です

動作確認:
  # サーバー疎通
  curl -s http://localhost:${PORT}/mcp >/dev/null && echo OK || echo NG

  # ログ
  tail -f ~/.local/log/qmd-mcp.log ~/.local/log/qmd-mcp.err

アンインストール:
  launchctl unload ${PLIST_PATH}
  rm ${PLIST_PATH}
EOF
