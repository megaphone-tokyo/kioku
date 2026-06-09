#!/usr/bin/env bash
#
# install.sh — KIOKU one-line installer (H1 oneline install path、LP β publish 同期)
#
# 2 path 並列で KIOKU を install する単一エントリ:
#   Mode A: Claude Code Plugin marketplace 経由 (推奨、追加実装 0、user が Claude Code 内で実行)
#   Mode C: Codex / Gemini / 一般 user 向け manual install (本 script が clone + hooks 登録を実行)
#
# 使い方:
#   bash <(curl -fsSL https://raw.githubusercontent.com/megaphone-tokyo/kioku/main/scripts/install.sh)
#   bash install.sh                       # smart default 判定 + 確認 prompt
#   bash install.sh --yes                 # 確認 prompt skip (smart default に従う)
#   bash install.sh --mode=a              # Mode A を強制 (案内のみ、user が Claude Code で実行)
#   bash install.sh --mode=c              # Mode C を強制 (clone + install-hooks chain)
#   bash install.sh --dry-run             # 何も書き込まずに plan を表示
#   bash install.sh --dry-run --mode=c    # Mode C の dispatch を dry-run mode で確認
#   bash install.sh --help                # 本 help text
#
# 環境変数:
#   OBSIDIAN_VAULT          (Mode C で required) Vault ルートの絶対パス
#   KIOKU_INSTALL_DIR       (optional) clone 先 (既定 ${HOME}/.kioku/kioku)
#   KIOKU_INSTALL_REPO      (optional、test 用) clone 元 (既定 https://github.com/megaphone-tokyo/kioku.git)
#   KIOKU_INSTALL_REF       (optional、test 用) clone ref (既定 main)
#   KIOKU_INSTALL_LOCAL     (optional、test 用) 1 なら clone を skip し、script 同梱の repo を使う
#   HOME                    (test 用に差し替え可能)
#
# 終了コード:
#   0  正常終了
#   1  argument 不正 / 必須環境変数不足
#   2  Mode C: dispatch 失敗
#   3  Mode C: clone 失敗

set -euo pipefail

# -----------------------------------------------------------------------------
# 引数 parse
# -----------------------------------------------------------------------------
DRY_RUN=0
ASSUME_YES=0
MODE_OVERRIDE=""

for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --mode=a|--mode=A) MODE_OVERRIDE="a" ;;
    --mode=c|--mode=C) MODE_OVERRIDE="c" ;;
    --mode=*) echo "ERROR: unknown mode: ${arg} (use --mode=a or --mode=c)" >&2 ; exit 1 ;;
    -h|--help)
      sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: ${arg}" >&2
      echo "       run 'bash install.sh --help' for usage." >&2
      exit 1
      ;;
  esac
done

# -----------------------------------------------------------------------------
# 環境 sensor — smart default 判定
# -----------------------------------------------------------------------------

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

# -----------------------------------------------------------------------------
# 環境表示 + Mode 決定
# -----------------------------------------------------------------------------
RECOMMENDED_MODE="$(detect_recommended_mode)"
EFFECTIVE_MODE="${MODE_OVERRIDE:-${RECOMMENDED_MODE}}"

cat <<EOF
============================================================
KIOKU one-line installer
============================================================
detected environment:
  claude code: $(has_claude_code && echo yes || echo no)
  codex cli:   $(has_codex && echo yes || echo no)
  gemini cli:  $(has_gemini && echo yes || echo no)
  existing hooks (~/.claude/settings.json):  $(has_existing_hooks && echo yes || echo no)

recommended mode:  ${RECOMMENDED_MODE}
effective mode:    ${EFFECTIVE_MODE} (override=${MODE_OVERRIDE:-none})
dry-run:           $([[ "${DRY_RUN}" == "1" ]] && echo yes || echo no)
============================================================
EOF

if has_existing_hooks; then
  cat <<'EOF'

NOTE: ~/.claude/settings.json に既存 hooks が見つかりました。
      install-hooks.sh は idempotent merge を行うため、既存設定は破壊されません。
      ただし重複を避けるため、再 install 前に diff を確認することを推奨します。

EOF
fi

# -----------------------------------------------------------------------------
# 確認 prompt (--yes / --dry-run なら skip)
# -----------------------------------------------------------------------------
if [[ "${ASSUME_YES}" != "1" && "${DRY_RUN}" != "1" ]]; then
  printf "Proceed with mode '%s'? [y/N] " "${EFFECTIVE_MODE}"
  read -r reply
  case "${reply}" in
    y|Y|yes|YES) ;;
    *)
      echo "aborted by user."
      exit 0
      ;;
  esac
fi

