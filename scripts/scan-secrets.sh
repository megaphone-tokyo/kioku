#!/usr/bin/env bash
#
# scan-secrets.sh — session-logs/ 配下の秘密情報漏れ検知 (open-issues #6)
#
# session-logger.mjs の MASK_RULES は unit test では動いているが、実セッションで
# 新種のトークン (例: `github_pat_` が登場する前の旧 GitHub PAT `ghp_` しか
# パターンにない等) が混入した場合は気付かない。本スクリプトは session-logs/
# 配下を既知の秘密パターンで grep し、マスキング漏れを検知する。
#
# 使用例:
#   bash scripts/scan-secrets.sh                # 既定の Vault をスキャン
#   OBSIDIAN_VAULT=/path bash scan-secrets.sh                      # 別の Vault
#   bash scan-secrets.sh --json                                    # JSON サマリ出力 (機械可読)
#
# 環境変数:
#   OBSIDIAN_VAULT   Vault ルート (未設定時は $HOME/kioku/main-kioku)
#
# 終了コード:
#   0  スキャン完了 (ヒットの有無に関わらず正常終了)
#   1  Vault が存在しない / session-logs/ が存在しない
#   2  マスキング漏れが 1 件以上見つかった (cron から監視したいとき用)
#
# cron からの利用例 (月次):
#   0 9 1 * * /ABS/scan-secrets.sh >> "$HOME/KIOKU-scan.log" 2>&1

set -euo pipefail

LOG_PREFIX="[scan-secrets $(date +%Y%m%d-%H%M)]"

OBSIDIAN_VAULT="${OBSIDIAN_VAULT:-${HOME}/kioku/main-kioku}"

# NEW-001: OBSIDIAN_VAULT のバリデーション (JSON フォールバック時のインジェクション防止)
validate_vault_path() {
  local p="$1"
  local safe_re='^[a-zA-Z0-9/._[:space:]-]+$'
  if [[ ! "${p}" =~ $safe_re ]]; then
    echo "error: OBSIDIAN_VAULT contains unsafe characters: ${p}" >&2
    exit 1
  fi
}
validate_vault_path "${OBSIDIAN_VAULT}"

JSON_MODE=0
if [[ "${1:-}" == "--json" ]]; then
  JSON_MODE=1
fi

# -----------------------------------------------------------------------------
# 前提チェック
# -----------------------------------------------------------------------------

if [[ ! -d "${OBSIDIAN_VAULT}" ]]; then
  echo "${LOG_PREFIX} ERROR: OBSIDIAN_VAULT not found: ${OBSIDIAN_VAULT}" >&2
  exit 1
fi

LOGS_DIR="${OBSIDIAN_VAULT}/session-logs"
if [[ ! -d "${LOGS_DIR}" ]]; then
  echo "${LOG_PREFIX} ERROR: session-logs/ not found under ${OBSIDIAN_VAULT}" >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# 秘密情報パターン定義
#
# 重要: session-logger.mjs の MASK_RULES に対応するパターンを ERE で書き直したもの。
# ここにあるパターンにヒットしたら「マスキング漏れ」。
#
# 既に `***` でマスクされた文字列は除外するため、末尾に「置換後のプレースホルダで
# ないこと」をチェックする形は取らず、単純に grep でヒットした件数を数え、後段で
# 目視確認しやすい形にコンテキスト付きで出力する。
# -----------------------------------------------------------------------------

# 名前とパターンを並列に保持 (bash 3.2 互換のため連想配列は使わない)。
PATTERN_NAMES=(
  "Anthropic API key (sk-ant-)"
  "OpenAI project key (sk-proj-)"
  "OpenAI-style API key (sk-)"
  "GitHub personal access token (ghp_)"
  "GitHub fine-grained PAT (github_pat_)"
  "GitHub OAuth token (gho_)"
  "GitHub user-to-server token (ghu_)"
  "Google API key (AIza)"
  "AWS access key (AKIA)"
  "Slack token (xox*-)"
  "Vercel token (vercel_)"
  "npm token (npm_)"
  "Stripe key (sk_live/pk_live/rk_live)"
  "Supabase service role key (sbp_)"
  "Firebase/GCP private_key_id"
  "Azure SharedAccessKey/AccountKey"
  "Bearer token"
  "Basic/Digest auth"
  "URL embedded credentials"
  "PEM private key"
  "key=value style secret"
)

