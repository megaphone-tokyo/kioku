#!/usr/bin/env bash
#
# install-hooks-codex.sh — Codex CLI ~/.codex/hooks.json に claude-brain
# hook を idempotent に登録する。
#
# Codex CLI 特有:
#   - Hooks file は ~/.codex/hooks.json (JSON primary、TOML 同等可)
#   - Feature flag を ~/.codex/config.toml に [features] codex_hooks = true
#     として設定する必要あり (2026-04-23 PR #19012 で stable、次 release 以降は
#     default-on。現行 0.124.x では明示設定が必要。A2 version gating)
#   - SessionEnd event 無し → Stop event で 2 段 hook (adapter → git-sync shell)
#     emulate (PM A1 指示、IH-CODEX-GIT-SYNC-1/2 で pin)
#   - PostToolUse は Bash のみ (Edit/Write/MultiEdit は Codex 自体が hook 発火しない)
#
# 使い方:
#   bash install-hooks-codex.sh              # stdout にスニペットを出す (非破壊)
#   bash install-hooks-codex.sh --apply      # ~/.codex/hooks.json にマージ (要 jq)
#   bash install-hooks-codex.sh --apply --yes
#   bash install-hooks-codex.sh --probe      # A2: Codex hooks feature-availability probe
#
# 環境変数:
#   OBSIDIAN_VAULT          (required)
#   CODEX_HOOKS_FILE        (optional、test 用)、未設定時は $HOME/.codex/hooks.json
#   CODEX_CONFIG_FILE       (optional、test 用)、未設定時は $HOME/.codex/config.toml
#
# 終了コード: 0 正常、1 OBSIDIAN_VAULT 不正、2 merge fail、3 probe fail

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ADAPTER_ABS="$(cd "${SCRIPT_DIR}/.." && pwd)/hooks/adapters/codex.mjs"
SYNC_VAULT_ABS="$(cd "${SCRIPT_DIR}/.." && pwd)/hooks/sync-vault.mjs"

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
    *) echo "unknown argument: ${arg}" >&2 ; exit 1 ;;
  esac
done

# -----------------------------------------------------------------------------
# A2: Codex hooks feature-availability probe (specific version 番号 avoid)
# -----------------------------------------------------------------------------
probe_codex_hooks() {
  if ! command -v codex >/dev/null 2>&1; then
    echo "probe: 'codex' CLI not found in PATH. Install it first." >&2
    return 3
  fi
  local help_output
  help_output="$(codex --help 2>&1 || true)"
  # Codex CLI の docs で hooks サブコマンド or hooks.json 言及があることを検出
  if ! echo "${help_output}" | grep -iqE "hook|features"; then
    echo "probe: Codex CLI 'hooks' / 'features' keyword not found in --help output." >&2
    echo "       Upgrade to a Codex CLI release with codex_hooks support (PR #19012 / 2026-04-23+)." >&2
    return 3
  fi
  echo "probe: Codex CLI found (feature-availability check passed)"
  return 0
}

if [[ "${PROBE_ONLY}" == "1" ]]; then
  probe_codex_hooks && exit 0 || exit $?
fi

validate_vault_path() {
  local p="$1"
  local safe_re='^[a-zA-Z0-9/._[:space:]-]+$'
  if [[ ! "${p}" =~ $safe_re ]]; then
    echo "error: OBSIDIAN_VAULT contains unsafe characters: ${p}" >&2
    exit 1
  fi
}

if [[ -z "${OBSIDIAN_VAULT:-}" ]]; then
  echo "error: OBSIDIAN_VAULT is not set." >&2
  exit 1
fi
validate_vault_path "${OBSIDIAN_VAULT}"

WARNINGS=()
[[ -d "${OBSIDIAN_VAULT}" ]] || WARNINGS+=("OBSIDIAN_VAULT path does not exist: ${OBSIDIAN_VAULT}")
if [[ -d "${OBSIDIAN_VAULT}" ]]; then
  git -C "${OBSIDIAN_VAULT}" rev-parse --show-toplevel >/dev/null 2>&1 || \
    WARNINGS+=("Vault is not a git repo. SessionStart/Stop git-sync will silently fail until git init + remote.")