# -----------------------------------------------------------------------------
# Mode A: Plugin marketplace 案内 (本 script からは Plugin API 操作不可)
# -----------------------------------------------------------------------------
mode_a_print_instructions() {
  cat <<'EOF'

------------------------------------------------------------
Mode A: Claude Code Plugin marketplace install
------------------------------------------------------------
本 script は Claude Code Plugin marketplace API を直接呼べないため、
以下の 2 行を Claude Code 内 (`claude` セッション) で実行してください:

  /plugin marketplace add megaphone-tokyo/kioku
  /plugin install kioku@megaphone-tokyo

完了後の確認:
  /plugin list           # kioku が登録されていることを確認
  ls "$OBSIDIAN_VAULT/session-logs/"  # 1 prompt 流して session log 生成を確認

Claude Code CLI が見つからない場合は以下を先に install してください:
  https://docs.claude.com/en/docs/claude-code/quickstart

参考 (Codex / Gemini / 一般 user 向け fallback):
  bash install.sh --mode=c
------------------------------------------------------------
EOF
}

# -----------------------------------------------------------------------------
# Mode C: clone + install-hooks chain
# -----------------------------------------------------------------------------

# repo clone target (既存があれば skip、無ければ clone or local copy 使用)
mode_c_resolve_repo() {
  local install_dir="${KIOKU_INSTALL_DIR:-${HOME}/.kioku/kioku}"
  local install_repo="${KIOKU_INSTALL_REPO:-https://github.com/megaphone-tokyo/kioku.git}"
  local install_ref="${KIOKU_INSTALL_REF:-main}"

  # KIOKU_INSTALL_LOCAL=1 → 本 script と同階層 (= parent repo 内 / kioku 同梱状態) を repo とみなす
  if [[ "${KIOKU_INSTALL_LOCAL:-0}" == "1" ]]; then
    local local_repo
    local_repo="$(cd "$(dirname "$0")/.." && pwd)"
    echo "[mode-c] using local repo at ${local_repo} (KIOKU_INSTALL_LOCAL=1)"
    REPO_DIR="${local_repo}"
    return 0
  fi

  if [[ -d "${install_dir}/.git" ]]; then
    echo "[mode-c] repo already exists at ${install_dir}, skipping clone"
    REPO_DIR="${install_dir}"
    return 0
  fi

  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "[mode-c] [dry-run] would: git clone --depth=1 --branch=${install_ref} ${install_repo} ${install_dir}"
    REPO_DIR="${install_dir}"
    return 0
  fi

  echo "[mode-c] cloning ${install_repo} (ref=${install_ref}) into ${install_dir}"
  mkdir -p "$(dirname "${install_dir}")"
  if ! git clone --depth=1 --branch="${install_ref}" "${install_repo}" "${install_dir}"; then
    echo "ERROR: git clone failed. Verify network access and repo URL." >&2
    return 3
  fi
  REPO_DIR="${install_dir}"
}

# OBSIDIAN_VAULT 確認 (Mode C で required)
mode_c_check_vault() {
  if [[ -z "${OBSIDIAN_VAULT:-}" ]]; then
    cat >&2 <<'EOF'

ERROR: Mode C は OBSIDIAN_VAULT 環境変数が必要です。
       先に以下のように設定してください:

         export OBSIDIAN_VAULT="$HOME/claude-brain/main-claude-brain"

       既存の Obsidian Vault が無い場合は新規ディレクトリを作成してください:
         mkdir -p "$HOME/claude-brain/main-claude-brain"

       設定後に install.sh を再実行してください。

EOF
    return 1
  fi
  return 0
}

# 内部 dispatch (個別 install-*.sh を呼ぶ)
mode_c_dispatch() {
  local scripts_dir="${REPO_DIR}/scripts"
  if [[ ! -d "${scripts_dir}" ]]; then
    # parent repo layout fallback: tools/claude-brain/scripts/
    scripts_dir="${REPO_DIR}/tools/claude-brain/scripts"
  fi

  if [[ ! -d "${scripts_dir}" ]]; then
    echo "ERROR: scripts directory not found under ${REPO_DIR}" >&2
    return 2
  fi

  echo ""
  echo "------------------------------------------------------------"
  echo "Mode C dispatch chain"
  echo "  repo:    ${REPO_DIR}"
  echo "  scripts: ${scripts_dir}"
  echo "  vault:   ${OBSIDIAN_VAULT}"
  echo "  dry-run: ${DRY_RUN}"
  echo "------------------------------------------------------------"

  local steps=()

  # Step 1: Vault 初期化 (setup-vault.sh、KIOKU_DRY_RUN を dry-run mode で伝播)
  steps+=("setup-vault:setup-vault.sh")

  # Step 2: CLI 別 hook 登録 (検出した CLI に応じて選択)
  if has_claude_code; then
    steps+=("install-hooks:install-hooks.sh")
  fi
  if has_codex; then
    steps+=("install-hooks-codex:install-hooks-codex.sh")
  fi
  if has_gemini; then
    steps+=("install-hooks-gemini:install-hooks-gemini.sh")
  fi

  # Step 3: skills install (Claude Code 専用、CLI 検出時のみ)
  if has_claude_code; then
    steps+=("install-skills:install-skills.sh")
  fi

  # 何も CLI が無い場合は明示
  if [[ "${#steps[@]}" -eq 1 ]]; then
    echo ""
    echo "NOTE: Claude Code / Codex / Gemini いずれも検出されませんでした。"
    echo "      Vault 初期化のみ実行します。後で CLI を install してから:"
    echo "        bash ${scripts_dir}/install-hooks.sh --apply"
    echo "      を手動で実行してください。"
    echo ""
  fi

  local rc=0
  for step in "${steps[@]}"; do
    local name="${step%%:*}"
    local script="${step#*:}"
    local path="${scripts_dir}/${script}"

    if [[ ! -f "${path}" ]]; then
      echo "WARN: ${script} not found at ${path}, skipping" >&2
      continue
    fi

    echo ""
    echo "[mode-c] step: ${name} (${script})"
    if ! mode_c_dispatch_one "${name}" "${path}"; then
      rc=$?
      echo "ERROR: ${name} failed with exit ${rc}" >&2
      return 2
    fi
  done

  echo ""
  echo "------------------------------------------------------------"
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "Mode C dry-run complete. No changes were made."
  else
    echo "Mode C install complete."
    echo "Verification:"
    echo "  ls \"\${OBSIDIAN_VAULT}/session-logs/\""
    echo "  (start a Claude Code / Codex / Gemini session, then re-check)"
  fi
  echo "------------------------------------------------------------"
  return 0
}

