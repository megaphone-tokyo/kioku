#!/usr/bin/env bash
#
# verify-multi-agent-e2e.sh — KIOKU multi-agent hook の実機 E2E 検証 helper
#
# Gemini CLI / Codex CLI に KIOKU hook を install した後、1 session を走らせて
# session-logs が正しく生成されるかを対話形式で verify する。
#
# User 体験:
#   1 コマンドで CLI install 確認 → config apply → 手動 session 実行案内 →
#   session-logs 自動 verify (agent tag / masking spot check) まで完走。
#
# Usage:
#   bash scripts/verify-multi-agent-e2e.sh --agent gemini
#   bash scripts/verify-multi-agent-e2e.sh --agent codex
#   bash scripts/verify-multi-agent-e2e.sh --agent gemini --verify-only
#     # 既に session を走らせた後、session-logs だけ check
#   bash scripts/verify-multi-agent-e2e.sh --help
#
# 前提:
#   - OBSIDIAN_VAULT env 設定済
#   - jq 利用可
#   - docs/install-guide-multi-agent.md に従って Gemini / Codex の auth を
#     設定済 (API key or interactive login)
#
# Exit codes:
#   0  正常完了 (全 step pass)
#   1  fatal error (env / CLI / config 問題、verify fail)
#
# 関連:
#   - scripts/install/user/install-hooks-{gemini,codex}.sh (本 script 内部で呼ぶ)
#   - docs/install-guide-multi-agent.md (user 向け setup guide)
#   - handoff/post-release-v0-7-0.md §Checkpoint 1 (本 script の想定利用場面)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

AGENT=""
MODE="full"  # full | verify

usage() {
  cat <<'EOF'
verify-multi-agent-e2e.sh — KIOKU multi-agent hook の E2E 検証 helper

Usage:
  bash scripts/verify-multi-agent-e2e.sh --agent gemini
  bash scripts/verify-multi-agent-e2e.sh --agent codex
  bash scripts/verify-multi-agent-e2e.sh --agent <agent> --verify-only
  bash scripts/verify-multi-agent-e2e.sh --help

Flow (full mode):
  Step 1/6  CLI install 確認
  Step 2/6  CLI auth 確認 (best-effort、session 起動時に確定検証)
  Step 3/6  KIOKU hook apply (install-hooks-<agent>.sh --apply)
  Step 4/6  config verify (~/.<agent>/settings.json / hooks.json の構造確認)
  Step 5/6  1 session 手動実行 (user 介入)
  Step 6/6  session-logs verify (agent tag / masking spot check)

Flow (--verify-only):
  Step 6 だけ実行、既に手動 session 済の場合に使う。

環境変数:
  OBSIDIAN_VAULT       Vault root (必須)
  KIOKU_VERIFY_DEBUG   "1" で詳細 trace 出力 (jq の full dump など)

Scope 外:
  - Claude Code hook (install-hooks.sh で従来から verify 可能)
  - OpenCode adapter (v0.7.0 では scope 外、v0.7.x+ demand 次第)

Related docs:
  - docs/install-guide-multi-agent.md (setup 全体の正典)
  - handoff/post-release-v0-7-0.md §Checkpoint 1 (運用手順)
EOF
}

# --- arg parse ---
for arg in "$@"; do
  case "${arg}" in
    --agent=*) AGENT="${arg#--agent=}" ;;
    --agent)
      echo "ERROR: --agent は --agent=<name> 形式で指定してください (例: --agent=gemini)" >&2
      exit 1
      ;;
    --verify-only) MODE="verify" ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "unknown argument: ${arg}" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# --- precondition checks ---
if [[ -z "${AGENT}" ]]; then
  echo "ERROR: --agent=<gemini|codex> を指定してください" >&2
  usage >&2
  exit 1
fi

if [[ "${AGENT}" != "gemini" && "${AGENT}" != "codex" ]]; then
  echo "ERROR: --agent は 'gemini' or 'codex' のみ対応 (Claude は install-hooks.sh / OpenCode は v0.7.x+ scope)" >&2
  exit 1
fi

if [[ -z "${OBSIDIAN_VAULT:-}" ]]; then
  echo "ERROR: OBSIDIAN_VAULT env が未設定です" >&2
  echo "  ~/.zshrc or ~/.bashrc に以下を追加してください:" >&2
  echo "    export OBSIDIAN_VAULT=\"\$HOME/path/to/your/vault\"" >&2
  exit 1