fi
command -v node >/dev/null 2>&1 || WARNINGS+=("'node' not found")
[[ -f "${ADAPTER_ABS}" ]] || WARNINGS+=("Codex adapter not found at: ${ADAPTER_ABS}")

# -----------------------------------------------------------------------------
# hooks.json snippet
#
# **重要 (PM A1 指示)**: Stop event の git-sync shell one-liner は
# scripts/install-hooks.sh の Claude SessionEnd snippet と **byte-identical**
# を維持する (single source of truth、drift 防止)。
# `git add wiki/ raw-sources/ templates/ CLAUDE.md` の引数順序 + 全体 shell 構文
# が completely 同形。`--allow-empty` **未使用** で skip-on-no-changes 保証。
#
# **Timeout 単位 (PR #56 MF-B review fix)**: Codex CLI の hook timeout field は
# **秒単位** (research/codex-cli-hook-spec.md + `codex-rs/hooks/src/engine/command_runner.rs:71`
# で確認済)。Gemini CLI の `timeout` field はミリ秒単位なので混同禁止。本 script
# では Codex 側の unit ambiguity を避けるため、仕様上 alias 扱いされる
# **`timeoutSec`** key (明示) を採用する。値は秒数、下記のとおり:
#   - UserPromptSubmit / PostToolUse / Stop adapter: 30 秒 / 30 秒 / 60 秒
#   - Stop stage 2 git-sync: 60 秒 (push 遅延対策で adapter と同値に bump、PR #56 review)
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
            "command": "OBSIDIAN_VAULT=\"${OBSIDIAN_VAULT}\" node '${SYNC_VAULT_ABS}' --pull-and-retry"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "OBSIDIAN_VAULT=\"${OBSIDIAN_VAULT}\" node '${ADAPTER_ABS}'",
            "timeoutSec": 30
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "OBSIDIAN_VAULT=\"${OBSIDIAN_VAULT}\" node '${ADAPTER_ABS}'",
            "timeoutSec": 30
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "OBSIDIAN_VAULT=\"${OBSIDIAN_VAULT}\" node '${ADAPTER_ABS}'",
            "timeoutSec": 60
          },
          {
            "type": "command",
            "command": "OBSIDIAN_VAULT=\"${OBSIDIAN_VAULT}\" node '${SYNC_VAULT_ABS}' --push",
            "timeoutSec": 60
          }
        ]
      }
    ]
  }
}
EOF
}

# -----------------------------------------------------------------------------
# Feature flag 有効化 (~/.codex/config.toml に [features] codex_hooks = true)
# -----------------------------------------------------------------------------
ensure_feature_flag() {
  local config="${CODEX_CONFIG_FILE:-${HOME}/.codex/config.toml}"
  mkdir -p "$(dirname "${config}")"
  if [[ -f "${config}" ]] && grep -q "codex_hooks" "${config}"; then
    echo "feature flag: already present in ${config}"
    return 0
  fi
  {
    echo ""
    echo "# claude-brain: enable codex_hooks (stable PR #19012, may be default-on in future releases)"
    echo "[features]"
    echo "codex_hooks = true"
  } >> "${config}"
  echo "feature flag: appended [features] codex_hooks = true to ${config}"
}

