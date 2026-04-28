#!/usr/bin/env bash
#
# install-hooks-gemini.sh — Gemini CLI ~/.gemini/settings.json に claude-brain
# hook を idempotent に登録する。
#
# 使い方:
#   bash install-hooks-gemini.sh              # stdout にスニペットを出す (非破壊)
#   bash install-hooks-gemini.sh --apply      # ~/.gemini/settings.json にマージ (要 jq)
#   bash install-hooks-gemini.sh --apply --yes  # 確認プロンプトを飛ばす
#   bash install-hooks-gemini.sh --probe      # A2: Gemini hooks feature-availability probe のみ
#
# 環境変数:
#   OBSIDIAN_VAULT          (required) Vault ルートの絶対パス
#   GEMINI_SETTINGS_FILE    (optional、test 用) 書き込み先を差し替える。
#                           未設定時は $HOME/.gemini/settings.json
#
# 終了コード:
#   0  正常終了
#   1  OBSIDIAN_VAULT 未設定 / 不正な path
#   2  --apply 時の jq 不在 / マージ失敗 / キャンセル
#   3  --probe 失敗 (Gemini CLI 未 install or hook system 未提供)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ADAPTER_ABS="$(cd "${SCRIPT_DIR}/.." && pwd)/hooks/adapters/gemini.mjs"

# -----------------------------------------------------------------------------
# 引数パース
# -----------------------------------------------------------------------------
APPLY_MODE=0
ASSUME_YES=0
PROBE_ONLY=0
for arg in "$@"; do
  case "${arg}" in
    --apply) APPLY_MODE=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --probe) PROBE_ONLY=1 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: ${arg}" >&2
      exit 1
      ;;
  esac
done

# -----------------------------------------------------------------------------
# A2: Gemini hooks feature-availability probe
#
# 現時点の Gemini CLI は hooks system を提供済 (research doc 参照、docs/hooks/)。
# specific version 番号での gating は避け、実行時 probe で確認する。
# -----------------------------------------------------------------------------
probe_gemini_hooks() {
  if ! command -v gemini >/dev/null 2>&1; then
    echo "probe: 'gemini' CLI not found in PATH. Install @google/gemini-cli first." >&2
    echo "  npm install -g @google/gemini-cli" >&2
    return 3
  fi
  # gemini --help に "hooks" / "settings.json" keyword があれば OK
  # (feature-availability 方式、specific version 番号比較は避ける)
  local help_output
  help_output="$(gemini --help 2>&1 || true)"
  if ! echo "${help_output}" | grep -iqE "hook|settings\.json"; then
    echo "probe: Gemini CLI 'hooks' / 'settings.json' keyword not found in --help output." >&2
    echo "       Upgrade to a recent Gemini CLI release (docs/hooks/ must exist in the CLI docs)." >&2
    return 3
  fi
  echo "probe: Gemini CLI found with hook support"
  return 0
}

if [[ "${PROBE_ONLY}" == "1" ]]; then
  probe_gemini_hooks && exit 0 || exit $?
fi

# -----------------------------------------------------------------------------
# OBSIDIAN_VAULT validation (install-hooks.sh と同形式、VULN-004)
# -----------------------------------------------------------------------------
validate_vault_path() {
  local p="$1"
  local safe_re='^[a-zA-Z0-9/._[:space:]-]+$'
  if [[ ! "${p}" =~ $safe_re ]]; then
    echo "error: OBSIDIAN_VAULT contains unsafe characters: ${p}" >&2
    exit 1
  fi
}

if [[ -z "${OBSIDIAN_VAULT:-}" ]]; then
  cat >&2 <<'EOF'
error: OBSIDIAN_VAULT is not set.

Please set the environment variable first:

  export OBSIDIAN_VAULT="$HOME/claude-brain/main-claude-brain"

Then re-run this script.
EOF
  exit 1
fi

validate_vault_path "${OBSIDIAN_VAULT}"

# -----------------------------------------------------------------------------
# 前提条件チェック (warn のみ、install-hooks.sh と揃える)
# -----------------------------------------------------------------------------
WARNINGS=()

if [[ ! -d "${OBSIDIAN_VAULT}" ]]; then
  WARNINGS+=("OBSIDIAN_VAULT path does not exist: ${OBSIDIAN_VAULT}")
fi

if [[ -d "${OBSIDIAN_VAULT}" ]]; then
  if ! git -C "${OBSIDIAN_VAULT}" rev-parse --show-toplevel >/dev/null 2>&1; then
    WARNINGS+=("Vault is not inside a git repository. SessionStart pull / SessionEnd push will fail silently until git init + remote configured.")
  fi
fi