fi

if [[ ! -d "${OBSIDIAN_VAULT}" ]]; then
  echo "ERROR: OBSIDIAN_VAULT=${OBSIDIAN_VAULT} が directory として存在しません" >&2
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq が必要です (brew install jq)" >&2
  exit 1
fi

# --- agent-specific vars ---
if [[ "${AGENT}" == "gemini" ]]; then
  CLI_NAME="gemini"
  INSTALL_HINT="npm install -g @google/gemini-cli"
  CONFIG_PATH="${HOME}/.gemini/settings.json"
  INSTALL_HOOKS_SCRIPT="${SCRIPT_DIR}/install/user/install-hooks-gemini.sh"
  EXPECTED_HOOK_KEYS=("BeforeAgent" "AfterAgent" "AfterTool" "SessionEnd")
else  # codex
  CLI_NAME="codex"
  INSTALL_HINT="npm install -g @openai/codex"
  CONFIG_PATH="${HOME}/.codex/hooks.json"
  INSTALL_HOOKS_SCRIPT="${SCRIPT_DIR}/install/user/install-hooks-codex.sh"
  EXPECTED_HOOK_KEYS=("SessionStart" "UserPromptSubmit" "Stop" "PostToolUse")
fi

# --- helpers ---
info() { printf "\n\033[1;34m[INFO]\033[0m %s\n" "$*"; }
success() { printf "\033[1;32m[\xe2\x9c\x93]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[!]\033[0m %s\n" "$*" >&2; }
fail() { printf "\033[1;31m[x]\033[0m %s\n" "$*" >&2; }
pause() { read -r -p "  Enter で続行 (Ctrl-C で中断) > " _; }

debug() {
  [[ "${KIOKU_VERIFY_DEBUG:-0}" == "1" ]] && printf "\033[2m[debug]\033[0m %s\n" "$*" >&2
}

# --- Step 1: CLI install ---
check_cli_install() {
  info "Step 1/6: ${CLI_NAME} CLI install 確認"
  if ! command -v "${CLI_NAME}" &>/dev/null; then
    fail "${CLI_NAME} CLI が PATH に無い"
    echo "  install 方法 (目安):"
    echo "    ${INSTALL_HINT}"
    echo ""
    echo "  install 後に本 script を再実行してください"
    exit 1
  fi
  local version
  version="$("${CLI_NAME}" --version 2>&1 | head -1 || echo "version unknown")"
  success "${CLI_NAME} found: ${version}"
}

# --- Step 2: CLI auth (best-effort) ---
check_cli_auth() {
  info "Step 2/6: ${CLI_NAME} auth 状態 (best-effort、session 実行時に確定検証)"
  echo "  auth 未設定の場合、Step 5 の session 実行時に CLI が login を促します。"
  echo "  その場合の設定方法は docs/install-guide-multi-agent.md の ${CLI_NAME} section 参照。"
  success "Step 2 は告知のみ (fail 無し、session 時に CLI 側で検証される)"
}

# --- Step 3: KIOKU hook apply ---
apply_kioku_hooks() {
  info "Step 3/6: KIOKU hook を ${CLI_NAME} に apply"

  if [[ ! -x "${INSTALL_HOOKS_SCRIPT}" ]]; then
    fail "${INSTALL_HOOKS_SCRIPT} が実行不能"
    exit 1
  fi

  echo "  現状 probe (書き換えなし):"
  echo ""
  bash "${INSTALL_HOOKS_SCRIPT}" --probe || true
  echo ""
  echo "  問題無ければ --apply で idempotent merge します。"
  pause
  bash "${INSTALL_HOOKS_SCRIPT}" --apply
  success "${INSTALL_HOOKS_SCRIPT} --apply 完了"
}