# -----------------------------------------------------------------------------
# --apply: ~/.codex/hooks.json に idempotent マージ + feature flag 設定
# -----------------------------------------------------------------------------
apply_merge() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "error: jq is required for --apply" >&2
    exit 2
  fi

  local target="${CODEX_HOOKS_FILE:-${HOME}/.codex/hooks.json}"
  mkdir -p "$(dirname "${target}")"

  if [[ ! -f "${target}" ]]; then
    echo '{}' > "${target}"
    echo "note: created empty ${target}"
  fi

  if ! jq -e . "${target}" >/dev/null 2>&1; then
    echo "error: ${target} is not valid JSON. Refusing to touch it." >&2
    exit 2
  fi

  local snippet_file merged_file backup
  snippet_file="$(mktemp)"
  merged_file="$(mktemp)"
  emit_snippet_json > "${snippet_file}"

  if ! jq -e . "${snippet_file}" >/dev/null 2>&1; then
    echo "error: generated snippet is not valid JSON (bug)" >&2
    rm -f "${snippet_file}"
    exit 2
  fi

  backup="${target}.bak.$(date +%Y%m%d-%H%M%S)"
  cp "${target}" "${backup}"

  # idempotent マージ (install-hooks.sh と同 logic)
  #
  # PR #56 SF-A review fix: dedup selector を matcher-wrapped (Codex SessionStart /
  # PostToolUse の pattern) と non-matcher (UserPromptSubmit / Stop) + bare command
  # (legacy user customization) の 3 形態で robust に evaluate する。
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
    echo "error: merge produced invalid JSON. Backup: ${backup}" >&2
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
      *) echo "aborted. backup left at ${backup}" ; rm -f "${snippet_file}" "${merged_file}" ; exit 2 ;;
    esac
  fi

  mv "${merged_file}" "${target}"
  rm -f "${snippet_file}"

  if [[ -f "${ADAPTER_ABS}" ]]; then
    chmod 755 "${ADAPTER_ABS}"
  fi

  # Feature flag 設定 (config.toml)
  ensure_feature_flag

  echo "applied. to rollback: mv ${backup} ${target}"
}

if [[ "${APPLY_MODE}" == "1" ]]; then
  if [[ "${#WARNINGS[@]}" -gt 0 ]]; then
    echo "WARNINGS:" >&2
    for w in "${WARNINGS[@]}"; do echo "  - ${w}" >&2; done
  fi
  apply_merge
  exit 0
fi

cat <<EOF
# ============================================================================
# claude-brain Codex CLI hook configuration
# ============================================================================
#
# This script does NOT modify ~/.codex/hooks.json unless you pass --apply.
#
# Resolved paths:
#   OBSIDIAN_VAULT  = ${OBSIDIAN_VAULT}
#   Codex adapter   = ${ADAPTER_ABS}
#
# Feature-availability probe (A2 version gating):
#   Run 'bash install-hooks-codex.sh --probe' to verify Codex CLI is installed.
#   --apply automatically enables [features] codex_hooks = true in
#   ~/.codex/config.toml (required until default-on in upcoming releases).
EOF

if [[ "${#WARNINGS[@]}" -gt 0 ]]; then
  echo "#"
  echo "# WARNINGS:"
  for w in "${WARNINGS[@]}"; do echo "#   - ${w}"; done
fi

cat <<'EOF'
#
# Known limitations (v0.7.0 Q2):
#   - hot.md opt-in prompt is Claude Code-only (MF4). Codex does not emit it.
#   - SessionEnd event does NOT exist in Codex CLI. We emulate via 2-stage Stop
#     hook: (1) node adapters/codex.mjs logs the turn, (2) shell one-liner
#     does git add/commit/push. Fires per-turn (not per-session) but commits
#     only when wiki/ actually changed (--allow-empty NOT used).
#   - PostToolUse captures Bash tool only. Edit/Write/MultiEdit are not hooked
#     by Codex CLI itself; auto-ingest's transcript parser captures them
#     offline as a complementary mechanism.
#   - Windows is unsupported (Codex CLI disables hooks on Windows).
#
# ============================================================================
# JSON snippet to merge into ~/.codex/hooks.json
# ============================================================================
EOF

emit_snippet_json

cat <<EOF

# ============================================================================
# Verification
# ============================================================================
#
#   After merging, restart Codex CLI and run one prompt. Then check:
#     ls "\${OBSIDIAN_VAULT}/session-logs/"
#   A new Markdown file should appear. Commits to the Vault git repo
#   will happen on each Stop event (per-turn) if wiki/ has real changes.
#
EOF
