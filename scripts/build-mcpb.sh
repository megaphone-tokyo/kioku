#!/usr/bin/env bash
#
# build-mcpb.sh — KIOKU MCP サーバーを .mcpb バンドルにパッケージ化する (Phase N)
#
# 公式 CLI `@anthropic-ai/mcpb` を npx 経由で起動し、tools/claude-brain/mcp/ を
# Claude Desktop 用の単一ファイル .mcpb にまとめる。
#
# 出力:
#   tools/claude-brain/mcp/dist/kioku-wiki-<version>.mcpb
#
# 終了コード:
#   0  正常終了 / DRY RUN 完了
#   1  node 不在 / バージョン不足 / npm 不在 / mcpb pack 失敗
#
# 使い方:
#   bash tools/claude-brain/scripts/build-mcpb.sh             # 実ビルド
#   bash tools/claude-brain/scripts/build-mcpb.sh --dry-run   # staging 構築まで (pack はしない)
#   bash tools/claude-brain/scripts/build-mcpb.sh --validate  # mcpb validate のみ
#   bash tools/claude-brain/scripts/build-mcpb.sh --clean     # build/ と dist/ を削除して終了
#
# 参考:
#   - mcp-server-dev:build-mcpb skill (公式)
#   - manifest schema: https://raw.githubusercontent.com/anthropics/mcpb/main/schemas/mcpb-manifest-v0.4.schema.json

set -euo pipefail

DRY_RUN=0
VALIDATE_ONLY=0
CLEAN_ONLY=0
for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY_RUN=1 ;;
    --validate) VALIDATE_ONLY=1 ;;
    --clean) CLEAN_ONLY=1 ;;
    -h|--help)
      sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
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
BUILD_DIR="${MCP_DIR}/build"
STAGING_DIR="${BUILD_DIR}/staging"
DIST_DIR="${MCP_DIR}/dist"
MANIFEST_SRC="${MCP_DIR}/manifest.json"

echo "build-mcpb: mcp dir = ${MCP_DIR}"

# -----------------------------------------------------------------------------
# --clean: build/ と dist/ を削除して終了
# -----------------------------------------------------------------------------

if [[ "${CLEAN_ONLY}" -eq 1 ]]; then
  rm -rf "${BUILD_DIR}" "${DIST_DIR}"
  echo "build-mcpb: [clean] removed ${BUILD_DIR} and ${DIST_DIR}"
  exit 0
fi

# -----------------------------------------------------------------------------
# 前提チェック
# -----------------------------------------------------------------------------

if [[ ! -f "${MANIFEST_SRC}" ]]; then
  echo "ERROR: manifest.json not found at ${MANIFEST_SRC}" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found in PATH (Node 18+ required)" >&2
  exit 1
fi

NODE_VERSION="$(node --version 2>/dev/null | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [[ ! "${NODE_MAJOR}" =~ ^[0-9]+$ ]] || [[ "${NODE_MAJOR}" -lt 18 ]]; then
  echo "ERROR: Node 18+ required (found: ${NODE_VERSION})" >&2
  exit 1
fi
echo "build-mcpb: node = $(command -v node) (v${NODE_VERSION})"

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found in PATH" >&2
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "ERROR: npx not found in PATH" >&2
  exit 1
fi

# manifest version (jq があれば抽出、なければ node で fallback)
if command -v jq >/dev/null 2>&1; then
  MANIFEST_VERSION="$(jq -r '.version' "${MANIFEST_SRC}")"
else
  MANIFEST_VERSION="$(node -p "require('${MANIFEST_SRC}').version")"
fi
echo "build-mcpb: manifest version = ${MANIFEST_VERSION}"

# -----------------------------------------------------------------------------
# --validate: manifest だけ検証して終了
# -----------------------------------------------------------------------------

if [[ "${VALIDATE_ONLY}" -eq 1 ]]; then
  echo "build-mcpb: [validate] running mcpb validate..."
  (cd "${MCP_DIR}" && npx --yes @anthropic-ai/mcpb validate manifest.json)
  echo "build-mcpb: [validate] OK"
  exit 0
fi

# -----------------------------------------------------------------------------
# staging を作る
# -----------------------------------------------------------------------------

echo "build-mcpb: [stage] cleaning ${STAGING_DIR}"
rm -rf "${STAGING_DIR}"
mkdir -p "${STAGING_DIR}/server"

echo "build-mcpb: [stage] copying manifest"
cp "${MANIFEST_SRC}" "${STAGING_DIR}/manifest.json"

# 同梱対象は server コードと package メタのみ。テスト/ビルド成果物は持ち込まない。
echo "build-mcpb: [stage] copying server code"
cp "${MCP_DIR}/server.mjs" "${STAGING_DIR}/server/server.mjs"
cp "${MCP_DIR}/package.json" "${STAGING_DIR}/server/package.json"
if [[ -f "${MCP_DIR}/package-lock.json" ]]; then
  cp "${MCP_DIR}/package-lock.json" "${STAGING_DIR}/server/package-lock.json"
fi
cp -R "${MCP_DIR}/lib" "${STAGING_DIR}/server/lib"
cp -R "${MCP_DIR}/tools" "${STAGING_DIR}/server/tools"

