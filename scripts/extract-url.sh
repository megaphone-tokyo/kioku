#!/usr/bin/env bash
#
# extract-url.sh — 機能 2.2: URL fetch + Markdown 化の shell thin wrapper
#
# 使い方:
#   extract-url.sh --url <url> --vault <vault> [options]
#   extract-url.sh --urls-file <path> --vault <vault> --subdir <subdir>
#
# オプション:
#   --url <url>             単一 URL を処理
#   --urls-file <path>      urls.txt 形式のファイルを順次処理
#   --vault <path>          Vault ルート (必須)
#   --subdir <name>         raw-sources サブディレクトリ (既定: articles)
#   --refresh-days <n|never>
#   --title <s>             タイトル上書き (単一 URL のみ)
#   --source-type <s>
#   --tags <a,b,c>
#   --robots-override <url>
#   --help
#
# exit code は mcp/lib/url-extract-cli.mjs の propagation:
#   0 = ok (urls-file は行単位の失敗を warning にとどめる、最終 exit は 0)
#   1 = node が PATH にない、CLI ファイル欠落
#   2 = 引数エラー (--url / --urls-file / --vault 欠如、不明フラグ)

set -euo pipefail
LOG_PREFIX="[extract-url]"

# 2026-04-20 LOW-d4 fix: cron / launchd 経由で呼ばれる際に operator が debug で
# 残した `KIOKU_URL_ALLOW_LOOPBACK` / `KIOKU_URL_IGNORE_ROBOTS` が永続 bypass に
# なる経路を塞ぐ。shell 側で明示的に unset することで node CLI に伝搬させない。
# テスト目的で loopback fixture-server を許可したい場合は
# `KIOKU_ALLOW_LOOPBACK_IN_CRON=1` を指定すること (最低限の allowlist flag)。
if [[ "${KIOKU_ALLOW_LOOPBACK_IN_CRON:-0}" != "1" ]]; then
  unset KIOKU_URL_ALLOW_LOOPBACK
fi
if [[ "${KIOKU_ALLOW_IGNORE_ROBOTS_IN_CRON:-0}" != "1" ]]; then
  unset KIOKU_URL_IGNORE_ROBOTS
fi