# --- Step 4: config verify ---
verify_config() {
  info "Step 4/6: ${CONFIG_PATH} の hook 登録確認"

  if [[ ! -f "${CONFIG_PATH}" ]]; then
    fail "${CONFIG_PATH} not found (apply が失敗した可能性)"
    exit 1
  fi

  if ! jq empty "${CONFIG_PATH}" 2>/dev/null; then
    fail "${CONFIG_PATH} が valid JSON ではない"
    exit 1
  fi

  local registered_keys
  registered_keys="$(jq -r '.hooks | keys | join(",")' "${CONFIG_PATH}" 2>/dev/null || echo "")"

  if [[ -z "${registered_keys}" ]]; then
    fail "${CONFIG_PATH} の .hooks が空 or 欠落"
    exit 1
  fi

  echo "  登録済 hook event: ${registered_keys}"

  local missing=()
  for key in "${EXPECTED_HOOK_KEYS[@]}"; do
    if ! jq -e --arg k "${key}" '.hooks[$k]' "${CONFIG_PATH}" >/dev/null 2>&1; then
      missing+=("${key}")
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    warn "期待 event の一部が未登録: ${missing[*]}"
    warn "install-hooks-${AGENT}.sh --apply が途中で失敗した可能性、再実行推奨"
    # not fatal — verify-only モードなら warning だけで続行
  else
    success "期待 event ${#EXPECTED_HOOK_KEYS[@]} 件 (${EXPECTED_HOOK_KEYS[*]}) すべて登録済"
  fi

  if [[ "${KIOKU_VERIFY_DEBUG:-0}" == "1" ]]; then
    echo ""
    echo "  --- debug: full hooks 構造 ---"
    jq '.hooks' "${CONFIG_PATH}"
    echo "  --- end debug ---"
  fi
}

# --- Step 5: prompt user for manual session ---
prompt_manual_session() {
  info "Step 5/6: ${CLI_NAME} で 1 session を手動実行"
  cat <<EOF

  以下を**別 terminal window** で実行してください:

    export OBSIDIAN_VAULT="${OBSIDIAN_VAULT}"
    ${CLI_NAME}

  プロンプトに適当な入力 (例: "list 3 files in current directory")、
  応答受信後に /exit or Ctrl-D で session 終了。

  **任意 (masking verify)**: fake API key を含む prompt も 1 回試すと
  masking pipeline の実測検証になります:

    "here is my fake key sk-proj-1234567890abcdefghij, help me debug"

  別 terminal で session が終了したら、ここに戻って Enter を押してください。

EOF
  pause
}

# --- Step 6: session-logs verify ---
verify_session_logs() {
  info "Step 6/6: ${OBSIDIAN_VAULT}/session-logs/ の最新 file を verify"

  local logs_dir="${OBSIDIAN_VAULT}/session-logs"
  if [[ ! -d "${logs_dir}" ]]; then
    fail "${logs_dir} が存在しません"
    echo "  hook が一度も発火していない可能性。Step 5 の session が起動したか、"
    echo "  または install-hooks-${AGENT}.sh --apply が成功したか再確認してください。"
    exit 1
  fi

  # find newest .md file (dotfile 除外) — macOS + Linux 互換で stat -c の代わりに ls -t
  local newest
  newest="$(ls -t "${logs_dir}"/*.md 2>/dev/null | head -1 || echo "")"

  if [[ -z "${newest}" || ! -f "${newest}" ]]; then
    fail "${logs_dir} 配下に .md ファイルが見つかりません"
    echo "  hook が発火しているか CLI 側 error log を確認してください:"
    echo "    ls -la ${logs_dir}/.claude-brain/ 2>/dev/null | tail -20"
    exit 1
  fi

  echo "  最新 session-log: $(basename "${newest}")"

  # mtime が 10 分以内か (Step 5 直後想定)
  local now_epoch
  local file_epoch
  now_epoch="$(date +%s)"
  if stat -f "%m" "${newest}" &>/dev/null; then
    # macOS BSD stat
    file_epoch="$(stat -f "%m" "${newest}")"
  else
    # GNU stat
    file_epoch="$(stat -c "%Y" "${newest}")"
  fi
  local age_sec=$((now_epoch - file_epoch))

  if (( age_sec > 600 )); then
    warn "最新 file の mtime が 10 分以上前 (${age_sec} 秒前)"
    warn "Step 5 の session 実行前の古い log を見ている可能性"
    warn "${CLI_NAME} session を今すぐ走らせて、--verify-only で再実行してください"
  else
    success "最新 file は ${age_sec} 秒前に更新 (Step 5 session が記録したと推定)"
  fi

  echo ""
  echo "  --- frontmatter (最初の --- 〜 次の --- まで) ---"
  awk '/^---$/ {count++; print; if (count==2) exit; next} count>=1 {print}' "${newest}" | head -30
  echo ""

  # agent tag check (frontmatter 内 agent: <agent>)
  # v0.7.1 §41: buildFrontmatter は `agent: <agent>` field を type: 直後に emit する。
  # multi-agent indexing / filtering の整合性のため必須化済 (open-issues §41 RESOLVED)。
  if grep -E "^agent:\s*${AGENT}\s*$" "${newest}" >/dev/null 2>&1; then
    success "frontmatter に 'agent: ${AGENT}' あり"
  else
    fail "frontmatter に 'agent: ${AGENT}' field 不在 (v0.7.1 §41 で実装済のはず、buildFrontmatter を再確認)"
    echo "  期待: 最新 session log の冒頭 frontmatter に '^agent: ${AGENT}\$' line"
    echo "  file: ${newest}"
    exit 1
  fi

  # masking spot check — sk-proj- / sk-ant- / ghp_ 等の unmasked API key
  local unmasked_patterns=("sk-proj-[a-zA-Z0-9]{10,}" "sk-ant-[a-zA-Z0-9]{10,}" "ghp_[a-zA-Z0-9]{20,}" "AKIA[0-9A-Z]{16}")
  local found_unmasked=0
  for pat in "${unmasked_patterns[@]}"; do
    if grep -qE "${pat}" "${newest}" 2>/dev/null; then
      fail "CRITICAL: session-log に unmasked API key-like pattern が残存: ${pat}"
      echo "  file: ${newest}"
      found_unmasked=1
    fi
  done

  if [[ ${found_unmasked} -eq 1 ]]; then
    echo ""
    fail "masking pipeline に bug の可能性。handoff/open-issues.md に緊急登録 + v0.7.1 hotfix 判断が必要。"
    exit 1
  fi

  success "masking spot check pass (上記 pattern の unmasked 残存なし)"

  echo ""
  echo "  目視 review 推奨:"
  echo "    less '${newest}'"
  echo ""
  echo "  確認ポイント:"
  echo "    - User prompt section に入力した内容が記録されているか (masking 適用後)"
  echo "    - Assistant response section に応答が記録されているか"
  echo "    - Tool use (tool 呼び出した場合) が記録されているか"
}

