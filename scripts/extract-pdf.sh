#!/usr/bin/env bash
#
# extract-pdf.sh — PDF を pdftotext で抽出し、固定ページ幅 chunk の Markdown に書き出す。
#
# 使い方:
#   extract-pdf.sh <pdf-path> <output-dir> <subdir-prefix>
#
# 引数:
#   pdf-path        raw-sources/ 配下の PDF (realpath で検証)
#   output-dir      chunk MD の書き出し先 (通常は $OBSIDIAN_VAULT/.cache/extracted/)
#   subdir-prefix   chunk ファイル名のプレフィックス (通常は raw-sources/ のサブディレクトリ名)
#
# 出力ファイル名:
#   <output-dir>/<subdir-prefix>-<stem>-pp<NNN>-<MMM>.md
#
# 環境変数:
#   KIOKU_PDF_CHUNK_PAGES       既定 15。1 chunk のページ幅
#   KIOKU_PDF_OVERLAP           既定 1。chunk 境界での重複ページ数 (0 で無効)
#   KIOKU_PDF_MAX_SOFT_PAGES    既定 500。超過すると先頭 500p のみ処理 + truncated: true
#   KIOKU_PDF_MAX_HARD_PAGES    既定 1000。超過すると完全スキップ (exit 4)
#   KIOKU_PDF_LAYOUT            既定 0。1 で pdftotext に -layout を付与 (表保持)
#   KIOKU_PDF_PAGE_TIMEOUT      既定 300。1 chunk あたりの pdftotext タイムアウト (秒)
#
# 終了コード:
#   0  正常終了 (chunk 生成 or 冪等スキップ)
#   1  実行環境不足 (pdfinfo / pdftotext / node が PATH にない)
#   2  PDF が存在しない / 暗号化されている / pdfinfo 呼び出し失敗
#   3  全 chunk が空テキスト (スキャン画像 PDF の可能性)
#   4  ページ数が MAX_HARD_PAGES を超過
#   5  PDF が raw-sources/ 配下でない (パストラバーサル防御)
#   6  pdfinfo の Pages フィールドが不正
#   64 引数の数が不正
#
# 設計書: tools/claude-brain/plan/claude/26041705_document-ingest-design.md §4.1
# 議事録: tools/claude-brain/plan/claude/26041706_meeting_document-ingest-design-review.md

set -euo pipefail
umask 077

LOG_PREFIX="[extract-pdf]"

# -----------------------------------------------------------------------------
# 設定
# -----------------------------------------------------------------------------

CHUNK_PAGES="${KIOKU_PDF_CHUNK_PAGES:-15}"
OVERLAP="${KIOKU_PDF_OVERLAP:-1}"
MAX_SOFT="${KIOKU_PDF_MAX_SOFT_PAGES:-500}"
MAX_HARD="${KIOKU_PDF_MAX_HARD_PAGES:-1000}"
LAYOUT_DEFAULT="${KIOKU_PDF_LAYOUT:-0}"
PAGE_TIMEOUT="${KIOKU_PDF_PAGE_TIMEOUT:-300}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MASK_SCRIPT="${SCRIPT_DIR}/mask-text.mjs"

# -----------------------------------------------------------------------------
# 引数検証
# -----------------------------------------------------------------------------

