#!/usr/bin/env bash
#
# setup-multi-agent.sh — claude-brain の skills/ を Claude Code 以外の AI agent にも symlink で配置
#
# Claude Code 用は `install-skills.sh` ($HOME/.claude/skills/ 以下に per-skill symlink) を使う。
# 本 script は **それ以外の agent** (Codex CLI / OpenCode / Gemini CLI) 向けに、
# `skills/` ディレクトリ全体を `<agent-root>/skills/kioku/` として symlink する。
#
# Agent の slash command / skill 認識経路:
#   Codex CLI        : ~/.codex/skills/kioku       (per https://github.com/openai/codex)
#   OpenCode         : ~/.opencode/skills/kioku    (per opencode.ai)
#   Gemini CLI       : ~/.gemini/skills/kioku      (per https://github.com/google-gemini/gemini-cli)
#
# Usage:
#   bash setup-multi-agent.sh                    # 冪等に全 agent に symlink
#   bash setup-multi-agent.sh --agent codex      # 特定 agent のみ
#   bash setup-multi-agent.sh --dry-run          # 実行予定のみ表示、書き込みなし
#   bash setup-multi-agent.sh --uninstall        # 全 agent の symlink を削除
#
# Exit codes:
#   0  正常終了 (全 agent 処理完了、warned を含む)
#   1  fatal error (skills/ 不在、unknown argument, etc.)
#
# 環境変数 (テスト用 override):
#   KIOKU_CODEX_SKILLS_DIR    — default: $HOME/.codex/skills
#   KIOKU_OPENCODE_SKILLS_DIR — default: $HOME/.opencode/skills
#   KIOKU_GEMINI_SKILLS_DIR   — default: $HOME/.gemini/skills
#
# 参考:
#   - plan/claude/26042303 §Phase C Task C-1
#   - competitors/claude-obsidian/bin/setup-multi-agent.sh (実装パターン元ネタ)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_SRC_DIR="$(cd "${SCRIPT_DIR}/../skills" && pwd)"

# 対象 agent 定義 (name|default_dir の配列)
# 新 agent 追加時はここを増やす
AGENTS=(
  "codex|${KIOKU_CODEX_SKILLS_DIR:-${HOME}/.codex/skills}"
  "opencode|${KIOKU_OPENCODE_SKILLS_DIR:-${HOME}/.opencode/skills}"
  "gemini|${KIOKU_GEMINI_SKILLS_DIR:-${HOME}/.gemini/skills}"
)

DRY_RUN=0
UNINSTALL=0
TARGET_AGENT=""

for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY_RUN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --agent=*) TARGET_AGENT="${arg#--agent=}" ;;
    --agent)
      echo "ERROR: --agent requires a value (e.g. --agent=codex)" >&2
      exit 1
      ;;
    -h|--help)
      sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: ${arg}" >&2
      exit 1
      ;;
  esac
done

if [[ ! -d "${SKILLS_SRC_DIR}" ]]; then
  echo "ERROR: skills source directory not found: ${SKILLS_SRC_DIR}" >&2
  exit 1
fi

# symlink 名 = kioku (固定)
LINK_NAME="kioku"

echo "setup-multi-agent: source = ${SKILLS_SRC_DIR}"
echo "setup-multi-agent: link name = ${LINK_NAME}"
if [[ -n "${TARGET_AGENT}" ]]; then
  echo "setup-multi-agent: target agent = ${TARGET_AGENT}"
fi
if [[ ${UNINSTALL} -eq 1 ]]; then
  echo "setup-multi-agent: mode = UNINSTALL"
elif [[ ${DRY_RUN} -eq 1 ]]; then
  echo "setup-multi-agent: mode = DRY RUN"
fi
echo

CREATED=0
SKIPPED=0
REPLACED=0
REMOVED=0
WARNED=0

for entry in "${AGENTS[@]}"; do
  agent_name="${entry%%|*}"
  dest_dir="${entry#*|}"
  dest_link="${dest_dir}/${LINK_NAME}"

  # --agent フィルタ
  if [[ -n "${TARGET_AGENT}" && "${TARGET_AGENT}" != "${agent_name}" ]]; then
    continue
  fi

  # UNINSTALL モード
  if [[ ${UNINSTALL} -eq 1 ]]; then
    if [[ -L "${dest_link}" ]]; then
      current_target="$(readlink "${dest_link}")"
      if [[ "${current_target}" == "${SKILLS_SRC_DIR}" ]]; then
        echo "  [remove]  ${agent_name}: ${dest_link}"
        if [[ ${DRY_RUN} -eq 0 ]]; then
          rm "${dest_link}"
        fi
        REMOVED=$((REMOVED + 1))
      else
        echo "  [skip]    ${agent_name}: symlink points elsewhere (${current_target}), not touching" >&2
        WARNED=$((WARNED + 1))
      fi
    else
      echo "  [skip]    ${agent_name}: no symlink at ${dest_link}"
      SKIPPED=$((SKIPPED + 1))
    fi
    continue
  fi

  # INSTALL モード
  # 宛先ディレクトリの親を作成
  if [[ ${DRY_RUN} -eq 0 ]]; then
    mkdir -p "${dest_dir}"
  fi

  if [[ -L "${dest_link}" ]]; then
    current_target="$(readlink "${dest_link}")"
    if [[ "${current_target}" == "${SKILLS_SRC_DIR}" ]]; then
      echo "  [skip]    ${agent_name}: already linked (${dest_link})"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi
    echo "  [WARN]    ${agent_name}: symlink exists but points elsewhere (${current_target}), skipping" >&2
    echo "            remove manually to relink: rm '${dest_link}'" >&2
    WARNED=$((WARNED + 1))
    continue
  fi

  if [[ -e "${dest_link}" ]]; then
    echo "  [WARN]    ${agent_name}: ${dest_link} exists and is not a symlink, skipping" >&2
    WARNED=$((WARNED + 1))
    continue
  fi

  echo "  [create]  ${agent_name}: ${dest_link} -> ${SKILLS_SRC_DIR}"
  if [[ ${DRY_RUN} -eq 0 ]]; then
    ln -s "${SKILLS_SRC_DIR}" "${dest_link}"
  fi
  CREATED=$((CREATED + 1))
done

echo
if [[ ${UNINSTALL} -eq 1 ]]; then
  echo "setup-multi-agent: removed=${REMOVED} skipped=${SKIPPED} warned=${WARNED}"
else
  echo "setup-multi-agent: created=${CREATED} replaced=${REPLACED} skipped=${SKIPPED} warned=${WARNED}"
fi

# verify のヒント
if [[ ${UNINSTALL} -eq 0 && ${DRY_RUN} -eq 0 && ${CREATED} -gt 0 ]]; then
  echo
  echo "次の verify 手順:"
  echo "  - Codex CLI:  codex --list-skills 2>/dev/null | grep -i kioku"
  echo "  - Gemini CLI: gemini --list-skills 2>/dev/null | grep -i kioku"
  echo "  - OpenCode:   ls ~/.opencode/skills/kioku/"
fi
