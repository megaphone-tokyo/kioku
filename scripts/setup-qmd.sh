#!/usr/bin/env bash
#
# setup-qmd.sh — claude-brain Phase J: qmd Wiki 検索セットアップ
#
# Vault 配下の wiki / raw-sources / session-logs を qmd のコレクションとして登録し、
# 初回 BM25 インデックス + ベクトル埋め込みを生成する。MCP サーバーの起動は
# install-qmd-daemon.sh が担当する。
#
# 環境変数:
#   OBSIDIAN_VAULT  Vault ルート (未設定時は $HOME/claude-brain/main-claude-brain)
#   KIOKU_QMD_SKIP_EMBED=1  ベクトル埋め込み生成をスキップ (テスト用)
#
# 終了コード:
#   0  正常終了 (既にコレクション登録済みでも 0)
#   1  Vault 不在 / qmd コマンドが PATH にない
#
# qmd のインストール:
#   npm install -g @tobilu/qmd
#   (このスクリプトは自動インストールしない。事前に手動で導入すること)

set -euo pipefail

LOG_PREFIX="[setup-qmd $(date +%Y%m%d-%H%M)]"

# NEW-008: --include-logs フラグで brain-logs コレクション登録を opt-in にする
INCLUDE_LOGS=0
for arg in "$@"; do
  case "${arg}" in
    --include-logs) INCLUDE_LOGS=1 ;;
    -h|--help)
      echo "Usage: bash setup-qmd.sh [--include-logs]"
      echo "  --include-logs  Register session-logs/ as a qmd collection (opt-in)"
      exit 0
      ;;
  esac
done

OBSIDIAN_VAULT="${OBSIDIAN_VAULT:-${HOME}/claude-brain/main-claude-brain}"

# R4-001: OBSIDIAN_VAULT のバリデーション
validate_vault_path() {
  local p="$1"
  local safe_re='^[a-zA-Z0-9/._[:space:]-]+$'
  if [[ ! "${p}" =~ $safe_re ]]; then
    echo "${LOG_PREFIX} ERROR: OBSIDIAN_VAULT contains unsafe characters: ${p}" >&2
    exit 1
  fi
}
validate_vault_path "${OBSIDIAN_VAULT}"

# cron や非対話シェルからも qmd を見つけられるよう、mise shims / Volta を補完する。
#
# 重要: ~/.local/share/mise/shims を ~/.volta/bin より **前** に置く。
# qmd は mise の Node 22 に native module (better-sqlite3) をビルドしているため、
# Volta の別バージョンの Node が PATH 先頭にあると ABI mismatch でクラッシュする
# (NODE_MODULE_VERSION 127 vs 141 等)。
# mise shim は親 PATH 上の `node` をそのまま使う実装なので、PATH 順で吸収する。
export PATH="${HOME}/.local/share/mise/shims:${HOME}/.volta/bin:${HOME}/.local/bin:${HOME}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"

# -----------------------------------------------------------------------------
# 前提チェック
# -----------------------------------------------------------------------------

if [[ ! -d "${OBSIDIAN_VAULT}" ]]; then
  echo "${LOG_PREFIX} ERROR: OBSIDIAN_VAULT not found: ${OBSIDIAN_VAULT}" >&2
  exit 1
fi

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

echo "============================================================"
echo "${LOG_PREFIX} qmd Wiki 検索セットアップ"
echo "============================================================"
echo "  OBSIDIAN_VAULT = ${OBSIDIAN_VAULT}"
echo "  qmd            = $(command -v qmd)"
echo "  qmd version    = $(qmd --version 2>/dev/null || echo 'unknown')"
echo ""

# -----------------------------------------------------------------------------
# コレクション登録 (冪等)
#
# qmd collection add は既存コレクションに対して非 0 exit する可能性があるため、
# `|| true` で吸収する。2 回目以降の実行でも同じ最終状態に収束する。
# -----------------------------------------------------------------------------

add_collection() {
  local path="$1"
  local name="$2"

  if [[ ! -d "${path}" ]]; then
    echo "${LOG_PREFIX} [skip] ${name}: directory not found (${path})"
    return 0
  fi

  # qmd 2.1.0 はデフォルトで `**/*.md` パターンで取り込むため --mask は不要。
  if qmd collection add "${path}" --name "${name}" >/dev/null 2>&1; then
    echo "${LOG_PREFIX} [added] ${name} -> ${path}"
  else
    echo "${LOG_PREFIX} [exists] ${name} (already registered or add failed; treated as idempotent)"
  fi
}

echo "--- コレクション登録 ---"
add_collection "${OBSIDIAN_VAULT}/wiki"         "brain-wiki"
add_collection "${OBSIDIAN_VAULT}/raw-sources"  "brain-sources"
if [[ "${INCLUDE_LOGS}" == "1" ]]; then
  add_collection "${OBSIDIAN_VAULT}/session-logs" "brain-logs"
else
  echo "${LOG_PREFIX} [skip] brain-logs: session-logs/ の登録はデフォルトで無効です (--include-logs で有効化)"
fi

# -----------------------------------------------------------------------------
# コンテキスト追加 (検索精度向上のためのコレクション説明)
# -----------------------------------------------------------------------------

echo ""
echo "--- コンテキスト追加 ---"
qmd context add qmd://brain-wiki    "LLM Wiki ナレッジベース: 設計判断、概念、パターン、バグ解決策、プロジェクト情報" >/dev/null 2>&1 || true
qmd context add qmd://brain-sources "生素材: 記事、書籍メモ、トランスクリプト、アイデア"                               >/dev/null 2>&1 || true
if [[ "${INCLUDE_LOGS}" == "1" ]]; then
  qmd context add qmd://brain-logs    "Claude Code セッションログ: 作業記録、コマンド履歴"                              >/dev/null 2>&1 || true
fi
echo "${LOG_PREFIX} context registered (or already present)"

# -----------------------------------------------------------------------------
# 初回インデックス生成
# -----------------------------------------------------------------------------

echo ""
echo "--- BM25 インデックス更新 ---"
qmd update >/dev/null 2>&1 || echo "${LOG_PREFIX} [warn] qmd update failed (continuing)"

if [[ "${KIOKU_QMD_SKIP_EMBED:-0}" == "1" ]]; then
  echo "${LOG_PREFIX} KIOKU_QMD_SKIP_EMBED=1 -> skipping qmd embed"
else
  echo ""
  echo "--- ベクトル埋め込み生成 ---"
  echo "${LOG_PREFIX} 初回は GGUF モデルのダウンロードに数分かかります..."
  qmd embed >/dev/null 2>&1 || echo "${LOG_PREFIX} [warn] qmd embed failed; run 'qmd embed' manually later"
fi

# -----------------------------------------------------------------------------
# サマリ
# -----------------------------------------------------------------------------

echo ""
echo "============================================================"
echo "${LOG_PREFIX} セットアップ完了"
echo "============================================================"
echo ""
echo "登録済みコレクション:"
qmd collection list 2>/dev/null || echo "  (qmd collection list failed)"
echo ""
echo "次のステップ:"
echo "  1. MCP デーモンを起動: bash $(dirname "$0")/install-qmd-daemon.sh"
echo "  2. ~/.claude/settings.json に qmd MCP サーバー設定を追加"
echo "     (install-qmd-daemon.sh が完了時に出力する設定例を参照)"
echo "  3. 動作確認: qmd query \"設計判断\""