# 注意: ERE (grep -E) 用。session-logger.mjs の JS regex と等価になるよう調整済み。
# - 長さ条件は {20,} で統一 (session-logger と同じ閾値)
# - `key=value` はキー名リストと末尾の非空白文字で素朴にマッチ
PATTERNS=(
  'sk-ant-[A-Za-z0-9_-]{20,}'
  'sk-proj-[A-Za-z0-9_-]{20,}'
  'sk-[A-Za-z0-9]{20,}'
  'ghp_[A-Za-z0-9]{20,}'
  'github_pat_[A-Za-z0-9_]{20,}'
  'gho_[A-Za-z0-9]{20,}'
  'ghu_[A-Za-z0-9]{20,}'
  'AIza[A-Za-z0-9_-]{20,}'
  'AKIA[A-Z0-9]{16}'
  'xox[baprs]-[A-Za-z0-9-]{10,}'
  'vercel_[A-Za-z0-9_-]{20,}'
  'npm_[A-Za-z0-9]{20,}'
  '[spr]k_(live|test)_[A-Za-z0-9]{20,}'
  'sbp_[A-Za-z0-9]{20,}'
  'private_key_id['"'"'"[:space:]]*[:=][[:space:]]*['"'"'"]*[a-f0-9]{40}'
  '(SharedAccessKey|AccountKey)[[:space:]]*=[[:space:]]*[A-Za-z0-9+/=]{20,}'
  'Bearer[[:space:]]+[A-Za-z0-9._~+/=-]{20,}'
  '(Basic|Digest)[[:space:]]+[A-Za-z0-9+/=]{10,}'
  '://[^:]+:[^@]+@'
  '-----BEGIN [A-Z ]+PRIVATE KEY-----'
  '(password|passwd|secret|token|api[_-]?key)[[:space:]]*[:=][[:space:]]*"?[^[:space:]"'"'"'&*]{8,}'
)

# -----------------------------------------------------------------------------
# スキャン
#
# - `*.md` のみ対象 (session-logs/.KIOKU/errors.log などは除外)
# - ファイル名は sanitized 済みなので改行を含まない前提
# - 各パターンのヒット件数を集計し、詳細は stderr に出力
# -----------------------------------------------------------------------------

TOTAL_HITS=0
HIT_DETAIL=""  # "pattern_name<TAB>count" を改行区切りで蓄積

for i in "${!PATTERNS[@]}"; do
  pat="${PATTERNS[$i]}"
  name="${PATTERN_NAMES[$i]}"

  # grep -r は session-logs/ 配下を再帰スキャン。
  # --include='*.md' で対象を限定。
  # -E で ERE、-I でバイナリ除外、-c はヒット行数ではなくファイルごとの件数なので使わず
  # 明示的に行数カウントする。
  # grep はマッチ 0 件で exit 1 を返すため、`|| true` でパイプ失敗を吸収する
  # (set -o pipefail 下でも count=0 を得るため)。
  count=$({ grep -rEIho --include='*.md' -- "${pat}" "${LOGS_DIR}" 2>/dev/null || true; } | wc -l | tr -d ' ')
  count="${count:-0}"

  if [[ "${count}" -gt 0 ]]; then
    TOTAL_HITS=$((TOTAL_HITS + count))
    HIT_DETAIL+="${name}	${count}"$'\n'
  fi
done

# -----------------------------------------------------------------------------
# 出力
# -----------------------------------------------------------------------------

if [[ "${JSON_MODE}" == "1" ]]; then
  # VULN-007: jq で構造的に JSON を生成 (パス文字列のエスケープ漏れ防止)
  if command -v jq >/dev/null 2>&1; then
    jq -n --argjson hits "${TOTAL_HITS}" --arg vault "${OBSIDIAN_VAULT}" --arg scanned "${LOGS_DIR}" \
      '{total_hits: $hits, vault: $vault, scanned: $scanned}'
  else
    # jq 不在時のフォールバック (パスに制御文字が無い前提)
    printf '{"total_hits":%d,"vault":"%s","scanned":"%s"}\n' \
      "${TOTAL_HITS}" "${OBSIDIAN_VAULT}" "${LOGS_DIR}"
  fi
else
  echo "${LOG_PREFIX} Scanning ${LOGS_DIR} ..."
  if [[ "${TOTAL_HITS}" == "0" ]]; then
    echo "${LOG_PREFIX} OK: no secret-like patterns found."
  else
    echo "${LOG_PREFIX} WARNING: ${TOTAL_HITS} potential secret leak(s) detected:"
    # HIT_DETAIL は name<TAB>count の行群
    printf '%s' "${HIT_DETAIL}" | while IFS=$'\t' read -r name count; do
      [[ -z "${name}" ]] && continue
      printf '  - %-40s %s hit(s)\n' "${name}" "${count}"
    done
    echo "${LOG_PREFIX} Review session-logs/ manually. Matching files:"
    # マッチしたファイルを列挙 (重複除去)。ヒットしたパターンのいずれかを含むファイル。
    {
      for pat in "${PATTERNS[@]}"; do
        grep -rEIl --include='*.md' -- "${pat}" "${LOGS_DIR}" 2>/dev/null || true
      done
    } | sort -u | sed 's/^/    /'
    echo "${LOG_PREFIX} If these are false positives, add the pattern to an allowlist."
    echo "${LOG_PREFIX} If they are real leaks, extend MASK_RULES in hooks/session-logger.mjs."
  fi
fi

# 漏れがあった場合は exit 2 (cron から検知したいとき用)
if [[ "${TOTAL_HITS}" -gt 0 ]]; then
  exit 2
fi
exit 0