if [[ $# -ne 3 ]]; then
  echo "${LOG_PREFIX} usage: extract-pdf.sh <pdf-path> <output-dir> <subdir-prefix>" >&2
  exit 64
fi

PDF_PATH="$1"
OUTPUT_DIR="$2"
SUBDIR_PREFIX="$3"

if [[ ! -f "${PDF_PATH}" ]]; then
  echo "${LOG_PREFIX} ERROR: PDF not found: ${PDF_PATH}" >&2
  exit 2
fi

# realpath でパストラバーサル防御: $OBSIDIAN_VAULT/raw-sources/ 配下のみ許容。
# VULN-011 対策: substring `*/raw-sources/*` ではなく Vault からの prefix match に
# 強化する。OBSIDIAN_VAULT が未設定のときは後方互換のため substring 判定に戻る。
PDF_REAL="$(realpath "${PDF_PATH}")"
if [[ -n "${OBSIDIAN_VAULT:-}" ]]; then
  VAULT_REAL="$(realpath "${OBSIDIAN_VAULT}" 2>/dev/null || echo "${OBSIDIAN_VAULT}")"
  if [[ "${PDF_REAL}" != "${VAULT_REAL}/raw-sources/"* ]]; then
    echo "${LOG_PREFIX} ERROR: PDF not under \${OBSIDIAN_VAULT}/raw-sources/: ${PDF_REAL}" >&2
    exit 5
  fi
elif [[ "${PDF_REAL}" != */raw-sources/* ]]; then
  echo "${LOG_PREFIX} ERROR: PDF is not under raw-sources/: ${PDF_REAL}" >&2
  exit 5
fi

# -----------------------------------------------------------------------------
# 依存確認
# -----------------------------------------------------------------------------

for bin in pdfinfo pdftotext node; do
  if ! command -v "${bin}" >/dev/null 2>&1; then
    echo "${LOG_PREFIX} ERROR: ${bin} not found in PATH" >&2
    if [[ "${bin}" == "pdfinfo" || "${bin}" == "pdftotext" ]]; then
      echo "${LOG_PREFIX}        install poppler: brew install poppler | apt install poppler-utils" >&2
    fi
    exit 1
  fi
done

# GNU timeout の発見: macOS 標準に `timeout` は無いため gtimeout (brew coreutils)
# を次点にし、どちらも無ければ空配列にしてタイムアウトなしで動かす。
# DoS ガードは auto-ingest.sh 側の 30 分 soft-timeout と MAX_HARD_PAGES=1000 が主軸で、
# ここでのタイムアウトは二重防御。
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD=(timeout "${PAGE_TIMEOUT}")
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD=(gtimeout "${PAGE_TIMEOUT}")
else
  TIMEOUT_CMD=()
  echo "${LOG_PREFIX} WARN: neither 'timeout' nor 'gtimeout' found; pdftotext will run without per-chunk timeout" >&2
fi

if [[ ! -f "${MASK_SCRIPT}" ]]; then
  echo "${LOG_PREFIX} ERROR: mask-text.mjs not found: ${MASK_SCRIPT}" >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# pdfinfo でメタデータと前提チェック
# -----------------------------------------------------------------------------

INFO="$(pdfinfo "${PDF_PATH}" 2>/dev/null || true)"
if [[ -z "${INFO}" ]]; then
  echo "${LOG_PREFIX} ERROR: pdfinfo failed for: ${PDF_REAL}" >&2
  exit 2
fi

if echo "${INFO}" | grep -qE '^Encrypted:[[:space:]]+yes'; then
  echo "${LOG_PREFIX} ERROR: Encrypted PDF, skipping: ${PDF_REAL}" >&2
  exit 2
fi

PAGES="$(echo "${INFO}" | awk -F':[[:space:]]+' '/^Pages:/ {print $2; exit}')"
if [[ -z "${PAGES}" || ! "${PAGES}" =~ ^[0-9]+$ ]]; then
  echo "${LOG_PREFIX} ERROR: pdfinfo Pages field missing or invalid: '${PAGES}'" >&2
  exit 6
fi

if (( PAGES > MAX_HARD )); then
  echo "${LOG_PREFIX} ERROR: PDF has ${PAGES} pages (> hard limit ${MAX_HARD}), skipping: ${PDF_REAL}" >&2
  exit 4
fi

# 機能 2.1: PDF 全体の sha256 を計算して chunk MD の frontmatter に書く。
# VULN-006/018 完全版: mtime ベースの冪等判定では chunk MD / summary MD の
# 内容差し替えを検知できないため、sha256 ベース比較に移行する (auto-ingest.sh 側)。
# shasum が優先 (macOS 標準)、sha256sum を fallback (GNU coreutils / Alpine)。
if command -v shasum >/dev/null 2>&1; then
  PDF_SHA256="$(shasum -a 256 "${PDF_PATH}" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  PDF_SHA256="$(sha256sum "${PDF_PATH}" | awk '{print $1}')"
else
  echo "${LOG_PREFIX} ERROR: neither shasum nor sha256sum in PATH" >&2
  exit 1
fi
if [[ -z "${PDF_SHA256}" || ! "${PDF_SHA256}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "${LOG_PREFIX} ERROR: sha256 calculation failed for: ${PDF_REAL}" >&2
  exit 1
fi

TRUNCATED=false
EFFECTIVE_PAGES="${PAGES}"
if (( PAGES > MAX_SOFT )); then
  echo "${LOG_PREFIX} WARN: PDF has ${PAGES} pages (> soft limit ${MAX_SOFT}), truncating to first ${MAX_SOFT}: ${PDF_REAL}" >&2
  TRUNCATED=true
  EFFECTIVE_PAGES="${MAX_SOFT}"
fi

RAW_TITLE="$(echo "${INFO}" | awk -F':[[:space:]]+' '/^Title:/ {sub(/^Title:[[:space:]]+/, ""); print; exit}')"
RAW_AUTHOR="$(echo "${INFO}" | awk -F':[[:space:]]+' '/^Author:/ {sub(/^Author:[[:space:]]+/, ""); print; exit}')"
RAW_CREATION="$(echo "${INFO}" | awk -F':[[:space:]]+' '/^CreationDate:/ {sub(/^CreationDate:[[:space:]]+/, ""); print; exit}')"

PDF_STEM="$(basename "${PDF_PATH}" .pdf)"

# pdfinfo Title が "Microsoft Word - ..." 等のゴミパターンなら破棄してファイル名 fallback
title_is_junk() {
  local t="$1"
  [[ -z "${t}" ]] && return 0
  if [[ "${t}" =~ ^Microsoft[[:space:]]Word([[:space:]]-.*)?$ ]]; then return 0; fi
  if [[ "${t}" =~ ^Untitled$ ]]; then return 0; fi
  if [[ "${t}" == "." ]]; then return 0; fi
  if [[ "${t}" =~ ^Document[0-9]*$ ]]; then return 0; fi
  return 1
}

if title_is_junk "${RAW_TITLE}"; then
  TITLE="${PDF_STEM}"
else
  TITLE="${RAW_TITLE}"
fi

# -----------------------------------------------------------------------------
# サイドカー .meta.yaml (任意) の簡易パース
# -----------------------------------------------------------------------------

SIDECAR="${PDF_PATH%.pdf}.meta.yaml"
SIDECAR_SOURCE_TYPE=""
SIDECAR_TITLE=""
SIDECAR_AUTHORS=""
SIDECAR_YEAR=""
SIDECAR_URL=""
LAYOUT_FLAG="${LAYOUT_DEFAULT}"

strip_quotes() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  if [[ "${v}" =~ ^\"(.*)\"$ ]]; then v="${BASH_REMATCH[1]}"; fi
  if [[ "${v}" =~ ^\'(.*)\'$ ]]; then v="${BASH_REMATCH[1]}"; fi
  printf '%s' "${v}"
}

if [[ -f "${SIDECAR}" ]]; then
  while IFS= read -r line || [[ -n "${line}" ]]; do
    # コメント / 空行 / 先頭リスト記号を無視
    [[ "${line}" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// /}" ]] && continue
    # key: value の単純スカラーのみサポート (ネスト・リストは非対応)
    if [[ "${line}" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*:[[:space:]]*(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      raw="${BASH_REMATCH[2]}"
      val="$(strip_quotes "${raw}")"
      case "${key}" in
        source_type) SIDECAR_SOURCE_TYPE="${val}" ;;
        title) SIDECAR_TITLE="${val}" ;;
        authors) SIDECAR_AUTHORS="${val}" ;;
        year) SIDECAR_YEAR="${val}" ;;
        url) SIDECAR_URL="${val}" ;;
        extract_layout)
          # bash 3.2 互換: ${val,,} は使えないので tr で小文字化
          lc_val="$(printf '%s' "${val}" | tr '[:upper:]' '[:lower:]')"
          if [[ "${lc_val}" == "true" || "${val}" == "1" ]]; then
            LAYOUT_FLAG=1
          else
            LAYOUT_FLAG=0
          fi
          ;;
      esac
    fi
  done < "${SIDECAR}"
fi

if [[ -n "${SIDECAR_TITLE}" ]]; then
  TITLE="${SIDECAR_TITLE}"
fi

# source_type: サイドカー > サブディレクトリ名 fallback。sanitize 強制。
SOURCE_TYPE_RAW="${SIDECAR_SOURCE_TYPE:-${SUBDIR_PREFIX}}"
SOURCE_TYPE="$(node "${MASK_SCRIPT}" --sanitize-source-type "${SOURCE_TYPE_RAW}")"
[[ -z "${SOURCE_TYPE}" ]] && SOURCE_TYPE="unknown"

# タイトル等も制御文字を落とす (YAML 壊れ防止)
TITLE_SAFE="$(node "${MASK_SCRIPT}" --sanitize-source-type "${TITLE}")"
[[ -z "${TITLE_SAFE}" ]] && TITLE_SAFE="${PDF_STEM}"
AUTHOR_SAFE="$(node "${MASK_SCRIPT}" --sanitize-source-type "${RAW_AUTHOR}")"
URL_SAFE="$(node "${MASK_SCRIPT}" --sanitize-source-type "${SIDECAR_URL}")"
AUTHORS_SAFE="$(node "${MASK_SCRIPT}" --sanitize-source-type "${SIDECAR_AUTHORS}")"
YEAR_SAFE="$(node "${MASK_SCRIPT}" --sanitize-source-type "${SIDECAR_YEAR}")"
# VULN-001 対策: pdfinfo の CreationDate にも sanitize を強制する (改行/制御文字の
# YAML frontmatter 破壊と Unicode 不可視文字経由の prompt injection 防止)。
CREATION_SAFE="$(node "${MASK_SCRIPT}" --sanitize-source-type "${RAW_CREATION}")"

# -----------------------------------------------------------------------------
# 出力ディレクトリ準備
# -----------------------------------------------------------------------------

mkdir -p "${OUTPUT_DIR}"
chmod 0700 "${OUTPUT_DIR}" 2>/dev/null || true

# -----------------------------------------------------------------------------
# Chunk 境界計算
# -----------------------------------------------------------------------------
# 規約 (設計書 §4.4):
#   chunk 0 は [1, min(CHUNK_PAGES, EFFECTIVE_PAGES)]
#   chunk i (i≥1) は [block_start_i - overlap, min(block_start_i + CHUNK_PAGES - 1, EFFECTIVE_PAGES)]
#   block_start_i = 1 + i * CHUNK_PAGES
#   最終 chunk のユニーク新規ページ (last - prev_last) が CHUNK_PAGES/3 以下なら直前 chunk に統合
# 非分割しきい値: EFFECTIVE_PAGES <= CHUNK_PAGES のとき 1 chunk として [1, EFFECTIVE_PAGES] を出力

declare -a CHUNK_FIRSTS=()
declare -a CHUNK_LASTS=()

if (( EFFECTIVE_PAGES <= CHUNK_PAGES )); then
  CHUNK_FIRSTS+=(1)
  CHUNK_LASTS+=("${EFFECTIVE_PAGES}")
else
  i=0
  while :; do
    block_start=$(( 1 + i * CHUNK_PAGES ))
    (( block_start > EFFECTIVE_PAGES )) && break
    if (( i == 0 )); then
      first=1
    else
      first=$(( block_start - OVERLAP ))
      (( first < 1 )) && first=1
    fi
    last=$(( block_start + CHUNK_PAGES - 1 ))
    (( last > EFFECTIVE_PAGES )) && last="${EFFECTIVE_PAGES}"
    CHUNK_FIRSTS+=("${first}")
    CHUNK_LASTS+=("${last}")
    (( last >= EFFECTIVE_PAGES )) && break
    i=$(( i + 1 ))
  done

  # 最終 chunk 統合判定
  n="${#CHUNK_FIRSTS[@]}"
  if (( n >= 2 )); then
    merge_threshold=$(( CHUNK_PAGES / 3 ))
    (( merge_threshold < 1 )) && merge_threshold=1
    last_prev="${CHUNK_LASTS[$(( n - 2 ))]}"
    last_cur="${CHUNK_LASTS[$(( n - 1 ))]}"
    unique_new=$(( last_cur - last_prev ))
    if (( unique_new <= merge_threshold )); then
      CHUNK_LASTS[$(( n - 2 ))]="${last_cur}"
      unset 'CHUNK_FIRSTS[n-1]'
      unset 'CHUNK_LASTS[n-1]'
      CHUNK_FIRSTS=("${CHUNK_FIRSTS[@]}")
      CHUNK_LASTS=("${CHUNK_LASTS[@]}")
    fi
  fi
fi

CHUNK_COUNT="${#CHUNK_FIRSTS[@]}"

# -----------------------------------------------------------------------------
# 冪等性: PDF mtime より全 chunk MD が新しければ何もしない
# -----------------------------------------------------------------------------

pdf_mtime="$(stat -f '%m' "${PDF_PATH}" 2>/dev/null || stat -c '%Y' "${PDF_PATH}" 2>/dev/null || echo 0)"
all_cached=true
declare -a CHUNK_PATHS=()
for (( i = 0; i < CHUNK_COUNT; i++ )); do
  first="${CHUNK_FIRSTS[$i]}"
  last="${CHUNK_LASTS[$i]}"
  # 機能 2.1 (VULN-005): 二重ハイフン境界で subdir/stem の衝突を解消。
  # 旧命名 `<subdir>-<stem>-pp*.md` は auto-ingest.sh 側で互換扱いして 90 日 GC で消滅させる。
  fname="$(printf '%s--%s-pp%03d-%03d.md' "${SUBDIR_PREFIX}" "${PDF_STEM}" "${first}" "${last}")"
  path="${OUTPUT_DIR}/${fname}"
  CHUNK_PATHS+=("${path}")
  if [[ ! -f "${path}" ]]; then
    all_cached=false
  else
    chunk_mtime="$(stat -f '%m' "${path}" 2>/dev/null || stat -c '%Y' "${path}" 2>/dev/null || echo 0)"
    if (( chunk_mtime < pdf_mtime )); then
      all_cached=false
    fi
  fi
done

if [[ "${all_cached}" == "true" ]] && (( CHUNK_COUNT > 0 )); then
  echo "${LOG_PREFIX} Skip (all chunks up-to-date): ${PDF_REAL}"
  exit 0
fi

# -----------------------------------------------------------------------------
# chunk ごとに pdftotext + mask でテキスト抽出
# -----------------------------------------------------------------------------

escape_yaml() {
  # Escape double quotes for YAML double-quoted scalar
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "${s}"
}

layout_arg=()
if [[ "${LAYOUT_FLAG}" == "1" ]]; then
  layout_arg=(-layout)
fi

all_empty=true
for (( i = 0; i < CHUNK_COUNT; i++ )); do
  first="${CHUNK_FIRSTS[$i]}"
  last="${CHUNK_LASTS[$i]}"
  out="${CHUNK_PATHS[$i]}"

  # pdftotext でテキスト抽出 (発見できれば 5 分タイムアウト) → mask-text.mjs でマスク。
  # bash 3.2 + set -u 下で空配列を展開できないため ${arr[@]+...} イディオムを使う。
  extracted="$(${TIMEOUT_CMD[@]+"${TIMEOUT_CMD[@]}"} pdftotext \
      -f "${first}" -l "${last}" -enc UTF-8 \
      ${layout_arg[@]+"${layout_arg[@]}"} \
      "${PDF_PATH}" - 2>/dev/null | node "${MASK_SCRIPT}" || true)"

  # 空白のみ (trim 後 0 文字) かどうかを判定
  trimmed="$(printf '%s' "${extracted}" | tr -d '[:space:]')"
  if [[ -n "${trimmed}" ]]; then
    all_empty=false
  fi

  # frontmatter 生成
  tmp="$(mktemp "${out}.XXXXXX")"
  {
    echo "---"
    echo "title: \"$(escape_yaml "${TITLE_SAFE}")\""
    echo "source_type: \"$(escape_yaml "${SOURCE_TYPE}")\""
    echo "source_path: \"$(escape_yaml "${PDF_REAL}")\""
    echo "source_sha256: \"${PDF_SHA256}\""
    echo "page_range: \"$(printf '%03d-%03d' "${first}" "${last}")\""
    echo "page_first: ${first}"
    echo "page_last: ${last}"
    echo "total_pages: ${PAGES}"
    echo "chunks: ${CHUNK_COUNT}"
    if [[ "${TRUNCATED}" == "true" ]]; then
      echo "truncated: true"
      echo "effective_pages: ${EFFECTIVE_PAGES}"
    fi
    if [[ -n "${AUTHOR_SAFE}" ]]; then
      echo "author: \"$(escape_yaml "${AUTHOR_SAFE}")\""
    fi
    if [[ -n "${AUTHORS_SAFE}" ]]; then
      echo "authors: \"$(escape_yaml "${AUTHORS_SAFE}")\""
    fi
    if [[ -n "${YEAR_SAFE}" ]]; then
      echo "year: \"$(escape_yaml "${YEAR_SAFE}")\""
    fi
    if [[ -n "${URL_SAFE}" ]]; then
      echo "url: \"$(escape_yaml "${URL_SAFE}")\""
    fi
    if [[ -n "${CREATION_SAFE}" ]]; then
      echo "pdf_creation_date: \"$(escape_yaml "${CREATION_SAFE}")\""
    fi
    echo "extracted_at: \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
    echo "extractor: \"pdftotext$([[ ${LAYOUT_FLAG} == 1 ]] && echo ' -layout' || true)\""
    echo "---"
    echo ""
    echo "${extracted}"
  } > "${tmp}"
  chmod 0600 "${tmp}" 2>/dev/null || true
  mv "${tmp}" "${out}"
done

if [[ "${all_empty}" == "true" ]]; then
  echo "${LOG_PREFIX} WARN: All chunks are empty (likely scanned image PDF): ${PDF_REAL}" >&2
  # VULN-007 対策: frontmatter だけの空 chunk MD を削除する。残すと auto-ingest.sh の
  # .cache/extracted/ カウントに乗り、本文が空で frontmatter (サイドカー由来 Title
  # 等) だけが LLM に読まれる経路が開くため。冪等性は「chunk MD 不在 → 通常パスで
  # 再抽出」で維持される。
  for p in "${CHUNK_PATHS[@]}"; do
    rm -f "${p}"
  done
  exit 3
fi

echo "${LOG_PREFIX} Extracted ${CHUNK_COUNT} chunk(s) from ${PDF_REAL} (pages=${EFFECTIVE_PAGES}/${PAGES})"
exit 0