# tools/ 配下に開発時のゴミ (例: 空のサブディレクトリ tools/claude-brain/) があれば
# .mjs ファイル以外を staging から落とす。
find "${STAGING_DIR}/server/tools" -mindepth 1 -type d -empty -delete 2>/dev/null || true

# 2026-04-20 v0.3.3 fix (機能 2.1 以降の長期バグ): MCP tool `kioku_ingest_pdf` は
# `scripts/extract-pdf.sh` を spawn するが (ingest-pdf.mjs 内で
# `join(__dirname, '..', '..', 'scripts', 'extract-pdf.sh')` に resolve)、
# v0.2.0/v0.3.0/v0.3.1/v0.3.2 の .mcpb bundle にこの shell script が含まれて
# いなかったため、Claude Desktop 経由で kioku_ingest_pdf を叩くと rc=127 で
# 失敗していた (dev 時は parent repo 直パスで解決するので dogfooding でも
# 検出できなかった)。staging のルートに scripts/ を配置することで
# server/tools/ingest-pdf.mjs から `../../scripts/extract-pdf.sh` が正しく解決する。
#
# 同梱対象:
#   - extract-pdf.sh        : kioku_ingest_pdf が spawn (必須)
#   - mask-text.mjs         : extract-pdf.sh が Node CLI として呼ぶ (必須)
#   - lib/masking.mjs       : mask-text.mjs が import (必須)
#   - extract-url.sh        : 将来 MCP-side から spawn する可能性あり (現状 cron 専用だが念のため)
#   - auto-ingest.sh / auto-lint.sh / setup-*.sh / install-*.sh 等の cron/setup 系:
#     MCP から spawn されない → 除外する (余計な配布物を減らす)
echo "build-mcpb: [stage] copying MCP-invoked scripts (extract-pdf.sh + deps)"
mkdir -p "${STAGING_DIR}/scripts"
cp "${SCRIPT_DIR}/extract-pdf.sh" "${STAGING_DIR}/scripts/extract-pdf.sh"
cp "${SCRIPT_DIR}/mask-text.mjs" "${STAGING_DIR}/scripts/mask-text.mjs"
cp "${SCRIPT_DIR}/extract-url.sh" "${STAGING_DIR}/scripts/extract-url.sh"
cp -R "${SCRIPT_DIR}/lib" "${STAGING_DIR}/scripts/lib"
# 実行権限を明示 (cp -p だとテスト環境の uid 違いで失敗しうるので chmod で確定)
chmod 0755 "${STAGING_DIR}/scripts/extract-pdf.sh"
chmod 0755 "${STAGING_DIR}/scripts/extract-url.sh"

# -----------------------------------------------------------------------------
# staging で本番依存を install (lock ファイルが揃っていれば npm ci、無ければ npm install)
# -----------------------------------------------------------------------------

echo "build-mcpb: [stage] installing production dependencies into staging"
if [[ -f "${STAGING_DIR}/server/package-lock.json" ]]; then
  (cd "${STAGING_DIR}/server" && npm ci --omit=dev --no-audit --no-fund --silent)
else
  (cd "${STAGING_DIR}/server" && npm install --omit=dev --no-audit --no-fund --silent)
fi

# -----------------------------------------------------------------------------
# --dry-run: pack せずに staging だけ確認
# -----------------------------------------------------------------------------

if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo ""
  echo "build-mcpb: [dry-run] staging built at ${STAGING_DIR}"
  echo "build-mcpb: [dry-run] would run: npx --yes @anthropic-ai/mcpb pack"
  echo ""
  echo "staging tree (top-level):"
  find "${STAGING_DIR}" -maxdepth 2 -mindepth 1 | sort | sed 's|^|  |'
  exit 0
fi

# -----------------------------------------------------------------------------
# pack
# -----------------------------------------------------------------------------

mkdir -p "${DIST_DIR}"
OUTPUT="${DIST_DIR}/kioku-wiki-${MANIFEST_VERSION}.mcpb"

echo ""
echo "build-mcpb: [pack] generating ${OUTPUT}"
# `mcpb pack <source> <output>` で source ディレクトリを zip し manifest を検証する
(cd "${STAGING_DIR}" && npx --yes @anthropic-ai/mcpb pack . "${OUTPUT}")

if [[ ! -f "${OUTPUT}" ]]; then
  echo "ERROR: mcpb pack succeeded but output file not found at ${OUTPUT}" >&2
  exit 1
fi

OUTPUT_SIZE="$(wc -c <"${OUTPUT}" | awk '{printf "%.1f", $1/1024/1024}')"

cat <<EOF

============================================================
完了 — KIOKU MCPB バンドルを生成しました
============================================================

  ファイル: ${OUTPUT}
  サイズ:  ${OUTPUT_SIZE} MB

インストール (Claude Desktop):

  1. Claude Desktop を起動
  2. 上記 .mcpb ファイルをウィンドウにドラッグ&ドロップ
  3. Vault directory に Obsidian Vault のパスを指定 → Install
  4. 設定 > MCP で kioku-wiki が ON になっていることを確認

検証だけしたい場合:

  npx --yes @anthropic-ai/mcpb info "${OUTPUT}"

EOF