if [[ -f "${OBSIDIAN_VAULT}/.gitignore" ]]; then
  if ! grep -q "^session-logs/" "${OBSIDIAN_VAULT}/.gitignore" 2>/dev/null; then
    WARNINGS+=("Vault .gitignore missing 'session-logs/' entry. Run setup-vault.sh first.")
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  WARNINGS+=("'node' command not found. Install Node.js 18+ before enabling hooks.")
fi

if [[ ! -f "${ADAPTER_ABS}" ]]; then
  WARNINGS+=("Gemini adapter not found at: ${ADAPTER_ABS}")
fi

# -----------------------------------------------------------------------------
# Gemini v2 hook JSON スニペット
#
# tool matcher は Gemini snake_case: run_shell_command|replace|write_file
# (Claude の Bash|Edit|Write|MultiEdit と対応、research doc §Tool-name mapping 参照)
# -----------------------------------------------------------------------------
emit_snippet_json() {
  cat <<EOF
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "cd \"${OBSIDIAN_VAULT}\" && git pull --rebase --quiet 2>/dev/null || true"
          }
        ]
      }
    ],
    "BeforeAgent": [
      {
        "matcher": "*",
        "hooks": [
          {
            "name": "claude-brain-user-prompt",
            "type": "command",
            "command": "OBSIDIAN_VAULT=\"${OBSIDIAN_VAULT}\" node '${ADAPTER_ABS}'",
            "timeout": 10000
          }
        ]
      }
    ],
    "AfterAgent": [
      {
        "matcher": "*",
        "hooks": [
          {
            "name": "claude-brain-assistant-stop",
            "type": "command",
            "command": "OBSIDIAN_VAULT=\"${OBSIDIAN_VAULT}\" node '${ADAPTER_ABS}'",
            "timeout": 10000
          }
        ]
      }
    ],
    "AfterTool": [
      {
        "matcher": "run_shell_command|replace|write_file",
        "hooks": [
          {
            "name": "claude-brain-tool-use",
            "type": "command",
            "command": "OBSIDIAN_VAULT=\"${OBSIDIAN_VAULT}\" node '${ADAPTER_ABS}'",
            "timeout": 10000
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "*",
        "hooks": [
          {
            "name": "claude-brain-session-end",
            "type": "command",
            "command": "OBSIDIAN_VAULT=\"${OBSIDIAN_VAULT}\" node '${ADAPTER_ABS}'",
            "timeout": 30000
          },
          {
            "name": "claude-brain-git-sync",
            "type": "command",
            "command": "[ \"\${KIOKU_NO_LOG:-0}\" = \"1\" ] || { cd \"${OBSIDIAN_VAULT}\" && grep -q '^session-logs/' .gitignore 2>/dev/null && git symbolic-ref -q HEAD >/dev/null 2>&1 && git add wiki/ raw-sources/ templates/ CLAUDE.md 2>/dev/null && (git diff --cached --quiet || (git commit -m \"auto: wiki update \$(date +%Y%m%d-%H%M)\" --quiet && git push --quiet)) 2>/dev/null; } || true",
            "timeout": 30000
          }
        ]
      }
    ]
  }
}
EOF
}

