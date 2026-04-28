#!/usr/bin/env bash
#
# tests/install-hooks-gemini.test.sh — v0.7.0 Q2 Gemini install-hooks test
#
# Test prefix: IH-GEMINI-*
#
# 実 Gemini CLI 環境は sandbox 制約のため不可。代わりに fixture-based simulated E2E
# (PM pre-approved MF2 fallback): --apply で生成される ~/.gemini/settings.json の
# JSON shape を直接 verify する。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALLER="${REPO_ROOT}/scripts/install-hooks-gemini.sh"
ADAPTER="${REPO_ROOT}/hooks/adapters/gemini.mjs"

fail_count=0
fail() { echo "FAIL: $*" >&2 ; fail_count=$((fail_count + 1)); }
ok() { echo "OK: $*"; }

# Setup
TMPDIR_SAFE="$(mktemp -d)"
trap 'rm -rf "${TMPDIR_SAFE}"' EXIT
export OBSIDIAN_VAULT="${TMPDIR_SAFE}/vault"
mkdir -p "${OBSIDIAN_VAULT}"
export GEMINI_SETTINGS_FILE="${TMPDIR_SAFE}/.gemini/settings.json"

# -----------------------------------------------------------------------------
# IH-GEMINI-1: stdout (default、non-destructive) mode 出力が valid JSON を含む
# -----------------------------------------------------------------------------
snippet_out="$(bash "${INSTALLER}" 2>/dev/null)"
json_part="$(echo "${snippet_out}" | awk '/^{/,/^}$/')"
if echo "${json_part}" | jq -e . >/dev/null 2>&1; then
  ok "IH-GEMINI-1: stdout snippet contains valid JSON"
else
  fail "IH-GEMINI-1: stdout snippet is not valid JSON"
fi

# -----------------------------------------------------------------------------
# IH-GEMINI-2: --apply でファイル生成 + 全 event key 存在
# -----------------------------------------------------------------------------
bash "${INSTALLER}" --apply --yes >/dev/null 2>&1
if [[ ! -f "${GEMINI_SETTINGS_FILE}" ]]; then
  fail "IH-GEMINI-2: --apply did not create settings.json"
else
  for key in BeforeAgent AfterAgent AfterTool SessionStart SessionEnd; do
    if jq -e ".hooks[\"${key}\"]" "${GEMINI_SETTINGS_FILE}" >/dev/null 2>&1; then
      ok "IH-GEMINI-2: event key '${key}' present"
    else
      fail "IH-GEMINI-2: event key '${key}' missing"
    fi
  done
fi

# -----------------------------------------------------------------------------
# IH-GEMINI-3: --apply 2 回で idempotent (重複しない)
# -----------------------------------------------------------------------------
bash "${INSTALLER}" --apply --yes >/dev/null 2>&1
bash "${INSTALLER}" --apply --yes >/dev/null 2>&1
before_count=$(jq '.hooks.BeforeAgent | length' "${GEMINI_SETTINGS_FILE}")
if [[ "${before_count}" == "1" ]]; then
  ok "IH-GEMINI-3: idempotent merge (BeforeAgent has 1 entry after 2 runs)"
else
  fail "IH-GEMINI-3: BeforeAgent has ${before_count} entries (expected 1)"
fi

# -----------------------------------------------------------------------------
# IH-GEMINI-3-SF-A (PR #56 review): --apply 3 回目でも全 event key が 1 entry
# matcher-wrapped (SessionStart) / non-matcher (BeforeAgent etc.) 両形態 pass
# -----------------------------------------------------------------------------
bash "${INSTALLER}" --apply --yes >/dev/null 2>&1
for key in SessionStart BeforeAgent AfterAgent AfterTool SessionEnd; do
  cnt=$(jq ".hooks.${key} | length" "${GEMINI_SETTINGS_FILE}")
  if [[ "${cnt}" == "1" ]]; then
    ok "IH-GEMINI-3-SF-A: ${key} has 1 entry after 3 --apply runs (dedup works for matcher-wrapped + non-matcher)"
  else
    fail "IH-GEMINI-3-SF-A: ${key} has ${cnt} entries (expected 1) — dedup broken?"
  fi
done

# -----------------------------------------------------------------------------
# IH-GEMINI-4: AfterTool matcher は snake_case (run_shell_command|replace|write_file)
# -----------------------------------------------------------------------------
matcher="$(jq -r '.hooks.AfterTool[0].matcher' "${GEMINI_SETTINGS_FILE}")"
if [[ "${matcher}" == *"run_shell_command"* && "${matcher}" == *"replace"* && "${matcher}" == *"write_file"* ]]; then
  ok "IH-GEMINI-4: AfterTool matcher uses Gemini snake_case tool names"
else
  fail "IH-GEMINI-4: AfterTool matcher unexpected: ${matcher}"
fi

# -----------------------------------------------------------------------------
# IH-GEMINI-5: SessionEnd は 2 段 hook (adapter → git-sync shell、Claude と同形式)
# -----------------------------------------------------------------------------
session_end_count="$(jq '.hooks.SessionEnd[0].hooks | length' "${GEMINI_SETTINGS_FILE}")"
if [[ "${session_end_count}" == "2" ]]; then
  ok "IH-GEMINI-5: SessionEnd has 2-stage hook (adapter + git-sync)"
else
  fail "IH-GEMINI-5: SessionEnd has ${session_end_count} hooks (expected 2)"
fi

# git add pattern が Claude install-hooks.sh と byte-identical (LEARN#9 single source of truth)
git_sync_cmd="$(jq -r '.hooks.SessionEnd[0].hooks[1].command' "${GEMINI_SETTINGS_FILE}")"
if [[ "${git_sync_cmd}" == *"git add wiki/ raw-sources/ templates/ CLAUDE.md"* ]]; then
  ok "IH-GEMINI-5: git-sync command matches install-hooks.sh Claude SessionEnd (single source of truth)"
else
  fail "IH-GEMINI-5: git-sync command diverged from Claude version"
fi

# -----------------------------------------------------------------------------
# IH-GEMINI-6: adapter path が gemini.mjs を指していること (session-logger.mjs ではない)
# -----------------------------------------------------------------------------
adapter_cmd="$(jq -r '.hooks.BeforeAgent[0].hooks[0].command' "${GEMINI_SETTINGS_FILE}")"
if [[ "${adapter_cmd}" == *"hooks/adapters/gemini.mjs"* ]]; then
  ok "IH-GEMINI-6: BeforeAgent command references adapters/gemini.mjs"
else
  fail "IH-GEMINI-6: BeforeAgent command: ${adapter_cmd}"
fi

# -----------------------------------------------------------------------------
# IH-GEMINI-7: hookSpecificOutput / systemMessage は registration 側で使わない
# (adapter 実行時に stdout で emit する方式、register 時は command のみ)
# -----------------------------------------------------------------------------
has_reg_systemMsg="$(jq '.hooks | [.. | objects | select(has("systemMessage"))] | length' "${GEMINI_SETTINGS_FILE}")"
if [[ "${has_reg_systemMsg}" == "0" ]]; then
  ok "IH-GEMINI-7: no systemMessage keys in config (adapter-runtime emission only)"
else
  fail "IH-GEMINI-7: unexpected systemMessage keys: ${has_reg_systemMsg}"
fi

# -----------------------------------------------------------------------------
# 結果
# -----------------------------------------------------------------------------
if [[ ${fail_count} -gt 0 ]]; then
  echo "IH-GEMINI: FAILED (${fail_count} issue(s))" >&2
  exit 1
fi
echo "IH-GEMINI: all checks passed"
