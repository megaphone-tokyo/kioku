#!/usr/bin/env bash
#
# setup-vault.sh — claude-brain Vault 初期化スクリプト
#
# $OBSIDIAN_VAULT が指す Obsidian Vault 配下に、claude-brain が要求する
# ディレクトリ構造・初期ファイル・.gitignore を「追加だけ」する。
# 既存ファイルは絶対に上書きしない（冪等）。git init は行わない。
#
# 環境変数:
#   OBSIDIAN_VAULT        (required) Vault ルートの絶対パス
#   KIOKU_DRY_RUN  (optional) 1 なら dry-run (実際には書き込まない)
#
# 終了コード:
#   0  正常終了
#   1  OBSIDIAN_VAULT 未設定
#   2  パスが存在しない / ディレクトリではない
#   3  書き込み権限なし
#   4  内部エラー (mkdir/cp 失敗)

set -euo pipefail

# NEW-007: セキュアなパーミッションで Vault を作成する (umask 0002 環境でも 0700/0600 を保証)
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATES_DIR="${SCRIPT_DIR}/../templates"

CREATED=0
SKIPPED=0
DRY_RUN="${KIOKU_DRY_RUN:-0}"

log_created() {
  CREATED=$((CREATED + 1))
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "[dry-run] [created] $1"
  else
    echo "[created] $1"
  fi
}

log_skipped() {
  SKIPPED=$((SKIPPED + 1))
  echo "[skipped] $1 (exists)"
}

log_warn() {
  echo "warning: $1" >&2
}

die() {
  local code="$1"
  shift
  echo "error: $*" >&2
  exit "${code}"
}

# OSS-007: OBSIDIAN_VAULT のバリデーション (シェルメタ文字を拒否)
validate_vault_path() {
  local p="$1"
  local safe_re='^[a-zA-Z0-9/._[:space:]-]+$'
  if [[ ! "${p}" =~ $safe_re ]]; then
    echo "error: OBSIDIAN_VAULT contains unsafe characters: ${p}" >&2
    echo "       Only alphanumerics, /, ., _, space, and - are allowed." >&2
    exit 1
  fi
}

# -----------------------------------------------------------------------------
# 入力検証
# -----------------------------------------------------------------------------

if [[ -z "${OBSIDIAN_VAULT:-}" ]]; then
  cat >&2 <<'EOF'
error: OBSIDIAN_VAULT is not set.

Please set the environment variable to your Obsidian Vault path, e.g.:

  export OBSIDIAN_VAULT="$HOME/claude-brain/main-claude-brain"

Then re-run this script.
EOF
  exit 1
fi

validate_vault_path "${OBSIDIAN_VAULT}"

if [[ ! -e "${OBSIDIAN_VAULT}" ]]; then
  die 2 "OBSIDIAN_VAULT path does not exist: ${OBSIDIAN_VAULT}"
fi

if [[ ! -d "${OBSIDIAN_VAULT}" ]]; then
  die 2 "OBSIDIAN_VAULT is not a directory: ${OBSIDIAN_VAULT}"
fi

if [[ ! -w "${OBSIDIAN_VAULT}" ]]; then
  die 3 "OBSIDIAN_VAULT is not writable: ${OBSIDIAN_VAULT}"
fi

if [[ ! -d "${TEMPLATES_DIR}" ]]; then
  die 4 "templates directory not found: ${TEMPLATES_DIR}"
fi

# -----------------------------------------------------------------------------
# ディレクトリ作成
# -----------------------------------------------------------------------------

ensure_dir() {
  local dir="$1"
  if [[ -d "${dir}" ]]; then
    log_skipped "${dir}/"
    return 0
  fi
  if [[ "${DRY_RUN}" == "1" ]]; then
    log_created "${dir}/"
    return 0
  fi
  mkdir -p "${dir}" || die 4 "mkdir failed: ${dir}"
  log_created "${dir}/"
}

DIRS=(
  "raw-sources/articles"
  "raw-sources/books"
  "raw-sources/transcripts"
  "raw-sources/ideas"
  "raw-sources/assets"
  "session-logs"
  "wiki/concepts"
  "wiki/projects"
  "wiki/decisions"
  "wiki/patterns"
  "wiki/bugs"
  "wiki/people"
  "wiki/summaries"
  "wiki/analyses"
  "templates"
)

for rel in "${DIRS[@]}"; do
  ensure_dir "${OBSIDIAN_VAULT}/${rel}"
done

# -----------------------------------------------------------------------------
# 初期ファイル配置
# -----------------------------------------------------------------------------

copy_if_missing() {
  local src="$1"
  local dst="$2"
  if [[ ! -f "${src}" ]]; then
    die 4 "template source not found: ${src}"
  fi
  if [[ -e "${dst}" ]]; then
    log_skipped "${dst}"
    return 0
  fi
  if [[ "${DRY_RUN}" == "1" ]]; then
    log_created "${dst}"
    return 0
  fi
  cp "${src}" "${dst}" || die 4 "cp failed: ${src} -> ${dst}"
  log_created "${dst}"
}

# CLAUDE.md は既存があれば CLAUDE.brain.md に退避配置する（A.5）
install_vault_claude_md() {
  local src="${TEMPLATES_DIR}/vault/CLAUDE.md"
  local dst="${OBSIDIAN_VAULT}/CLAUDE.md"

  if [[ ! -f "${src}" ]]; then
    die 4 "template source not found: ${src}"
  fi

  if [[ -e "${dst}" ]]; then
    local alt="${OBSIDIAN_VAULT}/CLAUDE.brain.md"
    log_warn "Vault CLAUDE.md already exists. Writing schema to CLAUDE.brain.md instead."
    if [[ -e "${alt}" ]]; then
      log_skipped "${alt}"
      return 0
    fi
    if [[ "${DRY_RUN}" == "1" ]]; then
      log_created "${alt}"
      return 0
    fi
    cp "${src}" "${alt}" || die 4 "cp failed: ${src} -> ${alt}"
    log_created "${alt}"
    return 0
  fi

  if [[ "${DRY_RUN}" == "1" ]]; then
    log_created "${dst}"
    return 0
  fi
  cp "${src}" "${dst}" || die 4 "cp failed: ${src} -> ${dst}"
  log_created "${dst}"
}

install_vault_claude_md

copy_if_missing \
  "${TEMPLATES_DIR}/vault/.gitignore" \
  "${OBSIDIAN_VAULT}/.gitignore"

copy_if_missing \
  "${TEMPLATES_DIR}/wiki/index.md" \
  "${OBSIDIAN_VAULT}/wiki/index.md"

copy_if_missing \
  "${TEMPLATES_DIR}/wiki/log.md" \
  "${OBSIDIAN_VAULT}/wiki/log.md"

copy_if_missing \
  "${TEMPLATES_DIR}/notes/concept.md" \
  "${OBSIDIAN_VAULT}/templates/concept.md"

copy_if_missing \
  "${TEMPLATES_DIR}/notes/project.md" \
  "${OBSIDIAN_VAULT}/templates/project.md"

copy_if_missing \
  "${TEMPLATES_DIR}/notes/decision.md" \
  "${OBSIDIAN_VAULT}/templates/decision.md"

copy_if_missing \
  "${TEMPLATES_DIR}/notes/source-summary.md" \
  "${OBSIDIAN_VAULT}/templates/source-summary.md"

# -----------------------------------------------------------------------------
# サマリ
# -----------------------------------------------------------------------------

echo "Done. ${CREATED} created, ${SKIPPED} skipped."