usage() {
  cat <<EOF
Usage: extract-url.sh --url <url> --vault <vault> [options]
       extract-url.sh --urls-file <path> --vault <vault> --subdir <subdir>

Options:
  --url <url>             Single URL to process
  --urls-file <path>      Process urls.txt sequentially (lines: "URL [; key=value ...]")
  --vault <path>          Vault root (required)
  --subdir <name>         raw-sources subdir (default: articles)
  --refresh-days <n|never>
  --title <s>             Override title (single URL only)
  --source-type <s>
  --tags <a,b,c>
  --robots-override <url>
  --help
EOF
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../mcp/lib/url-extract-cli.mjs"

URL=""
URLS_FILE=""
VAULT=""
SUBDIR="articles"
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help) usage; exit 0 ;;
    --url)
      [[ $# -ge 2 ]] || { echo "${LOG_PREFIX} ERROR: --url requires value" >&2; exit 2; }
      URL="$2"; shift 2 ;;
    --urls-file)
      [[ $# -ge 2 ]] || { echo "${LOG_PREFIX} ERROR: --urls-file requires value" >&2; exit 2; }
      URLS_FILE="$2"; shift 2 ;;
    --vault)
      [[ $# -ge 2 ]] || { echo "${LOG_PREFIX} ERROR: --vault requires value" >&2; exit 2; }
      VAULT="$2"; shift 2 ;;
    --subdir)
      [[ $# -ge 2 ]] || { echo "${LOG_PREFIX} ERROR: --subdir requires value" >&2; exit 2; }
      SUBDIR="$2"; shift 2 ;;
    --refresh-days|--title|--source-type|--tags|--robots-override)
      [[ $# -ge 2 ]] || { echo "${LOG_PREFIX} ERROR: $1 requires value" >&2; exit 2; }
      EXTRA_ARGS+=("$1" "$2"); shift 2 ;;
    *)
      echo "${LOG_PREFIX} ERROR: unknown flag: $1" >&2
      exit 2 ;;
  esac
done

if [[ -z "${URL}" && -z "${URLS_FILE}" ]]; then
  echo "${LOG_PREFIX} ERROR: --url required (or --urls-file)" >&2
  exit 2
fi
if [[ -z "${VAULT}" ]]; then
  echo "${LOG_PREFIX} ERROR: --vault required" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "${LOG_PREFIX} ERROR: node not found in PATH" >&2
  exit 1
fi
if [[ ! -f "${CLI}" ]]; then
  echo "${LOG_PREFIX} ERROR: CLI not found: ${CLI}" >&2
  exit 1
fi

run_one() {
  local u="$1"; shift
  local args=(--url "${u}" --vault "${VAULT}" --subdir "${SUBDIR}")
  if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
    args+=("${EXTRA_ARGS[@]}")
  fi
  # Caller may append per-entry DSL flags via $@.
  if [[ $# -gt 0 ]]; then
    args+=("$@")
  fi
  # `|| rc=$?` so that set -e does not trip on non-zero node CLI exits; the caller
  # handles the return value explicitly.
  local rc=0
  node "${CLI}" "${args[@]}" || rc=$?
  return ${rc}
}

# Single URL path.
if [[ -n "${URL}" ]]; then
  run_one "${URL}"
  exit $?
fi

# urls.txt loop.
if [[ ! -f "${URLS_FILE}" ]]; then
  echo "${LOG_PREFIX} ERROR: urls-file not found: ${URLS_FILE}" >&2
  exit 2
fi

process_entry() {
  local raw_line="$1"
  # コメント除去: 行頭 # or 空白+# 以降。
  # 空白+# は tr で簡易検出するのは難しいので、 grep で行全体を検査する。
  local stripped
  stripped="$(printf '%s\n' "${raw_line}" | awk '
    {
      line = $0
      # 行頭 # (空白含む) → 空行扱い
      sub(/^[[:space:]]+/, "", line)
      if (substr(line, 1, 1) == "#") { print ""; next }
      # 空白 + # 以降を切る
      idx = index($0, " #")
      if (idx > 0) { print substr($0, 1, idx - 1); next }
      print $0
    }
  ')"
  # trim
  stripped="$(printf '%s' "${stripped}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [[ -z "${stripped}" ]] && return 0

  # URL 部分 (最初の ; より前)
  local url_part
  if [[ "${stripped}" == *";"* ]]; then
    url_part="${stripped%%;*}"
  else
    url_part="${stripped}"
  fi
  url_part="$(printf '%s' "${url_part}" | sed -e 's/[[:space:]]*$//')"

  if [[ ! "${url_part}" =~ ^https?:// ]]; then
    echo "${LOG_PREFIX} WARN: skip non-URL: ${url_part}" >&2
    return 0
  fi

  # DSL: ; key=value を --flag value に変換。unknown key は warning。
  local dsl_args=()
  if [[ "${stripped}" == *";"* ]]; then
    local rest="${stripped#*;}"
    local IFS_BAK="${IFS}"
    local IFS=';'
    # shellcheck disable=SC2206
    local parts=(${rest})
    IFS="${IFS_BAK}"
    local part key val flag
    for part in "${parts[@]}"; do
      part="$(printf '%s' "${part}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
      [[ -z "${part}" ]] && continue
      if [[ "${part}" != *"="* ]]; then
        echo "${LOG_PREFIX} WARN: malformed DSL segment (no '='): ${part}" >&2
        continue
      fi
      key="${part%%=*}"
      val="${part#*=}"
      key="$(printf '%s' "${key}" | sed -e 's/[[:space:]]*$//')"
      val="$(printf '%s' "${val}" | sed -e 's/^[[:space:]]*//')"
      case "${key}" in
        tags|title|source_type|refresh_days)
          flag="--${key//_/-}"
          dsl_args+=("${flag}" "${val}") ;;
        *)
          echo "${LOG_PREFIX} WARN: unknown DSL key: ${key}" >&2 ;;
      esac
    done
  fi

  echo "${LOG_PREFIX} Processing: ${url_part}"
  local rc=0
  if [[ ${#dsl_args[@]} -gt 0 ]]; then
    run_one "${url_part}" "${dsl_args[@]}" || rc=$?
  else
    run_one "${url_part}" || rc=$?
  fi
  if [[ "${rc}" -ne 0 ]]; then
    echo "${LOG_PREFIX} WARN: ${url_part} failed (rc=${rc})" >&2
  fi
  return 0
}

while IFS= read -r line || [[ -n "${line}" ]]; do
  process_entry "${line}" || true
done < "${URLS_FILE}"

exit 0