# --- Codex 固有の post-check: per-turn git-sync ---
verify_codex_git_sync() {
  if [[ "${AGENT}" != "codex" ]]; then
    return 0
  fi
  info "追加: Codex per-turn git-sync 動作確認"
  cd "${OBSIDIAN_VAULT}"
  local recent_auto_commits
  recent_auto_commits="$(git log --oneline --since="15 minutes ago" --grep="^auto: wiki update" 2>/dev/null | wc -l | tr -d ' ')"
  echo "  直近 15 分で 'auto: wiki update' commit: ${recent_auto_commits} 件"
  if [[ "${recent_auto_commits}" -gt 0 ]]; then
    success "per-turn git-sync 動作確認 (wiki/ 変更有る turn で commit 発生)"
    echo "  想定: session 中に wiki/ を変更する turn だけ commit、無変更 turn は 0 commit"
  else
    echo "  (情報): wiki/ 無変更なら 0 が正常 (skip-on-no-changes 設計、IH-CODEX-GIT-SYNC-2 で固定)"
    echo "  wiki/ を session 中に編集する prompt で再 verify 推奨 (例: 'create a note in wiki/test.md')"
  fi
}

# --- main flow ---
echo ""
echo "=========================================="
echo "  KIOKU multi-agent E2E verify"
echo "  Agent  : ${AGENT}"
echo "  Vault  : ${OBSIDIAN_VAULT}"
echo "  Mode   : ${MODE}"
echo "=========================================="

if [[ "${MODE}" == "verify" ]]; then
  verify_session_logs
  verify_codex_git_sync
  echo ""
  echo "=========================================="
  echo "  verify-only 完了"
  echo "=========================================="
  exit 0
fi

check_cli_install
check_cli_auth
apply_kioku_hooks
verify_config
prompt_manual_session
verify_session_logs
verify_codex_git_sync

echo ""
echo "=========================================="
echo "  E2E verify 完了 - ${AGENT}"
echo "=========================================="
echo ""
echo "次 step:"
echo "  - 問題発見: handoff/open-issues.md に registered、v0.7.1 で fix"
echo "  - Critical / Hard revert trigger 該当: handoff/post-release-v0-7-0.md §Rollback policy 参照"
echo "  - 両 agent (gemini + codex) pass したら handoff/post-release-v0-7-0.md"
echo "    の Checkpoint 1 に ✓ verified 追記"