# 個別 step の実行 (script ごとに引数が違うので case で分岐)
mode_c_dispatch_one() {
  local name="$1"
  local path="$2"
  local args=()

  case "${name}" in
    setup-vault)
      # setup-vault.sh は KIOKU_DRY_RUN 環境変数で dry-run、引数なし
      if [[ "${DRY_RUN}" == "1" ]]; then
        KIOKU_DRY_RUN=1 bash "${path}"
      else
        bash "${path}"
      fi
      ;;
    install-hooks|install-hooks-codex|install-hooks-gemini)
      # install-hooks*.sh は --apply で merge、無しなら stdout 出力 (= 事実上の dry-run)
      if [[ "${DRY_RUN}" == "1" ]]; then
        # 無引数で stdout 出力のみ (破壊しない)
        bash "${path}" >/dev/null
      else
        if [[ "${ASSUME_YES}" == "1" ]]; then
          bash "${path}" --apply --yes
        else
          bash "${path}" --apply
        fi
      fi
      ;;
    install-skills)
      # install-skills.sh は --dry-run support あり
      if [[ "${DRY_RUN}" == "1" ]]; then
        bash "${path}" --dry-run
      else
        bash "${path}"
      fi
      ;;
    *)
      echo "ERROR: unknown step name: ${name}" >&2
      return 1
      ;;
  esac
}

# -----------------------------------------------------------------------------
# 失敗時 rollback (Mode C で途中 fail した場合のユーザー案内)
# -----------------------------------------------------------------------------
ROLLBACK_HINT_SHOWN=0
on_error() {
  local rc=$?
  if [[ "${ROLLBACK_HINT_SHOWN}" == "1" ]]; then
    exit "${rc}"
  fi
  ROLLBACK_HINT_SHOWN=1
  cat >&2 <<EOF

------------------------------------------------------------
install.sh failed (exit ${rc})
------------------------------------------------------------
Rollback hints:
  - ~/.claude/settings.json: install-hooks.sh が timestamp 付き backup を残します
    (~/.claude/settings.json.bak.YYYYMMDD-HHMMSS)。手動で復元可能です:
      mv ~/.claude/settings.json.bak.* ~/.claude/settings.json
  - clone 先 (${KIOKU_INSTALL_DIR:-${HOME}/.kioku/kioku}) は失敗時もそのまま残ります。
    削除する場合は:
      rm -rf "${KIOKU_INSTALL_DIR:-${HOME}/.kioku/kioku}"
  - Vault (\${OBSIDIAN_VAULT}) は setup-vault.sh が冪等なので再実行可能です。

問題が続く場合は以下に issue を作成してください:
  https://github.com/megaphone-tokyo/kioku/issues
------------------------------------------------------------
EOF
  exit "${rc}"
}

trap on_error ERR

# -----------------------------------------------------------------------------
# Main dispatch
# -----------------------------------------------------------------------------
case "${EFFECTIVE_MODE}" in
  a)
    mode_a_print_instructions
    if [[ "${DRY_RUN}" == "1" ]]; then
      echo "[dry-run] Mode A is print-only, no side-effects to dry-run."
    fi
    exit 0
    ;;
  c)
    if ! mode_c_check_vault; then
      exit 1
    fi
    if ! mode_c_resolve_repo; then
      exit 3
    fi
    if ! mode_c_dispatch; then
      exit 2
    fi
    exit 0
    ;;
  *)
    echo "ERROR: invalid effective mode: ${EFFECTIVE_MODE}" >&2
    exit 1
    ;;
esac
