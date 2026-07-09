# install-common.sh — install / setup 系 Bash script の共通ライブラリ (source 専用)
#
# 使い方 (呼び出し側 script 冒頭付近):
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/install-common.sh"
#
# 本ファイルは source 専用。直接実行は禁止 (直下の guard で exit 1)。
# shebang を意図的に付けない (単体実行可能な script ではないことの表明)。
#
# ## 経緯 (PR S6-1、v0.11 Sprint 6、plan 26070601 §4.1)
#
# validate_vault_path() は VULN-004 (install-hooks.sh) を起点に、VULN-005 /
# OSS-007 / NEW-001 / R4-001 の security 指摘対応で 12 script に inline 複製
# されていた (LEARN#8b の N>=3 mandatory extract 閾値を大幅超過)。
# 本ファイルを SSOT とし、12 script は source で参照する。
# regex は複製時代の `^[a-zA-Z0-9/._[:space:]-]+$` と 1 文字も違わない (挙動変更なし)。
# エラーメッセージ prefix は `ERROR:` に統一 (旧: `error:` / `ERROR:` 混在)。

# source 専用 guard: 直接実行されたら exit 1。
# source されている時は subshell 内の `return 0` が成功し、直接実行時は失敗する
# (bash 3.2 / 5.x で検証済)。
if ! (return 0 2>/dev/null); then
  echo "ERROR: install-common.sh is a source-only library; do not execute it directly." >&2
  exit 1
fi

# validate_vault_path <path>
#
# パスにシェルメタ文字・JSON/XML 特殊文字・制御文字が含まれないことを検証する。
# 許可: 英数字 / `/` / `.` / `_` / 空白 / `-` のみ (path traversal の `..` 自体は
# 文字として許可されるが、`;` `$` `` ` `` `&` 等の injection 経路を遮断する)。
# 不許可文字を検出した場合は stderr にエラーを出して exit 1 (呼び出し元ごと停止)。
# LOG_PREFIX が定義済みの script (cron 系: auto-ingest / auto-lint / setup-qmd 等)
# ではメッセージ先頭に LOG_PREFIX が付与される。未定義でも set -u 下で安全。
validate_vault_path() {
  local p="$1"
  local safe_re='^[a-zA-Z0-9/._[:space:]-]+$'
  if [[ ! "${p}" =~ $safe_re ]]; then
    echo "${LOG_PREFIX:+${LOG_PREFIX} }ERROR: OBSIDIAN_VAULT contains unsafe characters: ${p}" >&2
    echo "       Only alphanumerics, /, ., _, space, and - are allowed." >&2
    exit 1
  fi
}

# -----------------------------------------------------------------------------
# Mode 判定 sensors + detect_recommended_mode (PR S6-5、plan 26070601 §4.5)
#
# scripts/install.sh:119 (v0.10 時点) から移設した SSOT。install.sh /
# install/user/install-hooks.sh (Mode gate) / doctor.sh (S6-6 予定) で共有する。
#
# 注意: install.sh は `bash <(curl ...)` の一行実行 (公開 URL 外部契約) では
# 本 lib に到達できないため、同一 literal の fallback block を install.sh 内に持つ。
# 下記 BEGIN/END marker 間は install.sh の fallback と 1 文字も違えないこと
# (S6-3 masking SSOT と同じ SHARED LITERAL 方式、tests/install-hierarchy.test.sh
# の parity assertion が drift を検出する)。
# -----------------------------------------------------------------------------

# === BEGIN SHARED LITERAL (mode-detection SSOT) ===

# sensor 1: Claude Code CLI が利用可能か (CLI command または settings dir)
has_claude_code() {
  if command -v claude >/dev/null 2>&1; then
    return 0
  fi
  if [[ -d "${HOME}/.claude" ]]; then
    return 0
  fi
  return 1
}

# sensor 2: Codex CLI が利用可能か
has_codex() {
  if command -v codex >/dev/null 2>&1; then
    return 0
  fi
  if [[ -d "${HOME}/.codex" ]]; then
    return 0
  fi
  return 1
}

# sensor 3: Gemini CLI が利用可能か
has_gemini() {
  if command -v gemini >/dev/null 2>&1; then
    return 0
  fi
  if [[ -d "${HOME}/.gemini" ]]; then
    return 0
  fi
  return 1
}

# sensor 4: 既存 Hook 設定の有無 (~/.claude/settings.json に hooks key)
has_existing_hooks() {
  local target="${HOME}/.claude/settings.json"
  if [[ ! -f "${target}" ]]; then
    return 1
  fi
  if ! command -v jq >/dev/null 2>&1; then
    # jq 無しでは判定不可、安全側に倒して "なし" 扱い
    return 1
  fi
  if jq -e '.hooks | objects | length > 0' "${target}" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# 判定 logic:
#   Claude Code 検出 (Codex / Gemini 検出より優先、Plugin marketplace が low-friction) → Mode A
#   Codex / Gemini のみ検出 → Mode C
#   何も検出されない → Mode A (Claude Code install を suggest する flow)
#   既存 hook あり → どちらの場合でも warning を後段で表示 (mode 判定自体は変えない)
detect_recommended_mode() {
  if has_claude_code; then
    echo "a"
    return
  fi
  if has_codex || has_gemini; then
    echo "c"
    return
  fi
  echo "a"
}

# === END SHARED LITERAL (mode-detection SSOT) ===