# -----------------------------------------------------------------------------
# --apply: ~/.gemini/settings.json に idempotent マージ (install-hooks.sh と同 pattern)
# -----------------------------------------------------------------------------
apply_merge() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "error: jq is required for --apply but was not found in PATH" >&2
    exit 2
  fi

  local target="${GEMINI_SETTINGS_FILE:-${HOME}/.gemini/settings.json}"
  mkdir -p "$(dirname "${target}")"

  if [[ ! -f "${target}" ]]; then
    echo '{}' > "${target}"
    echo "note: created empty ${target}"
  fi

  if ! jq -e . "${target}" >/dev/null 2>&1; then
    echo "error: ${target} is not valid JSON. Refusing to touch it." >&2
    exit 2
  fi

  local snippet_file
  snippet_file="$(mktemp)"
  emit_snippet_json > "${snippet_file}"

  if ! jq -e . "${snippet_file}" >/dev/null 2>&1; then
    echo "error: generated snippet is not valid JSON (bug)" >&2
    rm -f "${snippet_file}"
    exit 2
  fi

  local backup="${target}.bak.$(date +%Y%m%d-%H%M%S)"
  cp "${target}" "${backup}"

  local merged_file
  merged_file="$(mktemp)"

  # idempotent マージ (install-hooks.sh と同 logic): 各 event key について、
  # 既存配列から「新エントリと同一 command を持つエントリ」を除去し、new を append。
  #
  # PR #56 SF-A review fix: dedup selector を matcher-wrapped (Gemini/Codex の
  # 新 install pattern) と non-matcher (Claude 既存 pattern) + bare command
  # (legacy user customization) の 3 形態で robust に evaluate する。
  #   (.command // .hooks[0].command // "") は以下を順次試す:
  #     1. bare `{"type": "command", "command": "..."}` 形 → .command
  #     2. 包装 `{"hooks": [{"command": "..."}]}` 形 → .hooks[0].command
  #     3. その他 → "" (dedup skip、safety 側)
  jq --slurpfile snippet "${snippet_file}" '
    . as $old |
    ($snippet[0]) as $new |
    ($old.hooks // {}) as $old_hooks |
    ($new.hooks) as $new_hooks |
    reduce ($new_hooks | keys[]) as $k (
      $old;
      .hooks = (
        (.hooks // {}) |
        .[$k] = (
          (((.[$k] // []) |
            map(
              select(
                (.command // .hooks[0].command // "") as $c |
                ($c == "") or
                ([$new_hooks[$k][] | (.command // .hooks[0].command // "")] | index($c)) == null
              )
            )
          ) + $new_hooks[$k])
        )
      )
    )
  ' "${target}" > "${merged_file}"

  if ! jq -e . "${merged_file}" >/dev/null 2>&1; then
    echo "error: merge produced invalid JSON. Backup kept at ${backup}" >&2
    rm -f "${snippet_file}" "${merged_file}"
    exit 2
  fi

  echo "=== diff (old → new) ==="
  diff -u "${target}" "${merged_file}" || true
  echo "========================"
  echo "target:  ${target}"
  echo "backup:  ${backup}"

  if [[ "${ASSUME_YES}" != "1" ]]; then
    printf "Apply this change? [y/N] "
    read -r reply
    case "${reply}" in
      y|Y|yes|YES) ;;
      *)
        echo "aborted. backup left at ${backup}"
        rm -f "${snippet_file}" "${merged_file}"
        exit 2
        ;;
    esac
  fi

  mv "${merged_file}" "${target}"
  rm -f "${snippet_file}"

  if [[ -f "${ADAPTER_ABS}" ]]; then
    chmod 755 "${ADAPTER_ABS}"
    echo "  chmod 755 ${ADAPTER_ABS}"
  fi

  echo "applied. to rollback: mv ${backup} ${target}"
}

# -----------------------------------------------------------------------------
# 分岐
# -----------------------------------------------------------------------------

if [[ "${APPLY_MODE}" == "1" ]]; then
  if [[ "${#WARNINGS[@]}" -gt 0 ]]; then
    echo "WARNINGS:" >&2
    for w in "${WARNINGS[@]}"; do
      echo "  - ${w}" >&2
    done
  fi
  apply_merge
  exit 0
fi

# デフォルト: stdout にスニペット出力
cat <<EOF
# ============================================================================
# claude-brain Gemini CLI hook configuration
# ============================================================================
#
# This script does NOT modify ~/.gemini/settings.json unless you pass --apply.
# Copy the JSON snippet below and merge it into your settings file manually,
# or re-run with --apply to let the script merge it (requires jq).
#
# Resolved paths:
#   OBSIDIAN_VAULT  = ${OBSIDIAN_VAULT}
#   Gemini adapter  = ${ADAPTER_ABS}
#
# Feature-availability probe (A2 version gating):
#   Run 'bash install-hooks-gemini.sh --probe' first to verify that
#   Gemini CLI is installed and supports hooks.
EOF

if [[ "${#WARNINGS[@]}" -gt 0 ]]; then
  echo "#"
  echo "# WARNINGS:"
  for w in "${WARNINGS[@]}"; do
    echo "#   - ${w}"
  done
fi

cat <<'EOF'
#
# Known limitations (v0.7.0 Q2):
#   - hot.md opt-in prompt is Claude Code-only (adapters/claude.mjs, MF4).
#     Gemini does not receive the KIOKU_HOT_AUTO_PROMPT systemMessage on
#     AfterAgent — this is intentional (Gemini stdout schema accepts
#     systemMessage but the hot.md workflow is currently Claude-only;
#     port tracked for v0.7.1+).
#   - Tool matcher uses Gemini's snake_case tool names (run_shell_command,
#     replace, write_file). MultiEdit-equivalent is absent in Gemini.
#
# ============================================================================
# JSON snippet to merge into ~/.gemini/settings.json
# ============================================================================
EOF

emit_snippet_json

cat <<EOF

# ============================================================================
# Verification
# ============================================================================
#
#   After merging, restart Gemini CLI and run one prompt. Then check:
#     ls "\${OBSIDIAN_VAULT}/session-logs/"
#   A new Markdown file should appear with Gemini session content.
#
EOF
